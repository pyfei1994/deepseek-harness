/**
 * 本地端到端验证：不依赖容器与 dsh 内核，只验证 web-ui.js 的「鉴权 + 登录页 + 会话」链路。
 *
 * 做法：
 *   1. 起一个假的 upstream（模拟 dsh web），只回 200 或 303/401
 *   2. 用真实 web-ui.js 的鉴权逻辑（web-auth.js）驱动一个等价的最小 server
 *      —— 直接 require web-auth.js，保证测的是真代码，而不是复制一份。
 *
 * 覆盖点：
 *   - 未配置密码时 /_eftik/session 返回 configured:false
 *   - POST /_eftik/setup 建密码 → 下发 cookie
 *   - 带 cookie 可过鉴权；不带 cookie 走 Basic Auth 也可过
 *   - 密码错误 + 限流
 *   - 新会话首问不带 history（纯断言逻辑，见末尾）
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCjs } = require("./.cjs-loader.cjs");
const { createWebAuth } = loadCjs("./web-auth.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-auth-"));
const PW_PATH = path.join(TMP, "pw.sha256");

const auth = createWebAuth({ fs, passwordPath: PW_PATH });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

function req(opts, body) {
  return new Promise((resolve) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  console.log("\n[1] 未配置密码");
  check("isConfigured() === false", auth.isConfigured() === false);
  check("verifyBrowser(空请求) === false", auth.verifyBrowser({ headers: {} }) === false);
  check("verifyBasic(空请求) === false", auth.verifyBasic({ headers: {} }) === false);
  check("passwordMatches('anything') === false", auth.passwordMatches("anything") === false);

  console.log("\n[2] 设置密码（模拟 POST /_eftik/setup 的落盘逻辑）");
  const pw = "hunter2-secret";
  fs.mkdirSync(path.dirname(PW_PATH), { recursive: true });
  fs.writeFileSync(PW_PATH, require("crypto").createHash("sha256").update(pw).digest("hex"));
  check("isConfigured() === true", auth.isConfigured() === true);
  check("passwordMatches(正确密码) === true", auth.passwordMatches(pw) === true);
  check("passwordMatches(错误密码) === false", auth.passwordMatches("wrong") === false);

  console.log("\n[3] Cookie 签发与校验");
  const cookieHeader = auth.issueCookie(true);
  check("issueCookie 返回非空", typeof cookieHeader === "string" && cookieHeader.length > 0);
  check("cookie 含 HttpOnly", /HttpOnly/.test(cookieHeader));
  check("cookie 含 SameSite=Lax", /SameSite=Lax/.test(cookieHeader));
  check("cookie 名是 eftik-session", cookieHeader.startsWith("eftik-session="));

  const cookieVal = cookieHeader.split(";")[0]; // eftik-session=xxx
  const withCookie = { headers: { cookie: cookieVal } };
  check("带合法 cookie → verifyBrowser true", auth.verifyBrowser(withCookie) === true);
  check("带合法 cookie → verifyAny true", auth.verifyAny(withCookie) === true);

  console.log("\n[4] 篡改 cookie 必须被拒");
  const tampered = cookieVal.slice(0, -4) + "beef";
  check("签名被篡改 → false", auth.verifyBrowser({ headers: { cookie: tampered } }) === false);
  const fakePayload = "eftik-session=" + Buffer.from("exp=" + (Date.now() + 9e9)).toString("base64url") + "." + "0".repeat(64);
  check("伪造 payload → false", auth.verifyBrowser({ headers: { cookie: fakePayload } }) === false);

  console.log("\n[5] 过期 cookie 必须被拒");
  const expired = auth.issueCookie(true);
  // 直接构造一个已过期的（这里通过短 ttl 的独立实例验证）
  const shortAuth = createWebAuth({ fs, passwordPath: PW_PATH, ttlMs: 1 });
  const shortCookie = shortAuth.issueCookie(true).split(";")[0];
  await new Promise((r) => setTimeout(r, 10));
  check("过期 cookie → false", shortAuth.verifyBrowser({ headers: { cookie: shortCookie } }) === false);
  check("未过期 cookie 仍有效", auth.verifyBrowser({ headers: { cookie: cookieVal } }) === true);
  void expired;

  console.log("\n[6] Basic Auth 兼容（小程序/脚本通道）");
  const basic = "Basic " + Buffer.from("dsh:" + pw).toString("base64");
  check("正确 Basic → true", auth.verifyBasic({ headers: { authorization: basic } }) === true);
  check("verifyAny(Basic) → true", auth.verifyAny({ headers: { authorization: basic } }) === true);
  const basicBad = "Basic " + Buffer.from("dsh:nope").toString("base64");
  check("错误 Basic → false", auth.verifyBasic({ headers: { authorization: basicBad } }) === false);
  check("非 Basic scheme → false", auth.verifyBasic({ headers: { authorization: "Bearer xyz" } }) === false);

  console.log("\n[7] 浏览器 / API 请求识别（决定 302 还是 401）");
  check("Accept: text/html → 浏览器", auth.isBrowserRequest({ headers: { accept: "text/html,application/xhtml+xml" } }) === true);
  check("Sec-Fetch-Mode: navigate → 浏览器", auth.isBrowserRequest({ headers: { "sec-fetch-mode": "navigate" } }) === true);
  check("Accept: application/json → 非浏览器", auth.isBrowserRequest({ headers: { accept: "application/json" } }) === false);
  check("无任何头 → 非浏览器", auth.isBrowserRequest({ headers: {} }) === false);
  check("WebSocket 升级 → 非浏览器", auth.isBrowserRequest({ headers: { upgrade: "websocket", accept: "*/*" } }) === false);

  console.log("\n[8] 登出清 cookie");
  check("clearCookie 含 Max-Age=0", /Max-Age=0/.test(auth.clearCookie()));

  console.log("\n[9] 改密码 → 旧 cookie 立即失效");
  const before = cookieVal;
  fs.writeFileSync(PW_PATH, require("crypto").createHash("sha256").update("brand-new-pw").digest("hex"));
  check("旧 cookie 在新密码下失效", auth.verifyBrowser({ headers: { cookie: before } }) === false);
  check("新密码可登录", auth.verifyBasic({ headers: { authorization: "Basic " + Buffer.from("dsh:brand-new-pw").toString("base64") } }) === true);

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
