const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createWebAuth } = require('./web-auth');

const PUBLIC_PORT = Number(process.env.GW_WEB_PORT || 8080);
const UPSTREAM_PORT = Number(process.env.GW_WEB_UPSTREAM_PORT || 3080);
const GATEWAY_PORT = Number(process.env.GW_PORT || 8090);
const API_PREFIX = '/_eftik/api';
const PASSWORD_PATH = process.env.GW_WEB_PASSWORD_PATH || '/home/node/.dsh/eftik-web-password.sha256';
const PLUGIN_RELOAD_PATH = process.env.GW_PLUGIN_RELOAD_PATH || '/home/node/.dsh/eftik-plugin-reload';
// 登录页与品牌资源：容器内 /opt/gw/ 随镜像发布；背景图放 PVC 便于换肤不重建镜像
const LOGIN_HTML_PATH = process.env.GW_LOGIN_HTML || path.join(__dirname, 'login.html');
const BRANDING_DIR = process.env.GW_BRANDING_DIR || '/home/node/.dsh/branding';
let launchToken = '';
let web = null;
let stopping = false;

const auth = createWebAuth({ fs, passwordPath: PASSWORD_PATH });

// dsh web 用「token 换 cookie」鉴权：首次带 ?token=xxx，由它种下 dsh-auth-<随机名>
// cookie，之后靠 cookie 通行。上游每次拿到「带 token」的请求都会重新种 cookie 并
// 303 回 /，因此代理侧必须能识别「已经持有 dsh cookie」，否则会陷入无限 303。
// 注意只认 dsh 自己的 cookie —— 浏览器在同域下还会带着无关 cookie
//（小程序通道、Sealos 平台自身等），拿「有没有任何 cookie」判断会漏掉该注入的时机，
// 反而触发 ERR_TOO_MANY_REDIRECTS。
const DSH_COOKIE_RE = /(?:^|;\s*)dsh-auth-[^=]+=/;

function hasDshCookie(req) {
  const raw = String(req.headers.cookie || '');
  return raw ? DSH_COOKIE_RE.test(raw) : false;
}

function authorized(req) {
  return auth.verifyAny(req);
}

function challenge(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DSH Workspace"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

/* ---------- 登录页 / 会话接口 ---------- */

const MAX_LOGIN_ATTEMPTS = 10;      // 滑动窗口内允许的失败次数
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
let loginAttempts = [];             // 失败时间戳（单用户容器，无需按 IP 分桶）

function loginRateLimited() {
  const now = Date.now();
  loginAttempts = loginAttempts.filter((t) => now - t < LOGIN_WINDOW_MS);
  return loginAttempts.length >= MAX_LOGIN_ATTEMPTS;
}

function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 64 * 1024)) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}

