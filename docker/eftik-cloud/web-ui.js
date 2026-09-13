const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWebAuth } = require('./web-auth');

const PUBLIC_PORT = Number(process.env.GW_WEB_PORT || 8080);
// 上游 dsh web 由网关（web-engine.js）独占拉起并监听这个端口，这里只反代
const UPSTREAM_PORT = Number(process.env.GW_WEB_UPSTREAM_PORT || 3080);
const GATEWAY_PORT = Number(process.env.GW_PORT || 8090);
// 容器内组件互调用的管理令牌（与网关同一个 env）
const GW_ADMIN_TOKEN = process.env.GW_ADMIN_TOKEN || '';
const API_PREFIX = '/_eftik/api';
const PASSWORD_PATH = process.env.GW_WEB_PASSWORD_PATH || '/home/node/.dsh/eftik-web-password.sha256';
// 网关写下的 dsh web launch token（进程归网关，这里只读）
const TOKEN_PATH = process.env.GW_WEB_TOKEN_PATH || '/home/node/.dsh/eftik-web-token';
// 登录页与品牌资源：容器内 /opt/gw/ 随镜像发布；背景图放 PVC 便于换肤不重建镜像
const LOGIN_HTML_PATH = process.env.GW_LOGIN_HTML || path.join(__dirname, 'login.html');
const BRANDING_DIR = process.env.GW_BRANDING_DIR || '/home/node/.dsh/branding';
let launchToken = '';
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

/* ---------- 浮动「退出登录 / 重置工作台」 ---------- */

// 工作台页面来自官方 @deepseek-ai/dsh npm 包，我们不改上游源码；而「退出」入口
// 必须在「已经进了工作台」时也能点到，所以只能在代理层往返回的 HTML 文档末尾
// 追加一段自包含的浮层。用纯 <a href> + 服务端 302，不依赖页面里的任何 JS 环境。
const LOGOUT_MARK = 'data-eftik-logout';
const LOGOUT_WIDGET = `
<div ${LOGOUT_MARK}>
  <style>
    [${LOGOUT_MARK}]{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:8px;align-items:center;
      font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    [${LOGOUT_MARK}] a{display:inline-flex;align-items:center;height:34px;padding:0 14px;border-radius:17px;
      font-size:13px;line-height:1;text-decoration:none;border:1px solid rgba(0,0,0,.10);
      background:rgba(255,255,255,.92);color:#3c3c43;box-shadow:0 2px 10px rgba(0,0,0,.12);
      -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);opacity:.6;
      transition:opacity .15s ease,transform .15s ease}
    [${LOGOUT_MARK}] a:hover{opacity:1;transform:translateY(-1px)}
    [${LOGOUT_MARK}] a.eftik-lo-primary{border-color:transparent;background:#f0763a;color:#fff}
    [${LOGOUT_MARK}] a.eftik-lo-deep{color:#8a8a8e}
    body[data-ds-dark-theme] [${LOGOUT_MARK}] a{background:rgba(48,48,52,.92);color:#e8e8ea;border-color:rgba(255,255,255,.14)}
    body[data-ds-dark-theme] [${LOGOUT_MARK}] a.eftik-lo-deep{color:#9a9aa0}
    @media (prefers-color-scheme:dark){
      [${LOGOUT_MARK}] a{background:rgba(48,48,52,.92);color:#e8e8ea;border-color:rgba(255,255,255,.14)}
      [${LOGOUT_MARK}] a.eftik-lo-deep{color:#9a9aa0}
    }
    @media (max-width:520px){[${LOGOUT_MARK}]{right:10px;bottom:10px}}
  </style>
  <a class="eftik-lo-deep" href="/_eftik/logout?deep=1&amp;wide=1"
     onclick="return confirm('重置工作台会重启 WebUI 会话，当前页面上正在跑的任务会中断。确定继续？')">重置工作台</a>
  <a class="eftik-lo-primary" href="/_eftik/logout">退出登录</a>
</div>
`;

/** 只有「浏览器导航拿到的 HTML 文档」才注入：GET + 200 + text/html 且未压缩 */
function isHtmlDocumentResponse(req, status, headers) {
  if (status !== 200 || req.method !== 'GET') return false;
  if (!/text\/html/i.test(String(headers['content-type'] || ''))) return false;
  // 请求侧已强制 identity 编码；万一上游仍压缩返回，宁可不注入也不能吐坏字节
  return !headers['content-encoding'];
}

