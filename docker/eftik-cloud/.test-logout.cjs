/**
 * 「退出登录 / 清除登录缓存」专项测试。
 *
 * 三条链路都要覆盖：
 *   [1] 清 cookie 的「名字面」 —— 浏览器真的发来的每个 cookie 名都要被置空，
 *       否则脏 cookie（别的子域留下、或 dsh web 重启后失效的 dsh-auth-*）清不干净
 *   [2] 浏览器走 302 回登录页；脚本/小程序仍拿 JSON（老契约不能破）
 *   [3] 往上游 HTML 注入浮动按钮 —— 长度变了必须重算 content-length，
 *       且不能把注入带到非 HTML 响应上
 *
 * 两个环境要点：
 *   - 本机没有 dsh 二进制 → 用 GW_WEB_LAUNCH_TOKEN 给定 launchToken，
 *     否则「已鉴权 → 放行到上游」永远停在 503，注入根本走不到
 *   - 会重启 dsh web 的用例（deep=1）放在最后，因为它会把 launchToken 清空
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UPSTREAM_PORT = 39090;
const PROXY_PORT = 39091;
const FAKE_TOKEN = "tok_logout_test";
const PASSWORD = "SuperSecret123";
// 用真实形态的 Host 才能验证「wide 时清父域」——127.0.0.1 反推不出父域
const FAKE_HOST = "jfqjgeayntxx.sealosbja.site";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-logout-"));
const PW_PATH = path.join(TMP, "pw.sha256");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/* ---- 假 upstream：既模拟 dsh web 的 token/cookie 交接，也提供可注入的 HTML 页 ---- */
let lastUpstreamHeaders = {};
const upstream = http.createServer((req, res) => {
  lastUpstreamHeaders = req.headers;
  const u = new URL(req.url, "http://x");
  const hasCookie = /(?:^|;\s*)dsh-auth-test=/.test(String(req.headers.cookie || ""));

  if (u.pathname === "/page" && hasCookie) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end('<!doctype html><html><head><title>DeepSeek Harness</title></head>'
      + '<body><div id="root"></div></body></html>');
  }
  if (u.pathname === "/data.json" && hasCookie) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true}');
  }
  if (u.searchParams.get("token") === FAKE_TOKEN) {
    res.writeHead(303, { Location: "/", "Set-Cookie": "dsh-auth-test=ok; Path=/" });
    return res.end();
  }
  if (hasCookie) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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

