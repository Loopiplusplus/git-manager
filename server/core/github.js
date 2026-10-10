import { getToken } from './auth.js';

/**
 * GitHub REST 客户端。
 *
 * 与 git 引擎一致的分层原则：这里只做「把 GitHub API 包成安全可用的动作」，
 * 不掺 HTTP 传输、不掺前端。
 *
 * 写操作（提交 / 删除）走 Contents API，因此**不需要本地 push 权限、不需要
 * 配置 git 凭据**——改动直接在 GitHub 侧生成一个提交。
 */

const API = 'https://api.github.com';
const UA = 'git-manager';

let fetchImpl = globalThis.fetch;
export function setFetchImpl(f) {
  fetchImpl = f || globalThis.fetch;
}

export class GhError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GhError';
    this.status = extra.status || 500;
    this.code = extra.code || null;
    this.detail = extra.detail || null;
  }
}

function bad(message, code, status = 400) {
  return new GhError(message, { code, status });
}

function assertRepoTuple(owner, name) {
  const ok = (s) => typeof s === 'string' && s.length > 0 && s.length < 120 && !/[/\\]/.test(s);
  if (!ok(owner) || !ok(name)) throw bad('仓库的 owner / name 不合法', 'BAD_REPO');
}

/** 仓库内路径安全校验：禁止绝对路径与回溯，避免越出仓库边界 */
export function assertSafePath(p) {
  const s = String(p ?? '');
  if (s.includes('\0')) throw bad('路径含非法字符', 'BAD_PATH');
  if (s.startsWith('/')) throw bad('路径不能以 / 开头', 'BAD_PATH');
  const parts = s.split('/');
  if (parts.some((x) => x === '..' || x === '.')) throw bad('路径不能包含 . 或 ..', 'BAD_PATH');
  return s;
}

async function ghFetch(path, { method = 'GET', body, token, accept, anonymous = false } = {}) {
  // anonymous=true 时不带鉴权头（用于公开仓库的存在性探测）
  const t = anonymous ? null : token || (await getToken());
  if (!t && !anonymous) {
    const e = new Error('还没有连接 GitHub，请先授权');
    e.status = 401;
    e.code = 'NO_TOKEN';
    throw e;
  }

  const res = await fetchImpl(API + path, {
    method,
    headers: {
      accept: accept || 'application/vnd.github+json',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      'x-github-api-version': '2022-11-28',
      'user-agent': UA,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const rateLimited = res.status === 403 && remaining === '0';
    let msg = data?.message || `GitHub 返回 HTTP ${res.status}`;
    if (res.status === 401) msg = '授权已失效，请重新连接 GitHub';
    if (rateLimited) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      msg = `GitHub 接口调用配额已用尽，将于 ${new Date(reset).toLocaleTimeString('zh-CN')} 恢复`;
    }
    if (res.status === 404) msg = `找不到资源（可能是仓库不存在，或当前授权没有访问权限）：${path}`;
    throw new GhError(msg, {
      status: res.status === 401 ? 401 : res.status === 404 ? 404 : res.status === 409 ? 409 : 502,
      // 关键：区分「配额用尽」与「真的不存在」，否则调用方无法判断该不该拦
      code: rateLimited ? 'RATE_LIMIT' : data?.error || (res.status === 404 ? 'NOT_FOUND' : null),
      detail: data?.errors || null,
    });
  }

  return { data, headers: res.headers };
}

/* ---------------- 只读 ---------------- */

export async function rateLimit() {
  const { data } = await ghFetch('/rate_limit');
  const c = data?.resources?.core || data?.rate || {};
  return { limit: c.limit, remaining: c.remaining, resetAt: c.reset ? new Date(c.reset * 1000).toISOString() : null };
}

export async function viewer() {
  const { data } = await ghFetch('/user');
  return data;
}

export async function listRepos({ page = 1, perPage = 50, sort = 'pushed', visibility = 'all', q = '' } = {}) {
  const per = Math.min(100, Math.max(1, Number(perPage) || 50));
  const { data } = await ghFetch(
    `/user/repos?per_page=${per}&page=${Math.max(1, Number(page) || 1)}&sort=${encodeURIComponent(sort)}&affiliation=owner,collaborator,organization_member`,
  );
  let repos = Array.isArray(data) ? data : [];
  if (visibility === 'private') repos = repos.filter((r) => r.private);
  else if (visibility === 'public') repos = repos.filter((r) => !r.private);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    repos = repos.filter(
      (r) => r.name.toLowerCase().includes(needle) || `${r.owner?.login}/${r.name}`.toLowerCase().includes(needle) || String(r.description || '').toLowerCase().includes(needle),
    );
  }
  return repos.map(shapeRepo);
}