/** 返回登录页 HTML；背景图存在时把 URL 注入进去（无需重建镜像即可换肤） */
function sendLoginPage(res) {
  let html;
  try {
    html = fs.readFileSync(LOGIN_HTML_PATH, 'utf8');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('登录页资源缺失，请联系管理员');
  }
  // 探测 PVC 上的品牌背景图（任一扩展名），存在才注入 —— 避免 404 导致的白屏闪烁
  let bgUrl = '';
  for (const name of ['bg.jpg', 'bg.png', 'bg.webp', 'bg.jpeg']) {
    try { if (fs.statSync(path.join(BRANDING_DIR, name)).isFile()) { bgUrl = `/branding/${name}`; break; } } catch {}
  }
  if (bgUrl) {
    html = html
      .replace('--bg-image: none;', `--bg-image: url('${bgUrl}');`)
      .replace('<body>', '<body class="has-bg">');
  }
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/** 提供 /branding/* 静态资源（只允许白名单文件名，防目录穿越） */
function serveBranding(res, pathname) {
  const name = pathname.slice('/branding/'.length);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(400); return res.end(); }
  const full = path.join(BRANDING_DIR, name);
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const ext = path.extname(full).toLowerCase();
  if (!types[ext]) { res.writeHead(403); return res.end(); }
  let data;
  try { data = fs.readFileSync(full); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': data.length, 'Cache-Control': 'public, max-age=3600' });
  res.end(data);
}

/** 处理 /_eftik/{login,logout,session,setup}；返回 true 表示已接管 */
async function handleAuthRoutes(req, res, url) {
  const p = url.pathname;

  if (p === '/_eftik/login' && req.method === 'POST') {
    if (!auth.isConfigured()) return sendJson(res, 409, { error: '尚未设置访问密码' }), true;
    if (loginRateLimited()) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' }), true;
    const body = await readJsonBody(req);
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!auth.passwordMatches(password)) {
      loginAttempts.push(Date.now());
      return sendJson(res, 401, { error: '密码不正确，请重试' }), true;
    }
    loginAttempts = [];
    const cookie = auth.issueCookie(body.remember !== false);
    return sendJson(res, 200, { ok: true }, cookie ? { 'Set-Cookie': cookie } : undefined), true;
  }

  if (p === '/_eftik/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }), true;
  }

  // 前端启动时问一次：是否已配置密码（决定显示登录还是设置密码）
  if (p === '/_eftik/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      configured: auth.isConfigured(),
      authenticated: auth.verifyBrowser(req),
    }), true;
  }

  // 首次设置密码：**仅当尚未配置时可用**，避免已配置后被匿名重置
  if (p === '/_eftik/setup' && req.method === 'POST') {
    if (auth.isConfigured()) return sendJson(res, 403, { error: '访问密码已设置，请联系管理员重置' }), true;
    const body = await readJsonBody(req);
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 64 || /[\r\n]/.test(password)) {
      return sendJson(res, 400, { error: '密码须为 8-64 个字符' }), true;
    }
    try {
      fs.mkdirSync(path.dirname(PASSWORD_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(PASSWORD_PATH, crypto.createHash('sha256').update(password).digest('hex'), { mode: 0o600 });
      try { fs.chmodSync(PASSWORD_PATH, 0o600); } catch {}
    } catch (e) {
      return sendJson(res, 500, { error: '写入失败：' + (e && e.message) }), true;
    }
    const cookie = auth.issueCookie(true);
    return sendJson(res, 200, { ok: true }, cookie ? { 'Set-Cookie': cookie } : undefined), true;
  }

  if (p === '/_eftik/login') {
    // 已持有效会话却回退到登录页 → 直接送进工作台，避免「登录成功又看到登录页」的困惑
    if (auth.verifyAny(req)) {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end(), true;
    }
    return sendLoginPage(res), true;
  }

  return false;
}

function upstreamHeaders(req) {
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` };
  delete headers.authorization;
  if (headers.origin) headers.origin = `http://127.0.0.1:${UPSTREAM_PORT}`;
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

function startWeb() {
  launchToken = '';
  web = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(UPSTREAM_PORT), '--no-open'], {
    cwd: process.env.GW_WORKDIR || '/workspace', env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [web.stdout, web.stderr]) stream.on('data', chunk => {
    const text = chunk.toString();
    const match = text.match(/[?&]token=([^\s&]+)/);
    if (match) launchToken = match[1];
    process.stderr.write(`[dsh-web] ${text}`);
  });
  web.on('error', error => process.stderr.write(`[dsh-web] spawn error: ${error.message}\n`));
  web.on('exit', code => {
    process.stderr.write(`[dsh-web] exited ${code}${stopping ? '' : ', restarting'}\n`);
    web = null;
    if (!stopping) setTimeout(startWeb, 2000);
  });
}
startWeb();
fs.watchFile(PLUGIN_RELOAD_PATH, { interval: 1000 }, (current, previous) => {
  if (!stopping && current.mtimeMs !== previous.mtimeMs && web) {
    process.stderr.write('[dsh-web] plugin profile changed, reloading\n');
    web.kill('SIGTERM');
  }
});

