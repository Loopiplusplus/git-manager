import fs from 'node:fs';
import { openRepo, repoId } from './core/repo.js';
import { GitError } from './core/git.js';
import { overview, branches, commits, activity, health } from './core/analyzer.js';
import { preflight, switchBranch, undoLast } from './core/safety.js';
import { listRepos, findRepo, upsertRepo, removeRepo, listLogs, addLog } from './core/store.js';
import { pickFolder, dialogSupported } from './core/dialog.js';
import { listDrives, startScan, getScan, cancelScan, publicJob, probeFolder } from './core/scanner.js';
import { VERSION } from './core/util.js';
import {
  authStatus,
  startDeviceFlow,
  pollDeviceFlow,
  cancelDeviceFlow,
  setPat,
  logout,
  getClientId,
  SCOPE_PRESETS,
} from './core/auth.js';
import {
  rateLimit,
  listRepos as ghListRepos,
  getRepo as ghGetRepo,
  listBranches as ghListBranches,
  listCommits as ghListCommits,
  getContents as ghGetContents,
  previewChange,
  commitFile,
  deleteFile,
} from './core/github.js';
import { cloneRepo, parseRepoRef } from './core/clone.js';
import { probe as netProbe } from './core/netcheck.js';
import { putSecret, deleteSecret, vaultInfo } from './core/secrets.js';

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
    return send(res, 200, { ok: true, name: 'git-manager', version: VERSION, time: new Date().toISOString() });
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

  /* ---------------- GitHub：授权 ---------------- */

  // GET /api/gh/status
  if (seg[0] === 'gh' && seg[1] === 'status' && method === 'GET') {
    return send(res, 200, { ...(await authStatus()), scopePresets: SCOPE_PRESETS });
  }

  // POST /api/gh/client-id { clientId }
  if (seg[0] === 'gh' && seg[1] === 'client-id' && method === 'POST') {
    const body = await readBody(req);
    const cid = String(body.clientId || '').trim();
    if (!cid) return send(res, 400, { error: true, message: 'client_id 不能为空' });
    if (!/^[A-Za-z0-9]{10,64}$/.test(cid)) {
      return send(res, 400, { error: true, message: 'client_id 格式看起来不对（应为 20 位左右的字母数字串）' });
    }
    await putSecret('gh_client_id', cid);
    return send(res, 200, { ok: true, clientId: cid });
  }

  // DELETE /api/gh/client-id —— 只清 client_id，不动已授权的 token
  if (seg[0] === 'gh' && seg[1] === 'client-id' && method === 'DELETE') {
    deleteSecret('gh_client_id');
    return send(res, 200, { ok: true, vault: vaultInfo() });
  }

  // POST /api/gh/device/start { scopeMode }
  if (seg[0] === 'gh' && seg[1] === 'device' && seg[2] === 'start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return send(res, 200, { session: await startDeviceFlow({ scopeMode: body.scopeMode || 'write' }) });
  }

  // GET /api/gh/device/:id —— 轮询授权状态
  if (seg[0] === 'gh' && seg[1] === 'device' && seg.length === 3 && method === 'GET') {
    return send(res, 200, { session: await pollDeviceFlow(seg[2]) });
  }

  // POST /api/gh/device/:id/cancel
  if (seg[0] === 'gh' && seg[1] === 'device' && seg[3] === 'cancel' && method === 'POST') {
    return send(res, 200, cancelDeviceFlow(seg[2]));
  }

  // POST /api/gh/pat { token } —— 进阶：细粒度 PAT（权限比 OAuth 的 repo scope 更精确）
  if (seg[0] === 'gh' && seg[1] === 'pat' && method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, await setPat(body.token));
  }

  // POST /api/gh/logout
  if (seg[0] === 'gh' && seg[1] === 'logout' && method === 'POST') {
    return send(res, 200, await logout());
  }

  /* ---------------- GitHub：读取 ---------------- */

  // GET /api/gh/rate
  if (seg[0] === 'gh' && seg[1] === 'rate' && method === 'GET') {
    return send(res, 200, await rateLimit());
  }

  // GET /api/gh/repos?sort=&visibility=&q=&page=
  if (seg[0] === 'gh' && seg[1] === 'repos' && method === 'GET') {
    const repos = await ghListRepos({
      perPage: Number(q.get('perPage')) || 50,
      page: Number(q.get('page')) || 1,
      sort: q.get('sort') || 'pushed',
      visibility: q.get('visibility') || 'all',
      q: q.get('q') || '',
    });
    return send(res, 200, { repos });
  }

  // GET /api/gh/repo?owner=&name=
  if (seg[0] === 'gh' && seg[1] === 'repo' && seg.length === 2 && method === 'GET') {
    const owner = q.get('owner');
    const name = q.get('name');
    const [repo, brs, cms] = await Promise.all([
      ghGetRepo(owner, name),
      ghListBranches(owner, name).catch(() => []),
      ghListCommits(owner, name, { perPage: 15 }).catch(() => []),
    ]);
    return send(res, 200, { repo, branches: brs, commits: cms });
  }

  // GET /api/gh/contents?owner=&name=&path=&ref=
  if (seg[0] === 'gh' && seg[1] === 'contents' && method === 'GET') {
    return send(res, 200, await ghGetContents(q.get('owner'), q.get('name'), { path: q.get('path') || '', ref: q.get('ref') || undefined }));
  }

  /* ---------------- GitHub：写（预演 → 确认 → 提交） ---------------- */

  // POST /api/gh/preview { owner, name, path, branch } —— 只读预演，拿乐观锁 sha
  if (seg[0] === 'gh' && seg[1] === 'preview' && method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, await previewChange(body));
  }

  // POST /api/gh/commit { owner, name, path, content, message, sha, branch, confirm }
  if (seg[0] === 'gh' && seg[1] === 'commit' && method === 'POST') {
    const body = await readBody(req, 4 * 1024 * 1024);

    // 二次确认：必须把仓库名原样再写一遍，避免误触直接推到远端
    if (body.confirm !== body.name) {
      const e = new Error('二次确认未通过：请输入仓库名以确认这次提交');
      e.status = 400;
      e.code = 'NO_CONFIRM';
      throw e;
    }

    const r = await commitFile(body);
    const entry = addLog({
      repoId: null,
      source: 'github',
      op: r.noop ? 'gh-noop' : 'gh-commit',
      target: `${body.owner}/${body.name}`,
      path: r.path,
      action: r.action || null,
      commitShort: r.commitShort || null,
      message: String(body.message || '').slice(0, 200),
      result: 'ok',
      rollbackHint: r.commitUrl ? `在 GitHub 上 revert ${r.commitShort}` : null,
    });
    return send(res, 200, { ...r, logId: entry.id });
  }

  // POST /api/gh/delete { owner, name, path, message, sha, branch, confirm }
  if (seg[0] === 'gh' && seg[1] === 'delete' && method === 'POST') {
    const body = await readBody(req);
    if (body.confirm !== body.name) {
      const e = new Error('二次确认未通过：请输入仓库名以确认这次删除');
      e.status = 400;
      e.code = 'NO_CONFIRM';
      throw e;
    }
    const r = await deleteFile(body);
    const entry = addLog({
      repoId: null,
      source: 'github',
      op: 'gh-delete',
      target: `${body.owner}/${body.name}`,
      path: r.path,
      commitShort: r.commitShort || null,
      message: String(body.message || '').slice(0, 200),
      result: 'ok',
      rollbackHint: r.commitUrl ? `在 GitHub 上 revert ${r.commitShort}` : null,
    });
    return send(res, 200, { ...r, logId: entry.id });
  }

  // GET /api/gh/log —— GitHub 侧写操作的审计日志
  if (seg[0] === 'gh' && seg[1] === 'log' && method === 'GET') {
    const all = listLogs(null, 500).filter((l) => l.source === 'github');
    return send(res, 200, { logs: all.slice(0, Number(q.get('limit')) || 100) });
  }

  /* ---------------- GitHub：克隆到本地 ---------------- */

  // POST /api/gh/parse { url } —— 先解析地址，让前端能预览将要发生什么
  if (seg[0] === 'gh' && seg[1] === 'parse' && method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, parseRepoRef(body.url));
  }

  // POST /api/gh/clone { url, parentDir, dirName }
  if (seg[0] === 'gh' && seg[1] === 'clone' && method === 'POST') {
    const body = await readBody(req);
    const r = await cloneRepo(body);
    addLog({
      repoId: r.repo?.id || null,
      source: 'github',
      op: 'gh-clone',
      target: `${r.owner}/${r.name}`,
      to: r.target,
      result: 'ok',
      usedAuth: r.usedAuth,
    });
    if (r.repo) upsertRepo(r.repo);
    return send(res, 200, r);
  }

  /* ---------------- 网络自检 ---------------- */

  // GET /api/net/probe —— DNS + TCP 探测 GitHub 各域名，不携带凭据
  if (seg[0] === 'net' && seg[1] === 'probe' && method === 'GET') {
    return send(res, 200, await netProbe());
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
      code: err.code || undefined,
      detail: err.detail || undefined,
      stderr: err.stderr || undefined,
      preflight: err.preflight || undefined,
      snapshotRef: err.snapshotRef || undefined,
      leftover: err.leftover || undefined,
    },
  };
}