export function shapeRepo(r) {
  return {
    id: r.id,
    owner: r.owner?.login || '',
    name: r.name,
    fullName: r.full_name,
    private: !!r.private,
    fork: !!r.fork,
    archived: !!r.archived,
    description: r.description || '',
    language: r.language || '',
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    watchers: r.watchers_count ?? 0,
    defaultBranch: r.default_branch || 'main',
    sizeKb: r.size ?? 0,
    pushedAt: r.pushed_at,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    htmlUrl: r.html_url,
    permissions: r.permissions ? { push: !!r.permissions.push, admin: !!r.permissions.admin } : null,
  };
}

export async function getRepo(owner, name) {
  assertRepoTuple(owner, name);
  const { data } = await ghFetch(`/repos/${owner}/${name}`);
  return shapeRepo(data);
}

/**
 * 克隆前的快速存在性探测。
 *
 * 为什么需要：git 直接 clone 一个不存在的仓库，要在传输层跟 GitHub 协商鉴权，
 * 实测要 9 秒以上才失败（网络差时更久），用户会以为卡死。
 * 走 API 判断只要 0.3 秒，且能给出精确原因。
 *
 * 返回 null 表示「问不出来」（无网络 / 配额用尽 / 其它错误），
 * 此时不拦截，交给 git 自己去试，避免误伤正常克隆。
 */
export async function probeRepo(owner, name, { token } = {}) {
  assertRepoTuple(owner, name);
  try {
    const { data } = await ghFetch(`/repos/${owner}/${name}`, token ? { token } : { anonymous: true });
    return { known: true, exists: true, private: !!data.private, repo: shapeRepo(data) };
  } catch (e) {
    // 明确的 404 才算「确认不存在」
    if (e.status === 404 && e.code !== 'RATE_LIMIT') {
      return { known: true, exists: false, private: null, repo: null };
    }
    // 其它情况一律视为「问不出来」：网络问题或匿名配额用尽。
    // 绝不能把「问不出来」当成「不存在」，否则会误拦用户的正常克隆。
    return {
      known: false,
      exists: null,
      reason: e.code === 'RATE_LIMIT' ? 'rate-limit' : e.status === 401 ? 'unauthorized' : 'error',
      message: e.message,
    };
  }
}

export async function listBranches(owner, name, { perPage = 100 } = {}) {
  assertRepoTuple(owner, name);
  const { data } = await ghFetch(`/repos/${owner}/${name}/branches?per_page=${Math.min(100, perPage)}`);
  return (Array.isArray(data) ? data : []).map((b) => ({
    name: b.name,
    sha: b.commit?.sha?.slice(0, 7) || '',
    protected: !!b.protected,
  }));
}

export async function listCommits(owner, name, { ref, perPage = 30, page = 1 } = {}) {
  assertRepoTuple(owner, name);
  const qs = new URLSearchParams({ per_page: String(Math.min(100, perPage)), page: String(Math.max(1, page)) });
  if (ref) qs.set('sha', ref);
  const { data } = await ghFetch(`/repos/${owner}/${name}/commits?${qs}`);
  return (Array.isArray(data) ? data : []).map((c) => ({
    sha: c.sha,
    short: c.sha?.slice(0, 7) || '',
    subject: (c.commit?.message || '').split('\n')[0],
    message: c.commit?.message || '',
    author: c.commit?.author?.name || c.author?.login || '未知',
    authorLogin: c.author?.login || null,
    avatar: c.author?.avatar_url || null,
    date: c.commit?.author?.date || null,
    verified: !!c.commit?.verification?.verified,
    url: c.html_url,
  }));
}