/** 缓冲 HTML → 插入浮层 → 重算长度返回（长度变了，分块/压缩相关头必须清掉） */
function injectLogoutWidget(status, headers, upstream, res) {
  const chunks = [];
  upstream.on('data', (chunk) => chunks.push(chunk));
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('DSH WebUI 暂不可用'); });
  upstream.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8');
    if (!html.includes(LOGOUT_MARK)) {
      // 宿主 SPA 的引导脚本都在 <body> 内，追加在 </body> 之前不会打断 __DSH_BOOT__
      html = html.includes('</body>')
        ? html.replace('</body>', `${LOGOUT_WIDGET}</body>`)
        : html + LOGOUT_WIDGET;
    }
    const buf = Buffer.from(html, 'utf8');
    const out = { ...headers };
    delete out['content-encoding'];
    delete out['transfer-encoding'];
    out['content-length'] = String(buf.length);
    res.writeHead(status, out);
    res.end(buf);
  });
}

/**
 * 重启上游 dsh web：换掉 launchToken 与内核侧的 WebUI 会话（「重置工作台」用）。
 * ⚠️ 进程归网关所有，这里只发一个带内网令牌的内部请求，由平面 B 引擎真正执行重启。
 */
function restartWeb(reason) {
  if (!GW_ADMIN_TOKEN) {
    process.stderr.write('[web-proxy] 缺少 GW_ADMIN_TOKEN，无法请求重启 dsh web\n');
    return false;
  }
  const body = JSON.stringify({ reason: reason || 'web-ui' });
  const req = http.request({
    hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/internal/engine/restart-web', method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-gw-admin': GW_ADMIN_TOKEN,
    },
  }, (res) => { res.resume(); });
  req.on('error', (e) => process.stderr.write(`[web-proxy] 请求重启 dsh web 失败: ${e.message}\n`));
  req.end(body);
  launchToken = '';   // 新 token 由引擎写入文件，watchFile 会读回来
  return true;
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

  // 退出登录 / 清除登录缓存。GET 可直接在地址栏敲（进不去工作台时的兜底），
  // POST 供脚本与小程序调用（返回 JSON + 同样的 Set-Cookie）。
  //   ?deep=1  顺带重启上游 dsh web：换掉 launchToken 与内核侧 WebUI 会话
  //   ?wide=1  连父域（如 .sealosbja.site）上的同名 cookie 一起清
  //            —— 用于「打开过同品牌其它子域后被脏 cookie 挡住」的场景
  if (p === '/_eftik/logout' && (req.method === 'GET' || req.method === 'POST')) {
    let deep = url.searchParams.get('deep') === '1';
    let wide = url.searchParams.get('wide') === '1';
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body && body.deep === true) deep = true;
      if (body && body.wide === true) wide = true;
    }
    const cleared = auth.clearCookies(req, {
      host: String(req.headers.host || '').split(':')[0],
      wideDomain: wide,
    });
    if (deep) restartWeb('logout deep=1');
    const headers = { 'Set-Cookie': cleared };
    if (auth.isBrowserRequest(req)) {
      // 浏览器走整页跳转，看完登录页的提示文案再重登
      res.writeHead(302, { ...headers, Location: `/_eftik/login?cleared=${wide ? 'reset' : '1'}`, 'Cache-Control': 'no-store' });
      return res.end(), true;
    }
    return sendJson(res, 200, { ok: true, deep, wide, cleared: cleared.length }, headers), true;
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
  // 浏览器导航要的是 gzip/br，但我们要往 HTML 里注入浮动按钮，必须拿到明文再改。
  // 只对「Accept 含 text/html」的文档请求强制 identity；ESM 断言等资源请求
  //（Accept: */*）不受影响，压缩照旧。
  if (/text\/html/i.test(String(headers.accept || ''))) delete headers['accept-encoding'];
  if (headers.origin) headers.origin = `http://127.0.0.1:${UPSTREAM_PORT}`;
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

/* ---------- 上游 dsh web：进程归网关，本文件只读 token 做反代 ----------

   ⚠️ 为什么不再自己起 dsh web：平面 B 引擎（gateway.js + web-engine.js）需要独占这个进程。
   两个进程共享同一个 DSH_HOME 会争 session.lock —— 那正是历史上 already exists /
   already owned 那批 bug 的根因。所以「起进程 / 重启 / 插件档案热重载」全部归引擎，
   这里退化为纯反代：只从网关写下的 token 文件读 launch token。
*/
function readTokenFile() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t && t !== launchToken) {
      launchToken = t;
      process.stderr.write('[web-proxy] 已从 token 文件读到新的 launch token\n');
    }
  } catch {}
}
// 本地测试接缝：本机没有 dsh 二进制时，可用 GW_WEB_LAUNCH_TOKEN 直接给定 token。
if (process.env.GW_WEB_LAUNCH_TOKEN) launchToken = process.env.GW_WEB_LAUNCH_TOKEN;
readTokenFile();
fs.watchFile(TOKEN_PATH, { interval: 1000 }, () => readTokenFile());

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
    if (isHtmlDocumentResponse(req, status, headers)) {
      return injectLogoutWidget(status, headers, upstream, res);
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

function shutdown() { stopping = true; try { fs.unwatchFile(TOKEN_PATH); } catch {} server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
