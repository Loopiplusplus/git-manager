import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleApi, errorPayload } from './api.js';
import { gitVersion } from './core/git.js';
import { VERSION } from './core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? argv[portArg + 1] : process.env.GM_PORT || 4599);
const HOST = '127.0.0.1'; // 只绑定本机回环，不对外暴露

// 本机会话令牌：防止其它本机进程/恶意网页随意驱动 git 写操作
const TOKEN = crypto.randomBytes(24).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  if (url.pathname === '/gm-config.js') {
    const js = `window.__GM__ = ${JSON.stringify({ token: TOKEN, apiBase: '/api', version: VERSION })};`;
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(js);
    return true;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(WEB_DIR, rel);
  // 防目录穿越
  if (!target.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(target).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      // 令牌校验（同源页面才能拿到令牌；不发送 CORS 头，杜绝跨站读取）
      // 例外：头像代理要让 <img> 直接加载，而 <img> 无法带自定义请求头，
      // 因此只有这一个路由额外接受 ?t=<token>。其余一律只认请求头。
      const headerToken = req.headers['x-gm-token'];
      const queryToken = url.pathname === '/api/gh/avatar' ? url.searchParams.get('t') : null;
      const token = headerToken || queryToken;
      if (token !== TOKEN) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: true, message: '令牌无效' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      await handleApi(req, res, url);
      return;
    }

    if (serveStatic(req, res, url)) return;

    // SPA 兜底
    const indexFile = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      fs.createReadStream(indexFile).pipe(res);
      return;
    }
    res.writeHead(404).end('Not Found');
  } catch (err) {
    const { status, payload } = errorPayload(err);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify(payload));
  }
});

server.listen(PORT, HOST, async () => {
  const gv = await gitVersion();
  const url = `http://${HOST}:${PORT}/`;
  console.log('');
  console.log('  git-manager · 本地 Git 体检与维护中枢');
  console.log('  ─────────────────────────────────────────');
  console.log(`  运行中    ${url}`);
  console.log(`  服务地址  ${HOST}:${PORT}（仅本机可访问）`);
  console.log(`  git 版本  ${gv || '未检测到 git，请确认已加入 PATH'}`);
  console.log(`  缓存目录  ${path.join(ROOT, 'data')}`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请用 --port 指定其它端口。`);
    process.exit(1);
  }
  throw e;
});
