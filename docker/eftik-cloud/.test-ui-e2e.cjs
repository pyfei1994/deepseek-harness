// 用 Chrome 无头浏览器真实走一遍：未设密码 → 看到设置面板 → 设密码 → 看到登录面板
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROXY_PORT = 39501;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ui-e2e-"));

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

/* 极简 CDP */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = Buffer.from(String(Math.random())).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), handshaken = false, id = 0;
    const pending = new Map();
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken && buf.includes("\r\n\r\n")) { handshaken = true; buf = Buffer.alloc(0); resolve(api); return; }
      while (buf.length > 2) {
        const len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        let payload;
        if ((buf[1] & 0x80) === 0x80) { // 服务端帧不掩码
          payload = buf.slice(off, off + len).toString("utf8");
        } else {
          payload = buf.slice(off, off + len).toString("utf8");
        }
        buf = buf.slice(off + len);
        let msg; try { msg = JSON.parse(payload); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    sock.on("error", reject);
    const api = (method, params) => new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      const frame = Buffer.from(JSON.stringify({ id: myId, method, params: params || {} }));
      const mask = Buffer.from([1, 2, 3, 4]);
      const l = frame.length;
      let header;
      if (l < 126) header = Buffer.from([0x81, 0x80 | l]);
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(l, 2); }
      const masked = Buffer.from(frame);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ timeout: true }); } }, 8000);
    });
    api.close = () => sock.destroy();
    setTimeout(() => reject(new Error("cdp handshake timeout")), 8000);
  });
}

const getJson = (p) => new Promise((res, rej) => {
  http.get({ hostname: "127.0.0.1", port: 9377, path: p }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(JSON.parse(d))); }).on("error", rej);
});

(async () => {
  // 起真 web-ui.js（假 upstream 不可达也没关系，我们只看登录页本身）
  const env = {
    ...process.env,
    GW_WEB_PORT: String(PROXY_PORT),
    GW_WEB_UPSTREAM_PORT: "39502",
    GW_WEB_PASSWORD_PATH: path.join(TMP, "pw.sha256"),
    GW_LOGIN_HTML: path.join(__dirname, "login.html"),
    GW_BRANDING_DIR: path.join(__dirname, "branding"),
    GW_WORKDIR: TMP,
  };
  const boot = `require(${JSON.stringify(path.join(__dirname, "web-ui.js"))})`;
  const proxy = spawn(process.execPath, ["-r", path.join(__dirname, ".cjs-preload.cjs"), "-e", boot], { stdio: ["ignore", "ignore", "ignore"], env });
  for (let i = 0; i < 60; i++) {
    try { const r = await new Promise((res) => http.get({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/_eftik/session" }, res).on("error", () => res(null))); if (r) break; } catch {}
    await new Promise((s) => setTimeout(s, 150));
  }

  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=9377",
    `--user-data-dir=${path.join(TMP, "cr")}`,
    "--window-size=1200,800", "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { await getJson("/json/version"); break; } catch { await new Promise((s) => setTimeout(s, 250)); } }
  const list = await getJson("/json/list");
  const page = list.find((t) => t.type === "page");
  const api = await cdp(page.webSocketDebuggerUrl);

  const evalJs = async (expr) => {
    const r = await api("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.result ? r.result.result.value : undefined;
  };

  await api("Page.enable");
  await api("Page.navigate", { url: `http://127.0.0.1:${PROXY_PORT}/_eftik/login` });
  await new Promise((s) => setTimeout(s, 2000));

  console.log("\n[N] 未设密码时：应显示「设置访问密码」面板");
  check("title 正确", /狐分身/.test(await evalJs("document.title")), await evalJs("document.title"));
  check("登录面板已隐藏", (await evalJs("getComputedStyle(document.getElementById('login-panel')).display")) === "none");
  check("设置面板可见", (await evalJs("document.getElementById('setup-panel').classList.contains('show')")) === true);
  check("焦点在新密码框", (await evalJs("document.activeElement && document.activeElement.id")) === "pw1");

  console.log("\n[O] 通过页面真实交互设置密码");
  await evalJs("document.getElementById('pw1').value='MySecretPass1'");
  await evalJs("document.getElementById('pw2').value='MySecretPass1'");
  await evalJs("document.getElementById('form2').dispatchEvent(new Event('submit',{cancelable:true}))");
  await new Promise((s) => setTimeout(s, 2500));
  check("提交后跳离了登录页（进入工作台路径）", (await evalJs("location.pathname")) !== "/_eftik/login", await evalJs("location.pathname"));
  const cookies = await evalJs("document.cookie");
  check("HttpOnly cookie 不会暴露给 JS（document.cookie 为空）", !/eftik-session/.test(String(cookies || "")), String(cookies));

  console.log("\n[P] 重新打开登录页：此时应显示「登录」面板");
  await api("Page.navigate", { url: `http://127.0.0.1:${PROXY_PORT}/_eftik/login` });
  await new Promise((s) => setTimeout(s, 2000));
  // 已经登录了 → 应该被 302 到 /，所以这里检查「不在登录页」即证明会话生效
  const p2 = await evalJs("location.pathname");
  check("已登录再访问登录页 → 被重定向离开", p2 !== "/_eftik/login", p2);

  console.log("\n[Q] 清除 cookie 后再看登录面板");
  await api("Network.enable");
  await api("Network.clearBrowserCookies");
  await api("Page.navigate", { url: `http://127.0.0.1:${PROXY_PORT}/_eftik/login` });
  await new Promise((s) => setTimeout(s, 2000));
  check("登录面板可见", (await evalJs("getComputedStyle(document.getElementById('login-panel')).display")) !== "none", await evalJs("getComputedStyle(document.getElementById('login-panel')).display"));
  check("设置面板已隐藏", (await evalJs("document.getElementById('setup-panel').classList.contains('show')")) === false);
  check("焦点在密码框", (await evalJs("document.activeElement && document.activeElement.id")) === "pw");
  check("页脚文案指向小程序", /小程序/.test(await evalJs("document.querySelector('.foot').textContent")));

  console.log("\n[R] 错误密码 → 页面内联报错（不弹浏览器原生框）");
  await evalJs("document.getElementById('pw').value='WrongPassword'");
  await evalJs("document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true}))");
  await new Promise((s) => setTimeout(s, 2000));
  check("错误提示可见", (await evalJs("document.getElementById('err').classList.contains('show')")) === true, await evalJs("document.getElementById('err').textContent"));
  check("提示文案为「密码不正确」", /密码不正确/.test(String(await evalJs("document.getElementById('err').textContent"))), await evalJs("document.getElementById('err').textContent"));

  console.log("\n[S] 正确密码 → 进入工作台");
  await evalJs("document.getElementById('pw').value='MySecretPass1'");
  await evalJs("document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true}))");
  await new Promise((s) => setTimeout(s, 3000));
  check("跳离登录页", (await evalJs("location.pathname")) !== "/_eftik/login", await evalJs("location.pathname"));

  api.close();
  chrome.kill();
  proxy.kill("SIGTERM");
  await new Promise((s) => setTimeout(s, 500));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