/** 列目录 / 取单文件元信息。返回统一结构，方便前端递归浏览。 */export async function getContents(owner, name, { path: p = '', ref } = {}) {
  assertRepoTuple(owner, name);
  const safe = assertSafePath(p);
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const { data } = await ghFetch(`/repos/${owner}/${name}/contents/${encodeURI(safe)}${qs}`);
  if (Array.isArray(data)) {
    return {
      kind: 'dir',
      path: safe,
      entries: data
        .map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type === 'dir' ? 'dir' : e.type === 'symlink' ? 'symlink' : 'file',
          size: e.size ?? 0,
          sha: e.sha,
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
    };
  }
  if (!data || typeof data !== 'object') throw bad('GitHub 返回了意外的内容结构', 'BAD_RESPONSE', 502);
  return {
    kind: 'file',
    path: data.path,
    name: data.name,
    size: data.size ?? 0,
    sha: data.sha,
    encoding: data.encoding,
    content: data.content ? Buffer.from(data.content, data.encoding || 'base64').toString('utf8') : '',
    binary: isProbablyBinary(data.content, data.encoding),
    htmlUrl: data.html_url,
    downloadUrl: data.download_url,
  };
}

function isProbablyBinary(base64, encoding) {
  if (encoding !== 'base64' || !base64) return false;
  // 只看前 800 字节里的 NUL 字节，判断是否二进制
  try {
    const head = Buffer.from(base64.replace(/\s/g, '').slice(0, 1200), 'base64');
    return head.includes(0);
  } catch {
    return false;
  }
}

/* ---------------- 写：预演 + 提交 ---------------- */

const MAX_EDIT_BYTES = 1024 * 1024; // 单文件 1MB 上限，避免把仓库当网盘用

/**
 * 提交前预演（只读）。
 * 返回远端当前状态，让前端能显示「即将覆盖什么」，并拿到乐观锁所需的 sha。
 */
export async function previewChange({ owner, name, path: p, branch } = {}) {
  assertRepoTuple(owner, name);
  const safe = assertSafePath(p);
  if (!safe) throw bad('请填写文件路径', 'BAD_PATH');

  const repo = await getRepo(owner, name);
  const targetBranch = branch || repo.defaultBranch;

  let current = null;
  let reason = null;
  try {
    const c = await getContents(owner, name, { path: safe, ref: targetBranch });
    if (c.kind === 'dir') throw bad('目标是一个目录，不能作为文件提交', 'IS_DIR');
    current = { sha: c.sha, size: c.size, content: c.binary ? null : c.content, binary: c.binary, path: c.path };
  } catch (e) {
    if (e.status === 404) reason = 'not-found';
    else throw e;
  }

  return {
    owner,
    name,
    branch: targetBranch,
    defaultBranch: repo.defaultBranch,
    path: safe,
    exists: !!current,
    reason,
    current,
    maxBytes: MAX_EDIT_BYTES,
    permissions: repo.permissions,
  };
}

/**
 * 真正提交。三道验证：
 * 1. sha 乐观锁 —— 用户看到的版本必须仍是远端当前版本，否则拒绝（防覆盖他人提交）。
 *    GitHub 侧也会校验 sha，这里是显式前置检查，只为给出清楚的错误信息。
 * 2. message 必填且不能是占位串。
 * 3. 体积上限。
 */