/** set-cookie 可能是数组；统一成数组 */
function setCookies(headers) {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

(async () => {
  console.log("\n[0] 单元：clearedCookieHeaders / listCookieNames");
  // 仓库根是 type:module，直接 require web-auth.js 会被当 ESM → 走 .cjs-loader.cjs
  const { loadCjs } = require("./.cjs-loader.cjs");
  const { clearedCookieHeaders, listCookieNames } = loadCjs("./web-auth.js");

  const fakeReq = {
    headers: { cookie: "eftik-session=abc; dsh-auth-XyZ=ok; sealos-token=t; bad name=1; " + "a".repeat(200) + "=v" },
  };
  const names = listCookieNames(fakeReq);
  check("收集到请求里的 cookie 名", ["eftik-session", "dsh-auth-XyZ", "sealos-token"].every((n) => names.includes(n)), JSON.stringify(names));
  check("过滤畸形名（含空格）", !names.some((n) => n.includes(" ")), JSON.stringify(names));
  check("过滤超长名（>128）", names.every((n) => n.length <= 128), JSON.stringify(names));

  const h1 = clearedCookieHeaders(fakeReq, { host: FAKE_HOST });
  check("每个名字下发 host-only + 带域名两条", h1.filter((c) => c.startsWith("dsh-auth-XyZ=")).length === 2, JSON.stringify(h1.filter((c) => c.startsWith("dsh-auth-XyZ="))));
  check("全部 Max-Age=0", h1.every((c) => /Max-Age=0/.test(c)));
  check("带域名那条是当前 host", h1.some((c) => c.includes(`Domain=${FAKE_HOST}`)));
  check("默认不清父域", !h1.some((c) => c.includes("Domain=sealosbja.site")), "不该出现父域");
  check("wideDomain 才清父域", clearedCookieHeaders(fakeReq, { host: FAKE_HOST, wideDomain: true }).some((c) => c.includes("Domain=sealosbja.site")));
  const h3 = clearedCookieHeaders({ headers: {} }, { host: "" });
  check("没有 cookie 也至少清 eftik-session", h3.length === 1 && h3[0].startsWith("eftik-session="), JSON.stringify(h3));

  /* ---- 起真 web-ui.js ---- */
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  process.env.GW_WEB_PORT = String(PROXY_PORT);
  process.env.GW_WEB_UPSTREAM_PORT = String(UPSTREAM_PORT);
  process.env.GW_WEB_PASSWORD_PATH = PW_PATH;
  process.env.GW_LOGIN_HTML = path.join(__dirname, "login.html");
  process.env.GW_BRANDING_DIR = path.join(__dirname, "branding");
  process.env.GW_WEB_LAUNCH_TOKEN = FAKE_TOKEN; // 见文件头：本机无 dsh 二进制
  // 仓库根是 type:module，web-ui.js 必须经 require() 加载（见 .cjs-preload.cjs 注释）
  const boot = `require(${JSON.stringify(path.join(__dirname, "web-ui.js"))})`;
  const child = require("child_process").spawn(process.execPath, ["-r", path.join(__dirname, ".cjs-preload.cjs"), "-e", boot], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  child.stderr.on("data", (c) => {
    const t = c.toString();
    if (/launchToken|token=/.test(t)) return;
    process.stdout.write(`  [proxy] ${t}`);
  });

  for (let i = 0; i < 60; i++) {
    const r = await httpReq(PROXY_PORT, { path: "/_eftik/session" });
    if (r.status === 200) break;
    await new Promise((s) => setTimeout(s, 150));
  }

  // 设密码并登录，再走一次 token 交接让 upstream 种下 dsh-auth-test
  await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/setup", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  let r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const sessionCookie = setCookies(r.headers)[0].split(";")[0];
  await httpReq(PROXY_PORT, { path: `/?token=${FAKE_TOKEN}`, headers: { accept: "text/html", cookie: sessionCookie } });
  const jar = `${sessionCookie}; dsh-auth-test=ok; sealos-token=stale`;

  console.log("\n[A] 浏览器点「退出登录」（GET + Accept: text/html）");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/logout", headers: { accept: "text/html", cookie: jar, host: FAKE_HOST } });
  check("302 回登录页", r.status === 302, `got ${r.status}`);
  check("location 带 cleared 标记", r.headers.location === "/_eftik/login?cleared=1", String(r.headers.location));
  const sc = setCookies(r.headers);
  const clearedNames = new Set(sc.map((c) => c.split("=")[0]));
  check("清了 eftik-session", clearedNames.has("eftik-session"), [...clearedNames].join(","));
  check("清了 dsh-auth-test（脏 dsh cookie）", clearedNames.has("dsh-auth-test"), [...clearedNames].join(","));
  check("清了 sealos-token（平台脏 cookie）", clearedNames.has("sealos-token"), [...clearedNames].join(","));
  check("全部 Max-Age=0", sc.every((c) => /Max-Age=0/.test(c)), sc.join(" | "));
  check("默认不下发父域 Domain", !sc.some((c) => c.includes("Domain=sealosbja.site")), sc.join(" | "));

  console.log("\n[B] 工作台 HTML 里注入浮动「退出登录」");
  r = await httpReq(PROXY_PORT, { path: "/page", headers: { accept: "text/html", cookie: jar } });
  check("200 且仍是 HTML", r.status === 200 && /text\/html/.test(String(r.headers["content-type"])), `${r.status} ${r.headers["content-type"]}`);
  check("注入了浮层标记", r.body.includes("data-eftik-logout"), r.body.slice(-160));
  check("浮层里有退出链接", /href="\/_eftik\/logout"/.test(r.body));
  check("浮层里有重置链接", /href="\/_eftik\/logout\?deep=1&amp;wide=1"/.test(r.body));
  check("插在 </body> 之前（不打断 SPA 引导）", r.body.indexOf("data-eftik-logout") < r.body.indexOf("</body>"), "位置不对");
  check("content-length 与实际字节数一致", Number(r.headers["content-length"]) === Buffer.byteLength(r.body, "utf8"), `${r.headers["content-length"]} vs ${Buffer.byteLength(r.body, "utf8")}`);
  check("未声明 content-encoding", !r.headers["content-encoding"], String(r.headers["content-encoding"]));
  check("未声明 transfer-encoding", !r.headers["transfer-encoding"], String(r.headers["transfer-encoding"]));
  check("原页面内容仍在", r.body.includes('id="root"') && r.body.includes("DeepSeek Harness"));
  // 再请求一次，确认不会叠加两份（按浮层根节点计数；CSS 里 [data-eftik-logout] 会出现多次）
  const again = await httpReq(PROXY_PORT, { path: "/page", headers: { accept: "text/html", cookie: jar } });
  const widgets = (again.body.match(/<div data-eftik-logout>/g) || []).length;
  check("重复访问不叠加浮层", widgets === 1, `找到 ${widgets} 个浮层`);

  console.log("\n[C] 注入只针对 HTML 文档");
  r = await httpReq(PROXY_PORT, { path: "/data.json", headers: { accept: "application/json", cookie: jar } });
  check("JSON 响应不注入", r.status === 200 && !r.body.includes("data-eftik-logout"), `${r.status} ${r.body.slice(0, 80)}`);

  console.log("\n[D] 注入前强制 identity 编码（否则拿到压缩字节，改不了）");
  await httpReq(PROXY_PORT, { path: "/page", headers: { accept: "text/html", cookie: jar, "accept-encoding": "gzip, deflate, br" } });
  check("HTML 导航请求不带 accept-encoding", !lastUpstreamHeaders["accept-encoding"], String(lastUpstreamHeaders["accept-encoding"]));
  await httpReq(PROXY_PORT, { path: "/data.json", headers: { accept: "*/*", cookie: jar, "accept-encoding": "gzip, deflate, br" } });
  check("资源请求保留 accept-encoding（压缩照旧）", /gzip/.test(String(lastUpstreamHeaders["accept-encoding"] || "")), String(lastUpstreamHeaders["accept-encoding"]));

  console.log("\n[E] 脚本/小程序调用（POST，无 text/html）→ 保持 JSON 契约");
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/logout", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({}) });
  check("200 + JSON ok", r.status === 200 && (() => { try { return JSON.parse(r.body).ok === true; } catch { return false; } })(), r.body.slice(0, 80));
  const j = JSON.parse(r.body || "{}");
  check("JSON 里有 deep/wide/cleared 字段", j.deep === false && j.wide === false && j.cleared > 0, r.body.slice(0, 120));
  check("JSON 响应同时下发了清 cookie 头", setCookies(r.headers).length > 0);

  console.log("\n[F] 未登录也能用（进不去工作台时的兜底）");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/logout", headers: { accept: "text/html", cookie: "eftik-session=stale; dsh-auth-dead=x", host: FAKE_HOST } });
  check("无有效会话也返回 302", r.status === 302, `got ${r.status}`);
  check("照样清掉了脏 cookie", setCookies(r.headers).some((c) => c.startsWith("dsh-auth-dead=")), setCookies(r.headers).join(" | "));

  console.log("\n[G] 「重置工作台」：宽域清理 + 重启内核（放最后，会清空 launchToken）");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/logout?deep=1&wide=1", headers: { accept: "text/html", cookie: jar, host: FAKE_HOST } });
  check("302 且 cleared=reset", r.status === 302 && r.headers.location === "/_eftik/login?cleared=reset", `${r.status} ${r.headers.location}`);
  const sc2 = setCookies(r.headers);
  check("wide 时下发父域 Domain", sc2.some((c) => c.includes("Domain=sealosbja.site")), sc2.slice(0, 2).join(" | "));
  check("父域清理仍带 Max-Age=0", sc2.filter((c) => c.includes("Domain=sealosbja.site")).every((c) => /Max-Age=0/.test(c)));
  r = await httpReq(PROXY_PORT, { method: "POST", path: "/_eftik/logout", headers: { "content-type": "application/json" }, body: JSON.stringify({ deep: true, wide: true }) });
  check("JSON 通道 deep/wide 同样生效", (() => { const x = JSON.parse(r.body || "{}"); return x.deep === true && x.wide === true; })(), r.body.slice(0, 120));

  console.log("\n[H] 登录页出现「清除本机登录缓存」入口与提示条");
  r = await httpReq(PROXY_PORT, { path: "/_eftik/login", headers: { accept: "text/html" } });
  check("登录页含清除入口", /href="\/_eftik\/logout"/.test(r.body) && /清除本机登录缓存/.test(r.body));
  check("登录页含提示条容器", /id="notice"/.test(r.body));

  child.kill("SIGTERM");
  upstream.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
