/**
 * eftik-dsh-cloud in-pod 网关 v0.3
 * 运行在 DSH 容器内，监听 0.0.0.0:8090，业务方（kitsume 后端）HTTP 调用。
 * 零依赖，Node 22+。
 *
 * 任务接口：
 *   POST /chat            {"task": "..."} 或 {"message": "...", "history": [{role, content}]}
 *                         -> {"task_id"}
 *   GET  /task/:id        -> {"status","reply","error","events","elapsed_ms"}
 *   GET  /task/:id/stream SSE 实时流：event: log / event: done
 *   DELETE /task/:id      取消任务
 *
 * 设置接口（工作台级，持久化到 /workspace/.eftik-settings.json）：
 *   GET    /settings      -> 当前设置
 *   POST   /settings      部分更新：{model?, provider?, permissionMode?, reasoning?, background?, memory?}
 *   DELETE /settings      重置为默认
 *
 *   - model/provider    → 每次任务通过 --patch 覆盖 agent-default-model 插件（切换大模型）
 *   - permissionMode    → 每次任务注入 DSH_PERMISSION_MODE 环境变量
 *                         read-only | workspace-write | danger-full-access（官方三档权限预设）
 *   - reasoning         → low | balanced | high（0.1.2-rc.1 内核无原生推理等级键，
 *                         以系统前导指令模拟；上游支持后可切换为真实配置）
 *   - background/memory → 人设背景与长期记忆，任务前导注入系统上下文
 *
 *   GET  /health        -> {"ok","dsh","version","jobs"}
 *
 * 鉴权：请求头 X-GW-Token 必须等于环境变量 GW_TOKEN（未设置则不鉴权，仅限内网调试）。
 */
const http = require("http");
const fs = require("fs");
const { spawn, execSync } = require("child_process");

const GATEWAY_VERSION = "gateway/0.3";
const PORT = Number(process.env.GW_PORT || 8090);
const GW_TOKEN = process.env.GW_TOKEN || "";
const TIMEOUT_MS = Number(process.env.DSH_TIMEOUT_MS || 600000);
const MAX_EVENTS = 200;
const MAX_HISTORY = 20;
const SETTINGS_PATH = "/workspace/.eftik-settings.json";
const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"];
const REASONING_LEVELS = ["low", "balanced", "high"];
const MAX_TEXT = 32768;

const DEFAULT_SETTINGS = Object.freeze({
  model: "",                    // 空 = 内核默认（deepseek-v4-flash）
  provider: "",                 // 空 = deepseek-official
  permissionMode: "workspace-write",
  reasoning: "balanced",
  background: "",
  memory: "",
});

/** task_id -> job */
const jobs = new Map();
let queue = Promise.resolve();

function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

/* ---------- 设置 ---------- */

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  const dir = require("path").dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function validateSettings(patch) {
  const errors = [];
  if (patch.model !== undefined && (typeof patch.model !== "string" || patch.model.length > 128)) errors.push("model 须为 ≤128 字符字符串");
  if (patch.provider !== undefined && (typeof patch.provider !== "string" || patch.provider.length > 128)) errors.push("provider 须为 ≤128 字符字符串");
  if (patch.permissionMode !== undefined && !PERMISSION_MODES.includes(patch.permissionMode)) errors.push(`permissionMode 须为 ${PERMISSION_MODES.join(" / ")}`);
  if (patch.reasoning !== undefined && !REASONING_LEVELS.includes(patch.reasoning)) errors.push(`reasoning 须为 ${REASONING_LEVELS.join(" / ")}`);
  for (const k of ["background", "memory"]) {
    if (patch[k] !== undefined && (typeof patch[k] !== "string" || patch[k].length > MAX_TEXT)) errors.push(`${k} 须为 ≤${MAX_TEXT} 字符字符串`);
  }
  return errors;
}

/* ---------- 任务组装 ---------- */

function buildSystemPreamble(s) {
  const parts = [];
  if (s.background) parts.push(`【角色背景】\n${s.background}`);
  if (s.memory) parts.push(`【长期记忆】\n${s.memory}`);
  if (s.reasoning === "high") parts.push("【回答要求】先深入思考再作答，重视推理过程与边界情况。");
  else if (s.reasoning === "low") parts.push("【回答要求】直接简洁地回答，跳过冗长解释。");
  if (!parts.length) return "";
  return "<system-context>\n" + parts.join("\n\n") + "\n</system-context>\n\n";
}

function composeTask(body, settings) {
  if (body.task) return buildSystemPreamble(settings) + body.task;
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const lines = [buildSystemPreamble(settings), "以下是本次对话的历史记录，请基于它保持上下文连贯：", "<history>"];
  for (const m of history) {
    if (!m || typeof m.content !== "string") continue;
    lines.push(`${m.role === "assistant" ? "助手" : "用户"}：${m.content}`);
  }
  lines.push("</history>");
  lines.push(`用户新消息：${body.message}`);
  lines.push("请直接回应用户的新消息。");
  return lines.filter(Boolean).join("\n");
}

/* ---------- 执行 ---------- */