export async function commitFile({ owner, name, path: p, content, message, sha, branch, force = false } = {}) {
  assertRepoTuple(owner, name);
  const safe = assertSafePath(p);
  if (!safe) throw bad('请填写文件路径', 'BAD_PATH');

  const msg = String(message || '').trim();
  if (!msg) throw bad('提交信息不能为空', 'NO_MESSAGE');
  if (msg.length < 3) throw bad('提交信息过短，请写清楚这次改了什么', 'SHORT_MESSAGE');

  const body = String(content ?? '');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_EDIT_BYTES) throw bad(`文件体积 ${bytes} 字节，超过 ${MAX_EDIT_BYTES} 字节上限`, 'TOO_LARGE');

  // —— 验证 1：乐观锁 ——
  const cur = await getContents(owner, name, { path: safe, ref: branch || undefined }).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });

  if (cur && cur.kind === 'dir') throw bad('目标是一个目录', 'IS_DIR');

  const remoteSha = cur?.sha || null;
  const expected = sha || null;

  if (!force) {
    if (remoteSha && !expected) {
      throw new GhError(`远端已存在文件 ${safe}（sha ${remoteSha.slice(0, 7)}），但本次提交没有带上版本号。为避免覆盖，已拒绝。`, {
        status: 409,
        code: 'STALE_SHA',
      });
    }
    if (remoteSha && expected && remoteSha !== expected) {
      throw new GhError(
        `文件已被改动：你看到的是 ${String(expected).slice(0, 7)}，远端当前是 ${remoteSha.slice(0, 7)}。请刷新后重新确认。`,
        { status: 409, code: 'STALE_SHA' },
      );
    }
    if (!remoteSha && expected) {
      throw new GhError('远端该文件已不存在（可能已被删除），请刷新后重试', { status: 409, code: 'VANISHED' });
    }
  }

  if (cur && !cur.binary && cur.content === body && !force) {
    return { ok: true, noop: true, reason: '内容与远端完全一致，未产生提交', path: safe, branch: branch || null };
  }

  const payload = {
    message: msg,
    content: Buffer.from(body, 'utf8').toString('base64'),
    ...(remoteSha ? { sha: remoteSha } : {}),
    ...(branch ? { branch } : {}),
    ...(force ? {} : {}),
  };

  const { data } = await ghFetch(`/repos/${owner}/${name}/contents/${encodeURI(safe)}`, { method: 'PUT', body: payload });

  return {
    ok: true,
    noop: false,
    path: safe,
    action: remoteSha ? 'update' : 'create',
    branch: branch || null,
    commitSha: data?.commit?.sha || null,
    commitShort: data?.commit?.sha?.slice(0, 7) || null,
    commitUrl: data?.commit?.html_url || null,
    contentSha: data?.content?.sha || null,
    bytes,
  };
}

/** 删除远端文件（同样带 sha 乐观锁） */
export async function deleteFile({ owner, name, path: p, message, sha, branch } = {}) {
  assertRepoTuple(owner, name);
  const safe = assertSafePath(p);
  if (!safe) throw bad('请填写文件路径', 'BAD_PATH');

  const msg = String(message || '').trim();
  if (!msg || msg.length < 3) throw bad('提交信息不能为空且不少于 3 个字符', 'NO_MESSAGE');

  const cur = await getContents(owner, name, { path: safe, ref: branch || undefined }).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });
  if (!cur) throw bad('远端已不存在该文件', 'NOT_FOUND', 404);
  if (cur.kind === 'dir') throw bad('目标是一个目录，暂不支持删除目录', 'IS_DIR');
  if (!sha) throw bad('删除操作必须带上你看到的版本号（sha）', 'NO_SHA');
  if (cur.sha !== sha) {
    throw new GhError(`文件已变化：你看到的是 ${String(sha).slice(0, 7)}，远端当前是 ${cur.sha.slice(0, 7)}，请刷新后重试`, {
      status: 409,
      code: 'STALE_SHA',
    });
  }

  const { data } = await ghFetch(`/repos/${owner}/${name}/contents/${encodeURI(safe)}`, {
    method: 'DELETE',
    body: { message: msg, sha: cur.sha, ...(branch ? { branch } : {}) },
  });

  return {
    ok: true,
    path: safe,
    action: 'delete',
    commitSha: data?.commit?.sha || null,
    commitShort: data?.commit?.sha?.slice(0, 7) || null,
    commitUrl: data?.commit?.html_url || null,
  };
}

