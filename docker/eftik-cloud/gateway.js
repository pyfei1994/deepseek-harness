/**
 * DSH Workspace in-pod 网关 v0.1
 * 运行在 DSH 容器内，监听 0.0.0.0:8090，业务方（kitsume 后端）HTTP 调用。
 * 零依赖，Node 22+。
 *
 * 接口：
 *   POST /chat        {"task": "..."}            -> {"task_id"}
 *   GET  /task/:id    -> {"status","reply","error","events"}
 *   DELETE /task/:id  取消（尽力 kill 进程）
 *   GET  /health      -> {"ok":true,"dsh":"<version>"}
 *
 * 鉴权：请求头 X-GW-Token 必须等于环境变量 GW_TOKEN（未设置则不鉴权，仅限内网调试）。
 */
const http = require("http");
const { spawn, execSync } = require("child_process");

const PORT = Number(process.env.GW_PORT || 8090);
const GW_TOKEN = process.env.GW_TOKEN || "";
const TIMEOUT_MS = Number(process.env.DSH_TIMEOUT_MS || 600000);
const MAX_EVENTS = 200;

/** task_id -> job */
const jobs = new Map();
let queue = Promise.resolve();

function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

function runDsh(job) {
  return new Promise((resolve) => {
    const args = ["--profile", "headless", job.task];
    const child = spawn("dsh", args, {
      windowsHide: true,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: "1" },
    });
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 1 << 20) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

let dshVersion = "";
try { dshVersion = execSync("dsh --version", { encoding: "utf8" }).trim(); } catch {}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (GW_TOKEN && req.headers["x-gw-token"] !== GW_TOKEN) {
    return send(res, 401, { error: "invalid gateway token" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, dsh: dshVersion, jobs: jobs.size });
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      const { task } = await readBody(req);
      if (!task || typeof task !== "string" || task.length > 100000) {
        return send(res, 400, { error: "task 必填（≤100000 字符）" });
      }
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job = { id, task, status: "queued", reply: "", error: "", events: [], createdAt: Date.now() };
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
  console.log(`[dsh-gw] listening on 0.0.0.0:${PORT} (dsh ${dshVersion || "?"})`);
});