function runDsh(job) {
  return new Promise((resolve) => {
    const args = ["--profile", "headless"];
    const spawnEnv = { ...process.env, DSH_TELEMETRY_DISABLED: "1" };

    // 权限模式：官方环境变量开关（sandbox-policy + approval 联动）
    if (job.settings.permissionMode) spawnEnv.DSH_PERMISSION_MODE = job.settings.permissionMode;

    // 模型切换：写 patch 覆盖 agent-default-model 插件
    if (job.settings.model) {
      const patchPath = `/tmp/patch-${job.id}.yml`;
      const provider = job.settings.provider || "deepseek-official";
      fs.writeFileSync(patchPath, `- id: agent-default-model\n  config:\n    provider: '${provider}'\n    model: '${job.settings.model}'\n`);
      args.push("--patch", patchPath);
    }

    args.push(job.task);
    const child = spawn("dsh", args, { windowsHide: true, env: spawnEnv });
    job.pid = child.pid;
    let stdout = "";
    let stderrTail = "";
    const timer = setTimeout(() => {
      job.status = "timeout";
      try { child.kill("SIGKILL"); } catch {}
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-4000);
      const lines = d.toString().split("\n").filter(Boolean);
      for (const l of lines) {
        if (job.events.length < MAX_EVENTS) job.events.push({ t: Date.now(), text: l.slice(0, 300) });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      job.status = "failed";
      job.error = String(e.message || e);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      job.finishedAt = Date.now();
      if (job.settings.model) { try { fs.unlinkSync(`/tmp/patch-${job.id}.yml`); } catch {} }
      if (job.status === "timeout") {
        job.error = `dsh 超时（${TIMEOUT_MS / 1000}s）`;
      } else if (code === 0) {
        job.status = "done";
        job.reply = stdout.trim();
      } else {
        job.status = "failed";
        job.error = `dsh 退出码 ${code}: ${(stderrTail || stdout).slice(-500)}`;
      }
      resolve();
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

let dshVersion = "";
try { dshVersion = execSync("dsh --version", { encoding: "utf8" }).trim(); } catch {}

/** SSE：把 job 的增量事件与最终结果推给调用方 */
function streamTask(req, res, job) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let sent = 0;
  const timer = setInterval(() => {
    for (; sent < job.events.length; sent++) {
      res.write(`event: log\ndata: ${JSON.stringify(job.events[sent])}\n\n`);
    }
    if (["done", "failed", "timeout"].includes(job.status)) {
      clearInterval(timer);
      res.write(`event: done\ndata: ${JSON.stringify({ status: job.status, reply: job.reply, error: job.error, elapsed_ms: (job.finishedAt || Date.now()) - job.createdAt })}\n\n`);
      res.end();
    }
  }, 500);
  req.on("close", () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (GW_TOKEN && req.headers["x-gw-token"] !== GW_TOKEN) {
    return send(res, 401, { error: "invalid gateway token" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, dsh: dshVersion, version: GATEWAY_VERSION, jobs: jobs.size });
    }

    /* ---------- 设置 ---------- */
    if (req.method === "GET" && url.pathname === "/settings") {
      return send(res, 200, loadSettings());
    }
    if (req.method === "POST" && url.pathname === "/settings") {
      const patch = await readBody(req);
      const errors = validateSettings(patch);
      if (errors.length) return send(res, 400, { error: errors.join("; ") });
      const next = { ...loadSettings(), ...patch };
      saveSettings(next);
      return send(res, 200, next);
    }
    if (req.method === "DELETE" && url.pathname === "/settings") {
      saveSettings({ ...DEFAULT_SETTINGS });
      return send(res, 200, { ...DEFAULT_SETTINGS });
    }

    /* ---------- 任务 ---------- */
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = await readBody(req, 2 << 20);
      const settings = loadSettings(); // 提交时刻的设置快照
      const task = composeTask(body, settings);
      if (!task || typeof task !== "string" || task.length > 200000) {
        return send(res, 400, { error: "task 或 message 必填（拼装后 ≤200000 字符）" });
      }
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job = { id, task, settings, status: "queued", reply: "", error: "", events: [], createdAt: Date.now() };
      jobs.set(id, job);
      // 单用户容器内串行执行
      enqueue(() => {
        job.status = "running";
        return runDsh(job);
      });
      return send(res, 200, { task_id: id });
    }

    const m = url.pathname.match(/^\/task\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "task not found" });
      return send(res, 200, {
        status: job.status, reply: job.reply, error: job.error,
        events: job.events, elapsed_ms: (job.finishedAt || Date.now()) - job.createdAt,
      });
    }

    const sm = url.pathname.match(/^\/task\/([\w-]+)\/stream$/);
    if (req.method === "GET" && sm) {
      const job = jobs.get(sm[1]);
      if (!job) return send(res, 404, { error: "task not found" });
      return streamTask(req, res, job);
    }

    if (req.method === "DELETE" && m) {
      const job = jobs.get(m[1]);
      if (job && job.pid) { try { process.kill(job.pid, "SIGKILL"); } catch {} }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dsh-gw ${GATEWAY_VERSION}] listening on 0.0.0.0:${PORT} (dsh ${dshVersion || "?"})`);
});
