const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PUBLIC_PORT = Number(process.env.GW_WEB_PORT || 8080);
const UPSTREAM_PORT = Number(process.env.GW_WEB_UPSTREAM_PORT || 3080);
const GATEWAY_PORT = Number(process.env.GW_PORT || 8090);
const API_PREFIX = '/_eftik/api';
const PASSWORD_PATH = process.env.GW_WEB_PASSWORD_PATH || '/home/node/.dsh/eftik-web-password.sha256';
const PLUGIN_RELOAD_PATH = process.env.GW_PLUGIN_RELOAD_PATH || '/home/node/.dsh/eftik-plugin-reload';
let launchToken = '';
let web = null;
let stopping = false;

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
  let expected = '';
  try { expected = fs.readFileSync(PASSWORD_PATH, 'utf8').trim(); } catch {}
  if (!expected) return false;
  const raw = String(req.headers.authorization || '');
  if (!raw.startsWith('Basic ')) return false;
  let password = '';
  try { password = Buffer.from(raw.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'); } catch {}
  const actual = crypto.createHash('sha256').update(password).digest('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function challenge(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DSH Workspace"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  socket.destroy();
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

const server = http.createServer((req, res) => {
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
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DSH Workspace"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('请输入工作台访问密码');
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