const server = http.createServer(async (req, res) => {
  // 小程序后端与 WebUI 共用一个 Sealos 公网地址。保留前缀转发到容器内网关，
  // X-GW-Token 原样保留；该路径不要求浏览器 Basic Auth。
  if ((req.url || '').startsWith(API_PREFIX)) {
    const target = (req.url || '').slice(API_PREFIX.length) || '/';
    const headers = { ...req.headers, host: `127.0.0.1:${GATEWAY_PORT}` };
    const proxy = http.request({ hostname: '127.0.0.1', port: GATEWAY_PORT, method: req.method, path: target, headers }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('DSH gateway unavailable'); });
    req.pipe(proxy);
    return;
  }

  // 注意：req.url 可能是畸形值（裸代理扫描、OPTIONS *），解析失败时退回 '/'，
  // 否则这里抛异常会让整个 http server 崩溃。
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
  }

  // 品牌资源（登录页背景图等），从 PVC 读，可换肤不重建镜像
  if (url.pathname.startsWith('/branding/')) {
    return serveBranding(res, url.pathname);
  }

  // 登录/登出/会话状态/首次设置密码
  if (url.pathname.startsWith('/_eftik/')) {
    if (await handleAuthRoutes(req, res, url)) return;
  }

  // 鉴权：浏览器会话 Cookie 或 Basic Auth 任一通过即可。
  // 失败时按调用方形态分流，避免把 API 调用重定向到登录页：
  //   浏览器导航 → 302 到 /_eftik/login（或直接渲染登录页）
  //   其它       → 401 + WWW-Authenticate（保持既有契约，不破坏脚本/小程序）
  if (!authorized(req)) {
    if (auth.isBrowserRequest(req)) {
      // 已登录但 cookie 失效的情况用 302 更自然；未配置密码则直接渲染设置页
      if (!auth.isConfigured() || req.url === '/_eftik/login') return sendLoginPage(res);
      res.writeHead(302, { Location: '/_eftik/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DSH Workspace"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('请输入工作台访问密码');
  }
  // 已通过认证却停在登录页（例如手动回退）→ 直接送进工作台。
  // 注意：/branding/* 与 /_eftik/* 已在上面被接管，走到这里的只可能是 dsh 自身页面。
  if (url.pathname === '/_eftik/login') {
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (!launchToken) { res.writeHead(503, { 'Retry-After': 2 }); return res.end('DSH WebUI 正在启动'); }
  let target = req.url || '/';
  // ⚠️ 关键：不能改成「总是注入 token」。生产实测（0.6.18 第一版试错）证明
  // 上游 dsh web 每次拿到带 token 的请求都会「重新种 cookie + 303 /」，
  // 于是「总是注入」会变成 hop1(303)→hop2(303)→… 无限循环。
  // 必须保留「已有 dsh cookie 就跳过注入」这一步，让带上合法 cookie 的请求
  // 能直接落到 200。真正兜住死循环的是下面响应侧的条件补注入。
  const urlHasToken = /[?&]token=/.test(target);
  if (!hasDshCookie(req) && !urlHasToken) {
    target = target.includes('?')
      ? `${target}&token=${encodeURIComponent(launchToken)}`
      : `${target}?token=${encodeURIComponent(launchToken)}`;
  }
  const proxy = http.request({ hostname: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: target, headers: upstreamHeaders(req) }, upstream => {
    const status = upstream.statusCode || 502;
    const headers = { ...upstream.headers };
    // 这是防重定向死循环的关键兜底，不要删。
    // 上游 dsh web 鉴权失败时一律 303 到「不含 token 的 /」。若浏览器的 dsh cookie
    // 无效/过期，放行这个 location 就会变成「带脏 cookie 请求 → 303 / → 再带同一脏
    // cookie 请求 → 再 303 /」的死循环（实测 20 跳不收敛）。
    // 处理方式：3xx 且 location 指向本域却没有 token 时补上 token，让浏览器下一跳
    // 用 token 换到合法 cookie。
    //
    // 关键约束 — 不能无条件补，否则会自己造一个新循环：
    //   补成 /?token=X → 上游认 token、种合法 cookie、又 303 / → 我们再补 token → 又 /?token=X …
    // 因此仅当本次响应「没有下发新 cookie」时才补。上游一旦种下 cookie（set-cookie 存在），
    // 说明这一跳已经完成认证交接，后续 303 必须原样放行，浏览器才能正常落到首页。
    const issuedCookie = Boolean(headers['set-cookie']);
    if (!issuedCookie && status >= 300 && status < 400 && headers.location
        && !/[?&]token=/.test(headers.location)
        && !/^https?:\/\//i.test(headers.location)) {
      headers.location = headers.location.includes('?')
        ? `${headers.location}&token=${encodeURIComponent(launchToken)}`
        : `${headers.location}?token=${encodeURIComponent(launchToken)}`;
      process.stderr.write(`[web-proxy] 重定向补 token: ${headers.location}\n`);
    }
    // 场景：浏览器持有一个「名字像 dsh-auth-* 但已失效」的 cookie（例如 dsh web 重启后
    // launchToken 变了）。此时上面请求侧会因 hasDshCookie 为真而跳过注入，上游则直接
    // 回 401（不是 303），响应侧那条 3xx 兜底覆盖不到 → 用户被挡在门外。
    // 这里补一次：仅当「本次确实没注入 token」且「上游未下发 cookie」且「返回 401」时，
    // 用带了 token 的 URL 重新请求一次。带上 token 后上游会重新种合法 cookie 并 303，
    // 浏览器下一跳即可正常进入。带 token 的请求不会走这里（否则会无限重试）。
    const injectedToken = !urlHasToken && !hasDshCookie(req);
    // 只对无请求体的方法做重试。GET/HEAD 没有 body，可以直接换 URL 重发；
    // 其他方法（POST 等）的 body 已被上游消费掉，重发会丢数据甚至挂起，
    // 因此直接放行原始 401，由前端自己处理。Web UI 的鉴权跳转都是 GET，够用。
    const bodylessMethod = req.method === 'GET' || req.method === 'HEAD';
    if (status === 401 && bodylessMethod && !injectedToken && !issuedCookie) {
      const retryTarget = target.includes('?')
        ? `${target}&token=${encodeURIComponent(launchToken)}`
        : `${target}?token=${encodeURIComponent(launchToken)}`;
      process.stderr.write(`[web-proxy] 401 兜底重试（补 token）: ${retryTarget}\n`);
      // ⚠️ 这里 return 之前必须把原始请求体（GET 为空）落地，否则连接会一直挂着，
      // 客户端表现为超时（HTTP=000）。先 end 原始 proxy，再发重试请求。
      req.resume();
      proxy.destroy();
      const retry = http.request({ hostname: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: retryTarget, headers: upstreamHeaders(req) }, up2 => {
        const st2 = up2.statusCode || 502;
        const h2 = { ...up2.headers };
        const issued2 = Boolean(h2['set-cookie']);
        if (!issued2 && st2 >= 300 && st2 < 400 && h2.location
            && !/[?&]token=/.test(h2.location) && !/^https?:\/\//i.test(h2.location)) {
          h2.location = h2.location.includes('?')
            ? `${h2.location}&token=${encodeURIComponent(launchToken)}`
            : `${h2.location}?token=${encodeURIComponent(launchToken)}`;
        }
        res.writeHead(st2, h2);
        up2.pipe(res);
      });
      retry.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('DSH WebUI 暂不可用'); });
      retry.end();
      return;
    }
    res.writeHead(status, headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('DSH WebUI 暂不可用'); });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) return challenge(socket);
  const upstream = net.connect(UPSTREAM_PORT, '127.0.0.1', () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(upstreamHeaders(req))) lines.push(`${key}: ${value}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => process.stderr.write(`[web-proxy] listening on ${PUBLIC_PORT}\n`));

function shutdown() { stopping = true; fs.unwatchFile(PLUGIN_RELOAD_PATH); try { if (web) web.kill('SIGTERM'); } catch {} server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