/* ---------------- 建仓（供「本地仓库推送到 GitHub」使用） ---------------- */

/** GitHub 仓库名规则：字母数字与 . _ -，不能以 . 开头，≤100 字符 */
export function assertRepoName(name) {
  const s = String(name ?? '').trim();
  if (!s) throw bad('请填写仓库名', 'BAD_NAME');
  if (s.length > 100) throw bad('仓库名过长（上限 100 字符）', 'BAD_NAME');
  if (!/^[A-Za-z0-9._-]+$/.test(s) || /^\./.test(s) || /^\.+$/.test(s)) {
    throw bad('仓库名只能包含字母、数字、. _ -，且不能以 . 开头', 'BAD_NAME');
  }
  return s;
}

/**
 * 在 GitHub 上新建一个仓库。
 * auto_init 默认 false —— 必须留空仓库，否则远端会先有一个初始提交，
 * 本地推送时会因历史不相关而被拒绝（non-fast-forward）。
 */
export async function createRepo({ name, description = '', private: isPrivate = false } = {}) {
  const safeName = assertRepoName(name);

  const { data } = await ghFetch('/user/repos', {
    method: 'POST',
    body: {
      name: safeName,
      description: String(description || '').slice(0, 350),
      private: !!isPrivate,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    },
  });

  return { ok: true, repo: shapeRepo(data) };
}

/* ---------------- 头像代理 ---------------- */

/**
 * 头像只在浏览器里直连 GitHub 域名，国内网络经常拿不到（DNS 污染 / 无代理），
 * 于是页面上的头像就一直是裂的。这里让**服务端代取**再回传字节：
 * 服务端通常能走系统代理，浏览器端就不必直连外部网络了。
 *
 * 只接受两种入参，且主机严格白名单，避免被当成 SSRF 跳板：
 *   - login=<登录名>  → 固定拼 https://github.com/<login>.png
 *   - url=<头像地址>   → 仅允许 GitHub 旗下头像主机
 */
const AVATAR_HOSTS = new Set([
  'avatars.githubusercontent.com',
  'github.com',
  'www.github.com',
  'secure.gravatar.com',
]);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function resolveAvatarUrl({ login, url, size = 160 } = {}) {
  if (login) {
    const l = String(login).trim();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(l)) throw bad('登录名不合法', 'BAD_LOGIN');
    const s = Math.min(Math.max(Number(size) || 160, 32), 460);
    return `https://github.com/${l}.png?size=${s}`;
  }
  if (url) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      throw bad('头像地址不合法', 'BAD_URL');
    }
    if (u.protocol !== 'https:') throw bad('头像地址必须是 https', 'BAD_PROTOCOL');
    if (!AVATAR_HOSTS.has(u.hostname.toLowerCase())) throw bad(`头像主机不在白名单：${u.hostname}`, 'BAD_HOST');
    return u.href;
  }
  throw bad('缺少 login 或 url 参数', 'NO_TARGET');
}

export async function fetchAvatar(input = {}) {
  const target = resolveAvatarUrl(input);
  let res;
  try {
    res = await fetchImpl(target, {
      redirect: 'follow',
      headers: { accept: 'image/*', 'user-agent': UA },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw bad(`取头像失败：${e.message}`, 'AVATAR_FETCH_FAILED', 502);
  }
  if (!res.ok) throw bad(`取头像失败：HTTP ${res.status}`, 'AVATAR_FAILED', 502);

  const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  if (!/^image\//.test(contentType)) throw bad('返回的内容不是图片', 'NOT_IMAGE', 502);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw bad('取到空图片', 'EMPTY_IMAGE', 502);
  if (buf.length > AVATAR_MAX_BYTES) throw bad('头像文件过大', 'TOO_BIG', 502);

  return { buffer: buf, contentType, bytes: buf.length, url: target };
}
