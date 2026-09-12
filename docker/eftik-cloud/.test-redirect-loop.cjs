/**
 * 防死循环回归测试：验证加了登录页之后，原有「token 注入 / 303 兜底」逻辑没被破坏。
 *
 * 手法：起一个假 upstream 严格复刻 dsh web 的鉴权行为
 *   - 无 cookie 无 token → 401
 *   - 有 token           → 种 cookie + 303 /
 *   - 有合法 cookie      → 200
 * 并且用「假 dsh 可执行文件」把 launchToken 真正喂进 web-ui.js（Windows 需要 .cmd 垫片
 * 且 spawn 得带 shell，因此这里通过 GW 环境变量把「假 dsh 的启动命令」做成 node 直调）。
 * 最后模拟浏览器跟随重定向，断言「最多 N 跳内到达 200」。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const UPSTREAM_PORT = 39280;
const PROXY_PORT = 39281;
const TOKEN = "tok_loop_test_42";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-loop-"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/* ---- 假 dsh：打印含 ?token= 的启动日志后常驻 ----
   web-ui.js 里 spawn('dsh', ['web', ...]) 是硬编码无扩展名命令。Windows 上必须
   shell:true + .cmd 才能命中，因此这里用 NODE_OPTIONS=--require 注入一个垫片，
   把 child_process.spawn 包一层（仅在本次测试进程内生效，不动生产代码）。 */
const fakeDshJs = path.join(TMP, "fake-dsh.js");
fs.writeFileSync(fakeDshJs, `process.stderr.write("dsh web listening on http://127.0.0.1:${UPSTREAM_PORT}/?token=${TOKEN}\\n");
setInterval(() => {}, 1 << 30);
`);
const shimPath = path.join(TMP, "spawn-shim.cjs");
fs.writeFileSync(shimPath, `
const cp = require("child_process");
const orig = cp.spawn;
const NODE_BIN = ${JSON.stringify(process.execPath)};
cp.spawn = function (cmd, args, opts) {
  if (cmd === "dsh") {
    return orig(NODE_BIN, [${JSON.stringify(fakeDshJs)}].concat(args || []), opts);
  }
  return orig.apply(this, arguments);
};
`);

/* ---- 假 upstream：复刻 dsh web 的鉴权行为 ---- */
let upstreamHits = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const hasCookie = /(?:^|;\s*)dsh-auth-real=/.test(String(req.headers.cookie || ""));
  const hasToken = u.searchParams.get("token") === TOKEN;
  upstreamHits.push({ url: req.url, hasCookie, hasToken });
  if (hasToken) {
    res.writeHead(303, { Location: "/", "Set-Cookie": "dsh-auth-real=yes; Path=/" });
    return res.end();
  }
  if (hasCookie) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<h1>REAL HOME</h1>"); }
  res.writeHead(401); res.end("no");
});

