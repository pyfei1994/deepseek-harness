/**
 * eftik-dsh-cloud Demo 后端 v0.3（docker/demo）
 * 职责：静态页 + 代理 Sealos Applaunchpad（创建/状态/删除）+ 代理 DSH 网关（全接口）
 * 零依赖 Node 22+。启动：node demo-server.js（默认 :8093）
 *
 * 环境变量：DEMO_PORT / SEALOS_KUBECONFIG_PATH / DSH_IMAGE / DSH_CPU / DSH_MEM
 * 密钥安全：代码零硬编码。DEEPSEEK_API_KEY / ACR_USER / ACR_PASS 通过
 *   ① 页面「配置」面板提交（存本进程内存，重启即失，不落盘）；或
 *   ② 可选的 docker/demo/.env（已被 .gitignore 忽略，勿提交）。
 * 工作台注册表持久化在同目录 workspaces.local.json（已 gitignore，含 gwToken，勿提交）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 可选加载 docker/demo/.env（不覆盖已存在的环境变量）
const envPath = path.join(__dirname, ".env");
try {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = Number(process.env.DEMO_PORT || 8093);
const SEALOS_API = "https://applaunchpad.hzh.sealos.run/api/v2alpha";
const KUBECONFIG_PATH = process.env.SEALOS_KUBECONFIG_PATH
  || (fs.existsSync(path.join(__dirname, "kubeconfig.yaml")) ? path.join(__dirname, "kubeconfig.yaml") : "")
  || "C:/Users/vante/Downloads/kubeconfig (5).yaml";
const KUBECONFIG_ABS = path.isAbsolute(KUBECONFIG_PATH) ? KUBECONFIG_PATH : path.join(__dirname, KUBECONFIG_PATH);
const AUTH = encodeURIComponent(fs.readFileSync(KUBECONFIG_ABS, "utf8"));
const IMAGE = process.env.DSH_IMAGE || "registry.cn-shanghai.aliyuncs.com/eftik/eftik-dsh-cloud:1.2.0";
const CPU = Number(process.env.DSH_CPU || 1);
const MEM = Number(process.env.DSH_MEM || 2);

/** 敏感配置：仅存内存（session），可通过页面 /api/config 更新，永不写盘、永不提交 */
const CONFIG = {
  acrUser: process.env.ACR_USER || "",
  acrPass: process.env.ACR_PASS || "",
  deepseekKey: process.env.DEEPSEEK_API_KEY || "",
};
const ACR_HOST = "registry.cn-shanghai.aliyuncs.com";

const mask = (s) => (s ? `${s.slice(0, 4)}****${s.slice(-4)}` : "");

const STORE_PATH = path.join(__dirname, "workspaces.local.json");
/** name -> {gwToken, publicAddress, createdAt} */
let workspaces = {};
try { workspaces = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); } catch {}
function persist() {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(workspaces, null, 2)); } catch (e) { console.error("persist failed:", e.message); }
}

