/**
 * 真 HTTP 端到端：起假 upstream + 真 web-ui.js，用 HTTP 请求走完整流程。
 *
 * 假 upstream 模拟 dsh web：拿到 ?token= 就栽 dsh-auth-* cookie 并 303 /，
 * 有合法 cookie 就 200。这样能同时验证「登录 → 进工作台」和既有防死循环逻辑没被破坏。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UPSTREAM_PORT = 39080;
const PROXY_PORT = 39081;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-proxy-"));
const PW_PATH = path.join(TMP, "pw.sha256");
const TOKEN = "tok_abc123";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/* ---- 假 upstream ---- */
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.searchParams.get("token") === TOKEN) {
    res.writeHead(303, { Location: "/", "Set-Cookie": "dsh-auth-test=ok; Path=/" });
    return res.end();
  }
  if (/(?:^|;\s*)dsh-auth-test=/.test(String(req.headers.cookie || ""))) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<h1>DSH WORKSPACE HOME</h1>");
  }
  res.writeHead(401, { "Content-Type": "text/plain" });
  res.end("unauthorized");
});

function httpReq(port, { method = "GET", path: p, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

/** set-cookie 是数组，取第一项；容错标量情形 */
function firstSetCookie(headers) {
  const raw = headers["set-cookie"];
  if (!raw) return "";
  return Array.isArray(raw) ? String(raw[0] || "") : String(raw);
}

(async () => {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  // 启动真 web-ui.js（用环境变量把假 upstream / 密码路径 / 登录页指过去）
  process.env.GW_WEB_PORT = String(PROXY_PORT);
  process.env.GW_WEB_UPSTREAM_PORT = String(UPSTREAM_PORT);
  process.env.GW_WEB_PASSWORD_PATH = PW_PATH;
  process.env.GW_LOGIN_HTML = path.join(__dirname, "login.html");
  process.env.GW_BRANDING_DIR = path.join(__dirname, "branding");
  // 用 -e require(...) 而非把 web-ui.js 作为入口：仓库根是 type:module，
  // 直接当入口会被 ESM 加载器接管（报 require is not defined）；
  // 经 require() 加载则走 .cjs-preload.cjs 里改写的 CommonJS 编译。
  const boot = `require(${JSON.stringify(path.join(__dirname, "web-ui.js"))})`;
  const child = require("child_process").spawn(process.execPath, ["-r", path.join(__dirname, ".cjs-preload.cjs"), "-e", boot], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  child.stderr.on("data", (c) => {
    const t = c.toString();
    if (/launchToken|token=/.test(t)) return; // 忽略 dsh 启动噪声
    process.stdout.write(`  [proxy] ${t}`);
  });

  // 等代理就绪
  for (let i = 0; i < 60; i++) {
    const r = await httpReq(PROXY_PORT, { path: "/_eftik/session" });
    if (r.status === 200) break;
    await new Promise((s) => setTimeout(s, 150));
  }

  console.log("\n[A] 未登录 + 未配置密码");
  let r = await httpReq(PROXY_PORT, { path: "/_eftik/session" });
  check("GET /_eftik/session → 200", r.status === 200, `got ${r.status}`);
  let s = JSON.parse(r.body || "{}");
  check("configured=false（尚未设密码）", s.configured === false, JSON.stringify(s));

  r = await httpReq(PROXY_PORT, { path: "/", headers: { accept: "text/html" } });
  check("浏览器访问 / → 200 且返回登录页", r.status === 200 && /设置访问密码|<title>/.test(r.body), `status=${r.status}`);
  check("登录页注入了背景图", /--bg-image: url\('\/branding\/bg\.png'\)/.test(r.body), "未找到注入标记");
  check("body 带 has-bg class", /<body class="has-bg">/.test(r.body));

  r = await httpReq(PROXY_PORT, { path: "/api/whatever", headers: { accept: "application/json" } });
  check("API 调用未鉴权 → 401（不是 302）", r.status === 401, `got ${r.status}`);
  check("401 带 WWW-Authenticate", /Basic realm=/.test(String(r.headers["www-authenticate"] || "")));

  r = await httpReq(PROXY_PORT, { path: "/branding/bg.png" });
  check("GET /branding/bg.png → 200 image/png", r.status === 200 && String(r.headers["content-type"]).includes("image/png"), `got ${r.status}`);
  r = await httpReq(PROXY_PORT, { path: "/branding/../web-auth.js" });
  check("目录穿越被拦（非 200）", r.status !== 200, `got ${r.status}`);

  console.log("\n[B] 首次设置密码");
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/setup", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "abc" }) });
  check("过短密码 → 400", r.status === 400, `got ${r.status}`);
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/setup", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "SuperSecret123" }) });
  check("合法密码 → 200", r.status === 200, `got ${r.status} ${r.body}`);
  const setupCookie = firstSetCookie(r.headers).split(";")[0];
  check("下发 eftik-session cookie", setupCookie.startsWith("eftik-session="), setupCookie);

  console.log("\n[C] 已登录后 setup 必须被拒（防匿名重置）");
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/setup", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "hacked-pass" }) });
  check("重复 setup → 403", r.status === 403, `got ${r.status}`);

  console.log("\n[D] 登录");
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
  check("错误密码 → 401", r.status === 401, `got ${r.status}`);
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "SuperSecret123", remember: true }) });
  check("正确密码 → 200", r.status === 200, `got ${r.status}`);
  const cookie = firstSetCookie(r.headers).split(";")[0];

  console.log("\n[E] 登录后访问");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/session", headers: { cookie } });
  s = JSON.parse(r.body || "{}");
  check("session.authenticated=true", s.authenticated === true, JSON.stringify(s));

  r = await httpReq(PROXY_PORT, { path: "/", headers: { accept: "text/html", cookie } });
  // 本地无 dsh 二进制 → launchToken 为空 → 走到 503 '正在启动'。
  // 这正是「已鉴权、已放行、只等内核就绪」的正确分支，说明 cookie 生效了。
  check("带 cookie 访问 / → 已放行到内核（503 正在启动）", r.status === 503 && /正在启动/.test(r.body), `status=${r.status} body=${r.body.slice(0, 40)}`);

  console.log("\n[F] Basic Auth 通道不受影响（小程序/脚本）");
  const basic = "Basic " + Buffer.from("dsh:SuperSecret123").toString("base64");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/session", headers: { authorization: basic } });
  s = JSON.parse(r.body || "{}");
  check("Basic Auth 通过（session 接口可见）", r.status === 200, `got ${r.status}`);

  r = await httpReq(PROXY_PORT, { path: "/", headers: { authorization: basic, accept: "text/html" } });
  check("Basic Auth 访问 / 不被跳登录页", r.status !== 200 || !/设置访问密码/.test(r.body), `status=${r.status}`);

  console.log("\n[G] 已登录访问登录页 → 跳走");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/login", headers: { cookie, accept: "text/html" } });
  check("已登录 GET /_eftik/login → 302 /", r.status === 302 && r.headers.location === "/", `status=${r.status} loc=${r.headers.location}`);

  console.log("\n[H] 登出");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/logout" });
  check("logout 清 cookie（Max-Age=0）", /Max-Age=0/.test(firstSetCookie(r.headers)));

  console.log("\n[I] API 前缀通道（/_eftik/api）不要求登录");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/api/health" });
  check("未登录访问 /_eftik/api/* → 未被 401 拦（502 或 200 均可）", r.status !== 401, `got ${r.status}`);

  child.kill("SIGTERM");
  upstream.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