function req(port, { method = "GET", path: p, headers = {} } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

/** 模拟浏览器跟随重定向（带 cookie jar），返回最终响应与跳数 */
async function browse(port, startPath, headers, initialCookie) {
  const jar = {};
  let cookieHeader = initialCookie || "";
  if (initialCookie) {
    for (const part of initialCookie.split(";")) {
      const kv = part.trim(); const i = kv.indexOf("=");
      if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  const applySetCookie = (h) => {
    const raw = h["set-cookie"];
    if (!raw) return;
    for (const c of (Array.isArray(raw) ? raw : [raw])) {
      const [kv] = String(c).split(";");
      const i = kv.indexOf("=");
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  };
  let p = startPath, hops = 0;
  while (hops < 25) {
    const h = { accept: "text/html", ...(headers || {}) };
    if (cookieHeader) h.cookie = cookieHeader;
    const r = await req(port, { path: p, headers: h });
    applySetCookie(r.headers);
    hops++;
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      p = r.headers.location;
      continue;
    }
    return { ...r, hops };
  }
  return { status: 0, hops, error: "too many redirects" };
}

(async () => {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  // 把假 dsh 放到 PATH 最前，并通过 NODE_OPTIONS 注入 spawn 垫片
  const env = { ...process.env };
  env.PATH = TMP + path.delimiter + (env.PATH || "");
  // 用 NODE_OPTIONS 同时预加载：CJS 垫片（让 web-ui.js 在 type:module 仓库根下可跑）
  // + spawn 垫片（把 spawn('dsh') 换成假 dsh）。两者互不干扰。
  env.NODE_OPTIONS = `--require ${shimPath} --require ${path.join(__dirname, ".cjs-preload.cjs")}`;
  env.GW_WEB_PORT = String(PROXY_PORT);
  env.GW_WEB_UPSTREAM_PORT = String(UPSTREAM_PORT);
  env.GW_WEB_PASSWORD_PATH = path.join(TMP, "pw.sha256");
  env.GW_LOGIN_HTML = path.join(__dirname, "login.html");
  env.GW_BRANDING_DIR = path.join(__dirname, "branding");
  // web-ui.js 用 cwd: GW_WORKDIR（默认 /workspace）拉起 dsh。Windows 上没有 /workspace，
  // 会让 spawn 直接 ENOENT。本地测试指到一个真实存在的目录。
  env.GW_WORKDIR = TMP;

  // 经 -e require(...) 启动：仓库根是 type:module，直接把 web-ui.js 当入口会被
  // ESM 加载器接管；NODE_OPTIONS 里再叠加 spawn 垫片（把 spawn('dsh') 换成假 dsh）。
  const boot = `require(${JSON.stringify(path.join(__dirname, "web-ui.js"))})`;
  const child = spawn(process.execPath, ["-e", boot], { stdio: ["ignore", "ignore", "pipe"], env });
  const logs = [];
  child.stderr.on("data", (c) => logs.push(c.toString()));
  child.on("error", (e) => logs.push("CHILD ERROR: " + e.message));

  for (let i = 0; i < 80; i++) {
    const r = await req(PROXY_PORT, { path: "/_eftik/session" });
    if (r.status === 200) break;
    await new Promise((s) => setTimeout(s, 150));
  }
  // dsh 是异步启动的，等它把 token 打到 stderr
  for (let i = 0; i < 40; i++) {
    if (/token=/.test(logs.join(""))) break;
    await new Promise((s) => setTimeout(s, 150));
  }
  console.log("    [启动日志]", JSON.stringify(logs.join("").slice(0, 300)));

  // 设密码 + 登录拿会话 cookie
  const pwBody = JSON.stringify({ password: "LoopTestPass9" });
  const loginCookie = await new Promise((r) => {
    const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/_eftik/setup", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(pwBody) } }, (res) => {
      const sc = res.headers["set-cookie"];
      const first = sc ? (Array.isArray(sc) ? String(sc[0]) : String(sc)) : "";
      res.resume();
      res.on("end", () => r(first.split(";")[0]));
    });
    q.end(pwBody);
  });
  check("setup 拿到会话 cookie", /^eftik-session=/.test(loginCookie), loginCookie.slice(0, 30));

  console.log("\n[J] 已登录用户首次进入工作台（模拟真实浏览器跟随跳转）");
  console.log("    proxy 日志:", JSON.stringify(logs.join("").slice(0, 600)));
  const res = await browse(PROXY_PORT, "/", null, loginCookie);
  check("最终落到 200", res.status === 200, `status=${res.status} hops=${res.hops} err=${res.error}`);
  check("拿到真实工作台首页", /REAL HOME/.test(res.body || ""), (res.body || "").slice(0, 60));
  check(`跳数收敛（≤ 6，实际 ${res.hops}）`, res.hops <= 6, `hops=${res.hops}`);
  // 已持有效会话 cookie 的请求，请求侧会直接注入 token（而不是靠响应侧兜底），
  // 因此这里断言的是「上游确实收到了带 token 的请求」，而不是补丁日志。
  check("上游收到带 token 的请求（请求侧注入生效）",
    upstreamHits.some((h) => h.hasToken), JSON.stringify(upstreamHits.slice(0, 4)));

  console.log("\n[K] 未登录用户的 API 请求仍是 401（不跳登录页）");
  const apiRes = await req(PROXY_PORT, { path: "/some/api", headers: { accept: "application/json" } });
  check("API → 401", apiRes.status === 401, `status=${apiRes.status}`);

  console.log("\n[L] 未登录浏览器访问 / → 302 到登录页（不暴露工作台）");
  const loginRes = await req(PROXY_PORT, { path: "/", headers: { accept: "text/html" } });
  check("302 且 Location 指向 /_eftik/login",
    loginRes.status === 302 && loginRes.headers.location === "/_eftik/login",
    `status=${loginRes.status} loc=${loginRes.headers.location}`);
  check("未泄露工作台内容", !/REAL HOME/.test(loginRes.body || ""));

  console.log("\n[M] 未登录浏览器直接开 /_eftik/login → 拿到登录页");
  const pageRes = await req(PROXY_PORT, { path: "/_eftik/login", headers: { accept: "text/html" } });
  check("200 且是登录页 HTML",
    pageRes.status === 200 && /狐分身|访问密码/.test(pageRes.body),
    `status=${pageRes.status}`);

  child.kill("SIGTERM");
  upstream.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
