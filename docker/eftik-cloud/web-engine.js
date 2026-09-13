/**
 * web-engine.js —— 平面 B（Typert Remote）执行引擎
 *
 * 背景：DSH 内核有两套互不相通的 RPC 平面。网关原来走「平面 A：SDK JSON-RPC（stdio）」，
 * 只有 initialize / session/prompt / shutdown 三个方法，因此「取消、审批、提问、模型清单、
 * agent 预设」全部要自己写 profile 插件补。平面 B（`dsh web` 的 Typert Remote）原生就有这些。
 *
 * 本模块把网关的执行面整体切到平面 B，**对外 HTTP 接口一字不改**：
 * 仍然产出同一个 job 对象（复用 gateway.js 的 pushAnswer / pushThinking /
 * markJobFinished / streamTask），所以 /chat、/task、/task/{id}/stream、SSE 全都不用动。
 *
 * 已实测（2026-09-13，镜像 0.6.23 + 真实 Key）：会话创建 / 原生打字机流 / 取消
 * （turn/end reason={"kind":"aborted","reason":{"kind":"user"}}）/ 审批 waterfall 收与答
 * （approval/decided 确认 allowed-once 且沙箱真的抬升）/ modelCatalog / agentPresets 全部可用。
 *
 * ⚠️ 三条硬约束（改这个文件前务必先读）：
 *  1. 这是**内部协议**，无公开文档，只能对着 packages/ 源码读。升级内核时要回归。
 *  2. **绝不能与 SDK 平面混用同一会话** —— 两个进程争 session.lock 就是历史上
 *     `already exists` / `already owned` 那对 bug 的根因。切就整体切。
 *  3. `dsh web` 进程由**本引擎独占**（web-ui.js 不再自己起），否则两个进程共享 DSH_HOME
 *     同样会争锁。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* ---------- 协议常量（易变的坑都集中在这里） ---------- */

const MUX_PATH = "/api/remote.mux";
const EVENTS_ENDPOINT = "$events";
const EVENTS_RESULT_ENDPOINT = "$events/result";
const FOLLOW_ENDPOINT = "session/follow";

/** 内核会话 id 映射表：网关自己的会话 id → 内核 sessionId */
const DEFAULT_KERNEL_MAP_PATH = "/home/node/.dsh/eftik-kernel-sessions.json";

/** 审批结果闭集（内核只认这四个，多一个字都会被归一成 unavailable） */
const APPROVAL_OUTCOMES = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);

