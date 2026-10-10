import fs from 'node:fs';
import { openRepo, repoId } from './core/repo.js';
import { GitError } from './core/git.js';
import { overview, branches, commits, activity, health } from './core/analyzer.js';
import { preflight, switchBranch, undoLast } from './core/safety.js';
import { listRepos, findRepo, upsertRepo, removeRepo, listLogs } from './core/store.js';
import { pickFolder, dialogSupported } from './core/dialog.js';
import { listDrives, startScan, getScan, cancelScan, publicJob, probeFolder } from './core/scanner.js';

function send(res, code, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 解析仓库：优先查已登记的列表，其次允许直接传绝对路径（便于 AI 调用） */
function resolveRepo(idOrPath) {
  const found = findRepo(idOrPath);
  if (found) return found;
  if (idOrPath && fs.existsSync(idOrPath)) return { id: repoId(idOrPath), path: idOrPath, name: idOrPath };
  return null;
}

function requireRepo(idOrPath) {
  const r = resolveRepo(idOrPath);
  if (!r) {
    const e = new Error(`未登记该仓库：${idOrPath}`);
    e.status = 404;
    throw e;
  }
  if (!fs.existsSync(r.path)) {
    const e = new Error(`仓库目录已不存在：${r.path}`);
    e.status = 410;
    throw e;
  }
  return r;
}

/**
 * API 层：只做参数解析 + 调用 core，不含任何业务逻辑。
 * 桌面端迁移时，这一层会被 IPC handler 替换，core 完全复用。
 */
export async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method || 'GET';
  const q = url.searchParams;

  // GET /api/health
  if (seg[0] === 'health') {
    return send(res, 200, { ok: true, name: 'git-manager', version: '0.1.0', time: new Date().toISOString() });
  }

  // GET /api/repos
  if (seg[0] === 'repos' && seg.length === 1 && method === 'GET') {
    const repos = listRepos().map((r) => ({ ...r, exists: fs.existsSync(r.path) }));
    return send(res, 200, { repos });
  }

  // POST /api/repos/open  { path }
  if (seg[0] === 'repos' && seg[1] === 'open' && method === 'POST') {
    const body = await readBody(req);
    const repo = await openRepo(body.path);
    upsertRepo(repo);
    return send(res, 200, { repo });
  }

  /* ---------------- 文件系统：只读探测 / 原生选择器 / 扫描 ---------------- */

  // GET /api/fs/drives
  if (seg[0] === 'fs' && seg[1] === 'drives' && method === 'GET') {
    return send(res, 200, { drives: listDrives(), dialogSupported });
  }

  // POST /api/fs/pick —— 弹出原生文件夹对话框（服务端执行，只回传路径）
  if (seg[0] === 'fs' && seg[1] === 'pick' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return send(res, 200, await pickFolder({ title: body.title || '选择一个文件夹', defaultPath: body.defaultPath }));
  }

  // POST /api/fs/probe  { path } —— 判定是否为仓库 / 是否在仓库内 / 有无子仓库
  if (seg[0] === 'fs' && seg[1] === 'probe' && method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, await probeFolder(body.path));
  }

  // POST /api/scan  { root, maxDepth } —— 启动只读扫描任务
  if (seg[0] === 'scan' && seg.length === 1 && method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, { job: publicJob(startScan(body.root, body)) });
  }
  // GET /api/scan/:id —— 轮询进度与结果
  if (seg[0] === 'scan' && seg.length === 2 && method === 'GET') {
    const job = getScan(seg[1]);
    if (!job) {
      const e = new Error('扫描任务不存在或已过期');
      e.status = 404;
      throw e;
    }
    return send(res, 200, { job: publicJob(job) });
  }
  // POST /api/scan/:id/cancel
  if (seg[0] === 'scan' && seg.length === 3 && seg[2] === 'cancel' && method === 'POST') {
    const job = cancelScan(seg[1]);
    if (!job) {
      const e = new Error('扫描任务不存在或已过期');
      e.status = 404;
      throw e;
    }
    return send(res, 200, { job: publicJob(job) });
  }

  // DELETE /api/repos/:id  —— 仅从列表移除，不触碰磁盘
  if (seg[0] === 'repos' && seg.length === 2 && method === 'DELETE') {
    removeRepo(seg[1]);
    return send(res, 200, { ok: true });
  }

  // 以下都需要 :id
  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = requireRepo(decodeURIComponent(seg[1]));
    const resource = seg[2];

    if (resource === 'log' && method === 'GET') {
      return send(res, 200, { logs: listLogs(repo.id, Number(q.get('limit')) || 100) });
    }

    if (method === 'GET' && resource === 'overview') return send(res, 200, await overview(repo));
    if (method === 'GET' && resource === 'branches') return send(res, 200, await branches(repo));
    if (method === 'GET' && resource === 'commits') return send(res, 200, { commits: await commits(repo, Number(q.get('limit')) || 40) });
    if (method === 'GET' && resource === 'activity') return send(res, 200, await activity(repo, Number(q.get('weeks')) || 12));
    if (method === 'GET' && resource === 'health') return send(res, 200, await health(repo));

    if (method === 'POST' && resource === 'preflight') {
      const body = await readBody(req);
      return send(res, 200, await preflight(repo, body.target));
    }
    if (method === 'POST' && resource === 'switch') {
      const body = await readBody(req);
      return send(res, 200, await switchBranch(repo, body));
    }
    if (method === 'POST' && resource === 'undo') {
      return send(res, 200, await undoLast(repo));
    }
  }

  const e = new Error(`未知接口：${method} ${url.pathname}`);
  e.status = 404;
  throw e;
}

export function errorPayload(err) {
  const status = err.status || (err instanceof GitError ? 400 : 500);
  return {
    status,
    payload: {
      error: true,
      message: err.message || '未知错误',
      stderr: err.stderr || undefined,
      preflight: err.preflight || undefined,
      snapshotRef: err.snapshotRef || undefined,
    },
  };
}
