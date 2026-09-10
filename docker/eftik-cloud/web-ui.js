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
  if (!launchToken) { res.writeHead(503, { 'Retry-After': '2' }); return res.end('DSH WebUI 正在启动'); }
  let target = req.url || '/';
  if (target === '/' && !req.headers.cookie) target = `/?token=${encodeURIComponent(launchToken)}`;
  const proxy = http.request({ hostname: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: target, headers: upstreamHeaders(req) }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
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