function createWebEngine(cfg) {
  const port = Number(cfg.port || 3080);
  const workdir = cfg.workdir || "/workspace";
  const tokenPath = cfg.tokenPath || "/home/node/.dsh/eftik-web-token";
  const pluginReloadPath = cfg.pluginReloadPath || "";
  const kernelMapPath = cfg.kernelMapPath || DEFAULT_KERNEL_MAP_PATH;
  const log = cfg.log || (() => {});
  const hooks = cfg.hooks || {};

  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${MUX_PATH}`;

  let child = null;
  let token = "";
  let cookie = "";
  let ws = null;
  let wsReady = false;
  let clientId = "";
  let stopping = false;
  let restartTimer = null;

  const streams = new Map();      // streamId → { endpoint, onItem, onError, onEnd }
  let wsSeq = 0;
  let rpcSeq = 0;
  let kernelMap = {};

  /**
   * 钩子一律包一层：钩子是网关传进来的，一旦它抛异常而异常又冒到 WS 事件回调里，
   * 会直接把整个网关进程干掉（实测踩过：一个参数写错的 pushLog 把网关搞挂，
   * 容器随之退出、在跑的任务全丢）。宁可丢一条日志，也不能丢进程。
   */
  function safe(fn) {
    try { return fn(); } catch (e) { log(`[web-engine] 钩子异常（已忽略）: ${e && e.message}`); return undefined; }
  }

  function loadKernelMap() {
    try { kernelMap = JSON.parse(fs.readFileSync(kernelMapPath, "utf8")) || {}; } catch { kernelMap = {}; }
  }
  function saveKernelMap() {
    try {
      fs.mkdirSync(path.dirname(kernelMapPath), { recursive: true });
      fs.writeFileSync(kernelMapPath, JSON.stringify(kernelMap, null, 2));
    } catch (e) { log(`[web-engine] 写内核会话映射失败: ${e.message}`); }
  }

  /* ---------- dsh web 进程（本引擎独占） ---------- */

  function startProcess() {
    if (stopping) return;
    token = "";
    cookie = "";
    const args = ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];
    log(`[web-engine] 启动 dsh web :${port}`);
    child = spawn("dsh", args, { cwd: workdir, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        const m = text.match(/[?&]token=([^\s&]+)/);
        if (m && m[1] !== token) {
          token = m[1];
          try { fs.writeFileSync(tokenPath, token); } catch (e) { log(`[web-engine] 写 token 文件失败: ${e.message}`); }
          log("[web-engine] 拿到 launch token，开始连接");
          connect().catch((e) => log(`[web-engine] 连接失败: ${e.message}`));
        }
      });
    }
    child.on("error", (e) => log(`[web-engine] spawn 失败: ${e.message}`));
    child.on("exit", (code) => {
      log(`[web-engine] dsh web 退出 ${code}${stopping ? "" : "，2s 后重启"}`);
      child = null;
      wsReady = false;
      clientId = "";
      try { if (ws) ws.close(); } catch {}
      ws = null;
      if (!stopping) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(startProcess, 2000);
      }
    });
  }

  /** 插件档案变更时重启（原来在 web-ui.js 里，现在进程归我们管） */
  function watchPluginReload() {
    if (!pluginReloadPath) return;
    fs.watchFile(pluginReloadPath, { interval: 1000 }, (cur, prev) => {
      if (stopping || !child || cur.mtimeMs === prev.mtimeMs) return;
      log("[web-engine] 插件档案变更，重启 dsh web");
      try { child.kill("SIGTERM"); } catch {}
    });
  }

  /* ---------- WS 多路复用 ---------- */

  async function connect() {
    // 用 token 换 dsh-auth-* cookie（浏览器就是走这一步）
    const r = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    const sc = typeof r.headers.getSetCookie === "function"
      ? r.headers.getSetCookie()
      : [r.headers.get("set-cookie")].filter(Boolean);
    cookie = sc.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`token 换 cookie 失败（HTTP ${r.status}）`);

    // Node 内置 WebSocket 支持 headers（undici 扩展），不需要 ws 包
    ws = new WebSocket(wsUrl, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS 连接超时")), 15000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS 连接错误")); });
    });
    ws.addEventListener("message", onWsMessage);
    ws.addEventListener("close", () => {
      wsReady = false;
      clientId = "";
      log("[web-engine] WS 断开");
      if (!stopping) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (!stopping) startProcess(); }, 3000);
      }
    });
    openStream(EVENTS_ENDPOINT, {}, { onItem: onEventItem });
  }

  function onWsMessage(ev) {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
    if (m.type === "error") {
      const h = streams.get(m.streamId);
      log(`[web-engine] 流 ${h ? h.endpoint : m.streamId} 错误: ${JSON.stringify(m.error)}`);
      if (h && h.onError) safe(() => h.onError(m.error));
      return;
    }
    if (m.type === "end") {
      const h = streams.get(m.streamId);
      streams.delete(m.streamId);
      if (h && h.onEnd) safe(() => h.onEnd());
      return;
    }
    if (m.type !== "item") return;
    const h = streams.get(m.streamId);
    if (h && h.onItem) safe(() => h.onItem(m.value));
  }

  function openStream(endpoint, args, handlers) {
    if (!ws) throw new Error("WS 未连接");
    const streamId = `gw-${++wsSeq}`;
    streams.set(streamId, { endpoint, ...handlers });
    ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return streamId;
  }

  function closeStream(streamId) {
    if (!streamId) return;
    streams.delete(streamId);
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "cancel", streamId })); } catch {}
  }

  /* ---------- 一元 RPC ---------- */

  /**
   * @param endpoint 形如 `session/create`；scoped 形如 `agent:commands/execute`
   * @param args     注意：**可选参数在 wire 上带下划线前缀**（session/list 要 `{_request:{}}`）
   */
  async function call(endpoint, args) {
    const rpcId = `gw-${++rpcSeq}`;
    const res = await fetch(`${base}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args: args || {} } }),
    });
    if (!res.ok) throw new Error(`${endpoint} 传输失败 HTTP ${res.status}`);
    const parsed = await res.json();
    const result = parsed && parsed.result;
    if (!result) throw new Error(`${endpoint} 响应格式非法`);
    if (result.ok) return result.value;
    const err = result.error || {};
    const e = new Error(err.message || `${endpoint} 失败`);
    e.code = err.code;
    e.details = err.details;
    throw e;
  }

  /* ---------- 会话 ---------- */

  function kernelIdOf(sessionId) {
    if (!sessionId) return null;
    return kernelMap[sessionId] || null;
  }

  /** 拿到（必要时创建）内核会话；网关自己的会话 id 与内核 id 的映射落在 json 里 */
  async function ensureKernelSession(sessionId, opts) {
    const hit = kernelIdOf(sessionId);
    if (hit) return hit;
    const args = { request: { cwd: workdir } };
    if (opts && opts.agentPreset) args.request.agentPreset = opts.agentPreset;
    // 先尝试沿用我们自己的 id（省掉映射），失败则采纳内核给的 id
    if (sessionId) args.request.sessionId = sessionId;
    let created;
    try {
      created = await call("session/create", args);
    } catch (e) {
      if (!args.request.sessionId) throw e;
      delete args.request.sessionId;
      created = await call("session/create", args);
    }
    const kernelId = created.sessionId || created.id;
    if (sessionId) { kernelMap[sessionId] = kernelId; saveKernelMap(); }
    log(`[web-engine] 新建内核会话 ${kernelId}（preset=${created.agentPreset || "-"}）`);
    return kernelId;
  }

  /**
   * 把网关的工作台级设置下发到这一轮会话上。
   * 平面 B 全是**会话级**能力，比平面 A 的「只能 initialize + env」强得多。
   * 三个旋钮的调用形式都是实测出来的（注意 scoped `agent:` 前缀在 HTTP 载体上是 404）：
   *   模型   session/selectModel  { request: { sessionId, provider, model, reasoningEffort? } }
   *   权限   commands/execute     { agentId, line: '/permission <preset>', submittedAttachments: [] }
   *   预设   agentPresets/select  { agentId, agentPreset }
   * @param job 当前任务（只为把失败原因写进它的日志，不参与控制流）
   */
  async function applySettings(kernelId, settings, job) {
    if (!settings) return;
    const warn = (m) => { log(`[web-engine] ${m}`); if (job && hooks.pushLog) safe(() => hooks.pushLog(job, m)); };

    if (settings.model || settings.provider) {
      try {
        const sel = { sessionId: kernelId, provider: settings.provider || "deepseek-official", model: settings.model || "deepseek-chat" };
        if (settings.reasoning && settings.reasoning !== "off") sel.reasoningEffort = settings.reasoning;
        await call("session/selectModel", { request: sel });
        log(`[web-engine] 已选模型 ${sel.provider}/${sel.model}${sel.reasoningEffort ? " effort=" + sel.reasoningEffort : ""}`);
      } catch (e) {
        // 选模型失败不该让整轮挂掉：回退到内核默认模型，并把原因记进日志
        warn(`模型切换失败，已回退默认：${e.message}`);
      }
    }

    // 权限档：平面 B 下必须走 /permission 命令（原来靠每轮子进程的 env，切引擎后那条路没了）
    if (settings.permissionMode) {
      try {
        await call("commands/execute", {
          agentId: kernelId,
          line: `/permission ${settings.permissionMode}`,
          submittedAttachments: [],
        });
        log(`[web-engine] 已设权限档 ${settings.permissionMode}`);
      } catch (e) {
        warn(`权限档切换失败（沿用容器默认）：${e.message}`);
      }
    }

    if (settings.agentPreset) {
      try {
        await call("agentPresets/select", { agentId: kernelId, agentPreset: settings.agentPreset });
        log(`[web-engine] 已设 agent 预设 ${settings.agentPreset}`);
      } catch (e) {
        warn(`agent 预设切换失败（沿用默认 standard）：${e.message}`);
      }
    }
  }

  /**
   * 读一个会话的当前能力快照：可用预设 / 可用模型 / 权限档（含当前值）。
   * 权限档只能从 session/follow 首帧的 projections 里拿，所以这里开一条流只读首帧就关掉。
   */
  async function sessionOptions(kernelId) {
    const out = { permissions: null, presets: null, models: null };
    try {
      const roster = await call("agentPresets/list", {});
      out.presets = (roster && roster.presets) || [];
    } catch (e) { log(`[web-engine] 读 agent 预设失败: ${e.message}`); }
    try {
      const cat = await call("session/modelCatalog", {});
      out.models = cat || null;
    } catch (e) { log(`[web-engine] 读模型目录失败: ${e.message}`); }
    if (kernelId) {
      try { out.permissions = await readPermissions(kernelId); }
      catch (e) { log(`[web-engine] 读权限档失败: ${e.message}`); }
    }
    return out;
  }

  /** 开一条 follow 只取首帧 snapshot 里的 permissions projection */
  function readPermissions(kernelId) {
    return new Promise((resolve, reject) => {
      if (!ws) return reject(new Error("WS 未连接"));
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); closeStream(sid); fn(v); };
      const timer = setTimeout(() => finish(reject, new Error("读权限档超时")), 6000);
      const sid = openStream(FOLLOW_ENDPOINT, {
        request: { address: { kind: "session", sessionId: kernelId } },
      }, {
        onItem: (v) => {
          if (!v || v.type !== "snapshot") return;
          const vals = (v.projections && v.projections.values) || {};
          finish(resolve, vals.permissions || null);
        },
        onError: (e) => finish(reject, new Error((e && e.message) || "读权限档失败")),
      });
    });
  }

  /** 拿一个可用的内核会话（优先复用已有）—— 读能力快照（如权限档）时需要 */
  async function anyKernelSession() {
    const ids = Object.values(kernelMap);
    if (ids.length) return ids[ids.length - 1];
    return ensureKernelSession("");
  }

  /* ---------- 一回合 ---------- */

  /**
   * 跑一回合。失败一律抛出，由调用方统一收敛成 job 终态。
   * @returns {Promise<{reply:string, usage:object|null}>}
   */
  function runTurn(job) {
    return new Promise((resolve, reject) => {
      const kernelId = job.kernelId;
      let reply = "";
      let reasoning = "";
      let followStream = null;
      let settled = false;
      let timer = null;

      const finish = (status, err, errorCode, errorDetail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeStream(followStream);
        job.pendingInteractions = job.pendingInteractions || new Map();
        for (const [, p] of job.pendingInteractions) {
          try { p.autoclose && p.autoclose(status); } catch {}
        }
        job.pendingInteractions.clear();
        if (hooks.finish) safe(() => hooks.finish(job, status, err, errorCode, errorDetail));
        if (status === "done") resolve({ reply, usage: job.usage || null });
        else { const e = new Error(err || "任务失败"); e.errorCode = errorCode; reject(e); }
      };
      job.finishTurn = finish;   // 供取消路径调用

      timer = setTimeout(() => {
        log(`[web-engine] 任务 ${job.id} 超时`);
        try { call("session/cancel", { request: { sessionId: kernelId } }).catch(() => {}); } catch {}
        finish("timeout", "任务超时", "TIMEOUT");
      }, Number(process.env.DSH_TIMEOUT_MS || 600000));

      followStream = openStream(FOLLOW_ENDPOINT, {
        request: { address: { kind: "session", sessionId: kernelId }, assistantStream: true },
      }, {
        onItem: (v) => {
          if (!v) return;
          if (v.type === "assistant-stream") {
            // 原生打字机：内核直接给增量，不需要像平面 A 那样按 dt 回放。
            // 实测 frame.chunk（StreamChunk）的形状：
            //   {type:'block-start', index, blockType:'text'|'reasoning'}
            //   {type:'text-delta', index, text}              ← 正文增量
            //   {type:'reasoning-delta', index, text}         ← 思考增量
            //   {type:'block-end', index, block:{type,text}}  ← 已由 delta 累加过，**不要重复累加**
            // 另兼容持久流里的 {type:'text-chunks'|'reasoning-chunks', texts:[]}
            const f = v.frame || {};
            if (f.type !== "chunk") return;
            const c = f.chunk || {};
            let text = "";
            let thinking = false;
            if (c.type === "text-delta" && typeof c.text === "string") {
              text = c.text;
            } else if (c.type === "reasoning-delta" && typeof c.text === "string") {
              text = c.text; thinking = true;
            } else if (c.type === "text-chunks" && Array.isArray(c.texts)) {
              text = c.texts.join("");
            } else if (c.type === "reasoning-chunks" && Array.isArray(c.texts)) {
              text = c.texts.join(""); thinking = true;
            }
            if (!text) return;
            if (thinking) {
              reasoning += text;
              if (hooks.pushThinking) safe(() => hooks.pushThinking(job, text));
            } else {
              reply += text;
              // ⚠️ 必须写回 job.reply：SSE 的 done 载荷与会话记账（recordSessionReply）都读它。
              // 只累加局部变量会导致「前端转圈结束但正文是空的」。
              job.reply = reply;
              if (hooks.pushAnswer) safe(() => hooks.pushAnswer(job, text));
            }
            return;
          }
          if (v.type !== "event") return;
          const e = v.event || {};
          const d = e.data || {};
          switch (e.type) {
            case "tool/call":
              if (hooks.pushLog) safe(() => hooks.pushLog(job, `执行工具 ${d.name || ""}`));
              break;
            case "tool/result":
              if (hooks.pushLog) safe(() => hooks.pushLog(job, `工具 ${d.message && d.message.isError ? "失败" : "完成"}${d.error ? "：" + (d.error.message || d.error.name) : ""}`));
              break;
            case "assistant/message": {
              const text = (d.message && d.message.content || [])
                .filter((x) => x.type === "text").map((x) => x.text).join("");
              // 用整段文本兜底：万一没有 assistant-stream 增量（网关没要 / 断线重连），
              // 这里还能把正文补齐，避免「有终态没正文」
              if (text) { reply = text; job.reply = text; }
              if (d.usage && hooks.setUsage) safe(() => hooks.setUsage(job, d.usage));
              break;
            }
            case "turn/end": {
              const reason = d.reason || {};
              job.turnEndReason = reason;
              if (reason.kind === "aborted") {
                finish("cancelled", "已停止", "CANCELLED");
              } else if (reason.kind === "completed") {
                finish("done");
              } else if (reason.kind === "error") {
                const raw = (reason.error && (reason.error.message || reason.error.name)) || "模型调用失败";
                finish("failed", raw, hooks.classify ? hooks.classify(raw).code : "MODEL_ERROR", raw);
              } else if (reason.kind === "interrupted") {
                finish("failed", "回合被中断", "INTERRUPTED");
              } else {
                finish("failed", `回合异常结束：${reason.kind || "unknown"}`, "TURN_ABNORMAL");
              }
              break;
            }
            default:
              break;
          }
        },
        onError: (err) => {
          const msg = (err && err.message) || "事件流失败";
          if (err && err.code === "session/not-found") {
            // 会话在内核侧不存在（换了容器/PVC 被清）→ 让下一轮重建
            if (job.sessionId) { delete kernelMap[job.sessionId]; saveKernelMap(); }
            finish("failed", "会话已失效，请新建会话继续", "SESSION_LOST", msg);
          } else {
            finish("failed", msg, "STREAM_ERROR", msg);
          }
        },
        onEnd: () => { finish("failed", "事件流提前结束", "STREAM_CLOSED"); },
      });

      // 发消息（requestId 幂等：同 id 重发内核直接返回 accepted，不会重复入队）
      // 图片走 contentBlocks 内联（内核支持 {type:'image', data:<base64>, mimeType}），
      // ⚠️ 绝不能拼进 task 字符串 —— 那边有 200000 字符硬校验。
      const content = [{ type: "text", text: job.task }];
      for (const img of (job.images || [])) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      if (content.length > 1) log(`[web-engine] 附带 ${content.length - 1} 张内联图片`);
      call("session/prompt", {
        request: {
          requestId: `gw-${job.id}`,
          sessionId: kernelId,
          mode: "queue",
          content,
        },
      }).catch((e) => finish("failed", e.message, hooks.classify ? hooks.classify(e.message).code : "PROMPT_ERROR", e.message));
    });
  }

  /* ---------- 取消 ---------- */

  async function cancel(job) {
    const kernelId = job.kernelId || job.sdkSessionId;
    log(`[web-engine] 取消任务 ${job.id}`);
    if (kernelId) {
      try { await call("session/cancel", { request: { sessionId: kernelId } }); }
      catch (e) { log(`[web-engine] session/cancel 失败: ${e.message}`); }
    }
    // 内核确认中断后会由 turn/end(aborted) 收尾；兜底 3s 后本地收尾，避免前端一直转
    setTimeout(() => {
      if (job.finishTurn && !["done", "failed", "timeout", "cancelled"].includes(job.status)) {
        job.finishTurn("cancelled", "已停止", "CANCELLED");
      }
    }, 3000);
    return true;
  }

  /* ---------- 交互（提问 / 审批） ---------- */

  /** 收到 $events 的 waterfall：挂到对应 job 上，等客户端回答案 */
  function onEventItem(v) {
    if (!v) return;
    if (v.type === "ready") {
      clientId = v.clientId;
      wsReady = true;
      log(`[web-engine] $events 已就绪 clientId=${clientId}`);
      return;
    }
    if (v.type !== "waterfall") return;
    const agentId = v.agentId;
    const job = hooks.findJobByKernelId ? safe(() => hooks.findJobByKernelId(agentId)) : null;
    const isApproval = v.event === "approval/request";
    const interaction = {
      id: v.eventId,
      kind: isApproval ? "approval" : "question",
      event: v.event,
      sessionId: agentId,
      request: v.request,
      t: Date.now(),
    };
    log(`[web-engine] 收到交互 ${interaction.kind}（job=${job ? job.id : "未匹配"}）`);
    if (!job) {
      // 没有对应 job（例如用户在 WebUI 里发起的）→ 不是我们的答案，交给下一个 answerer
      respondRaw(v.eventId, { kind: "next" }).catch(() => {});
      return;
    }
    job.pendingInteractions = job.pendingInteractions || new Map();
    job.pendingInteractions.set(v.eventId, interaction);
    if (hooks.pushInteraction) safe(() => hooks.pushInteraction(job, interaction));
  }

  /** 直接向内核回答案（不经过 job 时也用得上） */
  async function respondRaw(eventId, outcome) {
    if (!clientId) throw new Error("$events 尚未就绪");
    // ⚠️ 这个端点的 payload 恰好只有 args 一个键，内容就是 result 本体，不能再套 request
    return call(EVENTS_RESULT_ENDPOINT, { clientId, eventId, outcome });
  }

  /**
   * 客户端回答案。
   * @param job     对应任务
   * @param id      interaction id（= 内核 eventId）
   * @param outcome {kind:'result'|'next'|'rejected', value?, error?}
   */
  async function respond(job, id, outcome) {
    const pending = job.pendingInteractions;
    const item = pending && pending.get(id);
    if (!item) throw new Error("该交互已失效或不属于此任务");
    let final = outcome;
    if (item.kind === "approval" && final.kind === "result") {
      // 内核只认四个闭集值，其它一律归一为 unavailable（等于拒绝）
      if (!APPROVAL_OUTCOMES.has(final.value)) final = { kind: "result", value: "unavailable" };
    }
    await respondRaw(id, final);
    pending.delete(id);
    if (hooks.pushInteractionResolved) safe(() => hooks.pushInteractionResolved(job, id, final));
    return final;
  }

  /* ---------- 生命周期 ---------- */

  /** 重启 dsh web：换掉 launchToken 与内核侧的 WebUI 会话（web-ui.js 的「重置工作台」用它） */
  function restartWeb(reason) {
    log(`[web-engine] 重启 dsh web（${reason}）`);
    if (child) { try { child.kill("SIGTERM"); } catch {} } else { startProcess(); }
    return true;
  }

  function start() {
    loadKernelMap();
    startProcess();
    watchPluginReload();
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    for (const streamId of Array.from(streams.keys())) closeStream(streamId);
    try { if (ws) ws.close(); } catch {}
    try { if (child) child.kill("SIGTERM"); } catch {}
    try { fs.unwatchFile(pluginReloadPath); } catch {}
  }

  return {
    start,
    stop,
    restartWeb,
    ready: () => wsReady,
    token: () => token,
    call,
    kernelIdOf,
    ensureKernelSession,
    applySettings,
    sessionOptions,
    anyKernelSession,
    readPermissions,
    runTurn,
    cancel,
    respond,
    status: () => ({ ready: wsReady, clientId, port, token: token ? "set" : "none", streams: streams.size }),
  };
}

module.exports = { createWebEngine, APPROVAL_OUTCOMES };