async function sealos(method, p, body) {
  const r = await fetch(`${SEALOS_API}${p}`, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

const newToken = () => crypto.randomBytes(16).toString("hex");

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

async function gwFetch(ws, p, opts = {}) {
  return fetch(`${ws.publicAddress}${p}`, {
    ...opts,
    headers: { "X-GW-Token": ws.gwToken, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

function getWs(name) {
  const ws = workspaces[name];
  if (!ws || !ws.publicAddress) return null;
  return ws;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    /* ---------- 密钥配置（仅存内存） ---------- */

    if (url.pathname === "/api/config") {
      if (req.method === "GET") {
        return send(res, 200, {
          acrUser: CONFIG.acrUser ? mask(CONFIG.acrUser) : "",
          acrPassSet: Boolean(CONFIG.acrPass),
          deepseekKey: CONFIG.deepseekKey ? mask(CONFIG.deepseekKey) : "",
          fromEnv: Boolean(process.env.ACR_PASS || process.env.DEEPSEEK_API_KEY),
        });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.acrUser === "string" && body.acrUser) CONFIG.acrUser = body.acrUser.trim();
        if (typeof body.acrPass === "string" && body.acrPass) CONFIG.acrPass = body.acrPass;
        if (typeof body.deepseekKey === "string" && body.deepseekKey) CONFIG.deepseekKey = body.deepseekKey.trim();
        return send(res, 200, { ok: true, acrPassSet: Boolean(CONFIG.acrPass), deepseekKey: mask(CONFIG.deepseekKey) });
      }
    }

    /* ---------- Sealos 工作台管理 ---------- */

    if (req.method === "POST" && url.pathname === "/api/create") {
      if (!CONFIG.deepseekKey || !CONFIG.acrUser || !CONFIG.acrPass) {
        return send(res, 400, { ok: false, error: "密钥未配置：请先在页面右上角「配置」填写 DeepSeek API Key 与 ACR 用户名/密码" });
      }
      const { name } = await readBody(req);
      const appName = (name || `dsh-demo-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const gwToken = newToken();
      const imageName = IMAGE.includes(ACR_HOST) ? IMAGE.slice(ACR_HOST.length + 1) : IMAGE;
      const body = {
        name: appName,
        image: {
          imageName,
          imageRegistry: { serverAddress: ACR_HOST, username: CONFIG.acrUser, password: CONFIG.acrPass },
        },
        quota: { replicas: 1, cpu: CPU, memory: MEM },
        ports: [{ number: 8090, protocol: "http", isPublic: true }],
        env: [
          { name: "GW_TOKEN", value: gwToken },
          { name: "DEEPSEEK_API_KEY", value: CONFIG.deepseekKey },
        ],
        storage: [
          { name: "dsh-home", path: "/home/node/.dsh", size: "1Gi" },
          { name: "workspace", path: "/workspace", size: "2Gi" },
        ],
      };
      const r = await sealos("POST", "/apps", body);
      if (r.status === 201 || r.status === 200) {
        workspaces[appName] = { gwToken, publicAddress: null, createdAt: Date.now() };
        persist();
        return send(res, 200, { ok: true, name: appName });
      }
      return send(res, r.status, { ok: false, error: JSON.stringify(r.data).slice(0, 600) });
    }

    let m = url.pathname.match(/^\/api\/app\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const r = await sealos("GET", `/apps/${m[1]}`);
      if (r.status !== 200) return send(res, r.status, { status: "unknown", error: r.data });
      const app = r.data;
      const ws = workspaces[m[1]];
      const port = (app.ports || []).find((p) => p.number === 8090);
      if (ws && port && port.publicAddress) { ws.publicAddress = port.publicAddress.replace(/\/$/, ""); persist(); }
      return send(res, 200, {
        name: app.name, status: app.status, upTime: app.upTime,
        publicAddress: port ? port.publicAddress : null, image: app.image ? app.image.imageName : null,
      });
    }

    m = url.pathname.match(/^\/api\/app\/([\w-]+)$/);
    if (req.method === "DELETE" && m) {
      const r = await sealos("DELETE", `/apps/${m[1]}`);
      delete workspaces[m[1]];
      persist();
      return send(res, 200, { ok: r.status === 204 });
    }

    m = url.pathname.match(/^\/api\/apps$/);
    if (req.method === "GET" && m) {
      const r = await sealos("GET", "/apps");
      const apps = (r.data || []).filter((a) => a.name.startsWith("dsh-demo"));
      return send(res, 200, apps.map((a) => ({ name: a.name, status: a.status, upTime: a.upTime })));
    }

    /* ---------- 网关代理 ---------- */

    m = url.pathname.match(/^\/api\/health\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 200, { ok: false, reason: "not ready" });
      try { return send(res, 200, await (await gwFetch(ws, "/health")).json()); }
      catch (e) { return send(res, 200, { ok: false, reason: String(e.message || e).slice(0, 200) }); }
    }

    m = url.pathname.match(/^\/api\/chat\/([\w-]+)$/);
    if (req.method === "POST" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      const body = await readBody(req);
      const r = await gwFetch(ws, "/chat", { method: "POST", body: JSON.stringify(body) });
      return send(res, r.status, await r.json());
    }

    m = url.pathname.match(/^\/api\/task\/([\w-]+)\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      const r = await gwFetch(ws, `/task/${m[2]}`);
      return send(res, r.status, await r.json());
    }

    m = url.pathname.match(/^\/api\/task\/([\w-]+)\/([\w-]+)$/);
    if (req.method === "DELETE" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      return send(res, 200, await (await gwFetch(ws, `/task/${m[2]}`, { method: "DELETE" })).json());
    }

    // SSE 透传：浏览器 EventSource 无法带自定义 header，由本服务注入 gwToken
    m = url.pathname.match(/^\/api\/stream\/([\w-]+)\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const ws = getWs(m[1]);
      if (!ws) { res.writeHead(400); return res.end("workspace not ready"); }
      const upstream = await gwFetch(ws, `/task/${m[2]}/stream`, { headers: { Accept: "text/event-stream" } });
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
      return;
    }

    m = url.pathname.match(/^\/api\/settings\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      const r = await gwFetch(ws, "/settings");
      return send(res, r.status, await r.json());
    }
    if (req.method === "POST" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      const body = await readBody(req);
      const r = await gwFetch(ws, "/settings", { method: "POST", body: JSON.stringify(body) });
      return send(res, r.status, await r.json());
    }
    if (req.method === "DELETE" && m) {
      const ws = getWs(m[1]);
      if (!ws) return send(res, 400, { error: "工作台不存在或未就绪" });
      const r = await gwFetch(ws, "/settings", { method: "DELETE" });
      return send(res, r.status, await r.json());
    }

    /* ---------- 静态页 ---------- */
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "demo.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
      return res.end(html);
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[demo] listening on http://127.0.0.1:${PORT} (image=${IMAGE}, workspaces=${Object.keys(workspaces).length})`);
});
