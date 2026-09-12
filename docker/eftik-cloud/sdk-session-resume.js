/**
 * cordis 外挂插件 · SDK profile 会话 resume 补丁（零 dsh 内核文件改动）
 *
 * 背景：SDK profile 的 `HarnessSdkJsonRpcServer.createSession(sessionId)` 只调
 * `ctx.agents.create({sessionId})`，**没有 resume 分支**。而 dsh 内核有磁盘会话
 * 持久化（`dsh-session-persistence-jsonl`），新进程启动时会把磁盘会话恢复进内存
 * store —— 于是第二次用同一 sessionId 时：
 *
 *   create(同 id) → SessionStore.prepare(id)
 *                → if (this.store.has(sessionId)) throw `session "..." already exists`
 *
 * 对照：Web profile 用的 `@deepseek-ai/dsh-api-session-controller` 有正确的三步判定
 * （`createOrAdopt`：内存 live → 磁盘 observeSession + agents.resume → create），
 * 所以 Web 端可以随意切换会话、续聊、回看。
 *
 * 本插件把 Web 端那套语义补到 SDK profile 上，做法是**替换原型方法**：
 * 不碰内核任何文件，随 dsh 升级摘除即可（升级后若上游修好 resume，删掉本插件即回归官方实现）。
 *
 * 依赖的 API 面（均为公共契约）：
 *   - `@deepseek-ai/dsh-sdk-jsonrpc-server` 的具名导出 `HarnessSdkJsonRpcServer`
 *   - `ctx.agents`：`get(id)` / `create(options)` / `resume(options)`
 *   - `ctx.sessionQuery.observeSession(sessionId)`：冷会话观测（Web 端同款）
 */

const RESUME_PATCHED = Symbol.for("eftik.sdkSessionResumePatched");

/**
 * 解析并加载 `@deepseek-ai/dsh-sdk-jsonrpc-server`。
 *
 * 本插件经 --patch 以 `file:///opt/gw/xxx.js` 注入，`require` 的解析起点是
 * `/opt/gw/`，那里没有 node_modules —— 必须显式带上 dsh 的模块目录。
 * 该路径是 dsh 官方 npm 全局安装的稳定布局（容器内 DSH_VERSION 变化不影响）。
 */
function loadSdkServerModule(log) {
  const candidates = [
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
    "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules",
  ];
  for (const base of candidates) {
    try {
      const p = require.resolve("@deepseek-ai/dsh-sdk-jsonrpc-server", { paths: [base] });
      return require(p);
    } catch (error) {
      log(`解析失败 ${base}: ${error && error.message}`);
    }
  }
  return null;
}

/** 判断错误是否表示「会话在磁盘上不存在」（即需要走 create） */
function isSessionNotFound(error) {
  if (!error) return false;
  // dsh-session-query 用 SessionQueryError + code 表达；
  // 不同版本可能包装成 cause，逐层剥开判断。
  const seen = new Set();
  let e = error;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    if (e.code === "SESSION_QUERY_SESSION_NOT_FOUND") return true;
    if (typeof e.message === "string" && /session .* not found|no such session/i.test(e.message)) return true;
    e = e.cause;
  }
  return false;
}

module.exports = {
  name: "eftik-sdk-session-resume",
  // 与官方 sdk server 同样的注入面：需要 agents 服务
  inject: ["agents"],
  apply(ctx, config) {
    const log = (msg) => {
      // stdout 被 JSON-RPC 协议帧独占，日志一律走 stderr
      try { process.stderr.write(`[eftik-session-resume] ${msg}\n`); } catch {}
    };

    const mod = loadSdkServerModule(log);
    const ServerClass = mod && mod.HarnessSdkJsonRpcServer;
    if (!ServerClass || !ServerClass.prototype) {
      log("未能加载 HarnessSdkJsonRpcServer，插件跳过（对话将退回官方语义）");
      return;
    }
    if (ServerClass.prototype[RESUME_PATCHED]) {
      log("已打过补丁，跳过");
      return;
    }
    const original = ServerClass.prototype.createSession;
    if (typeof original !== "function") {
      log("createSession 不是函数（上游可能已改动），插件跳过");
      return;
    }

    /**
     * 替换后的 createSession：先尝试 resume（有磁盘会话时），否则 create。
     * 语义与 @deepseek-ai/dsh-api-session-controller 的 createOrAdopt 对齐。
     */
    ServerClass.prototype.createSession = async function patchedCreateSession(sessionId) {
      const self = this;
      // ① 内存里已有 live agent —— 官方 getOrCreateSession 已挡一层，这里做兜底
      const live = self.ctx.agents.get(sessionId);
      if (live !== undefined) {
        const rec = { handle: live };
        self.sessions.set(sessionId, rec);
        return rec;
      }

      // ② 尝试从磁盘恢复（resume）。只有确认「磁盘不存在」才往下走 create。
      const sessionQuery = self.ctx.get ? self.ctx.get("sessionQuery") : undefined;
      if (sessionQuery && typeof sessionQuery.observeSession === "function") {
        try {
          const observation = await sessionQuery.observeSession(sessionId);
          const header = observation && observation.header;
          // cwd 必须一致，否则会话归属不同项目目录，不能复用
          if (header && header.cwd !== undefined && header.cwd !== self.cwd) {
            throw new Error(
              `session "${sessionId}" belongs to "${header.cwd}", not "${self.cwd}"`
            );
          }
          const resumed = await self.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: {
              provider: self.provider,
              model: self.model,
              ...(self.reasoningEffort === undefined ? {} : { reasoningEffort: self.reasoningEffort }),
              ...(self.maxTokens === undefined ? {} : { maxTokens: self.maxTokens }),
            },
          });
          log(`resume 成功: ${sessionId}`);
          const rec = { handle: resumed };
          self.sessions.set(sessionId, rec);
          return rec;
        } catch (error) {
          if (!isSessionNotFound(error)) {
            // 真错误（cwd 冲突 / 持久化损坏等）：向上抛，不要静默降级成 create，
            // 否则会出现「同一 id 两个会话」的隐蔽数据问题。
            throw error;
          }
          log(`磁盘无会话，走 create: ${sessionId}`);
        }
      } else {
        log("sessionQuery 不可用，跳过 resume 探测");
      }

      // ③ 磁盘也没有 —— 与官方实现一致，新建
      const created = await self.ctx.agents.create({
        sessionId,
        meta: { cwd: self.cwd },
        agentOptions: {
          provider: self.provider,
          model: self.model,
          ...(self.reasoningEffort === undefined ? {} : { reasoningEffort: self.reasoningEffort }),
          ...(self.maxTokens === undefined ? {} : { maxTokens: self.maxTokens }),
        },
      });
      const rec = { handle: created };
      self.sessions.set(sessionId, rec);
      return rec;
    };

    ServerClass.prototype[RESUME_PATCHED] = true;
    log("已接管 createSession（resume 优先，create 兜底）");
  },
};
