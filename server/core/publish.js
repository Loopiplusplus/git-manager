import { git, gitOk, isSafeGithubUrl } from './git.js';
import { getToken, authStatus } from './auth.js';
import { createRepo, probeRepo, viewer } from './github.js';
import { authGitEnv } from './clone.js';
import { addLog } from './store.js';

/**
 * 本地仓库 → GitHub 的「提交并推送」。
 *
 * 这是本系统里**唯一会改变本地仓库提交历史**的路径，因此刻意做得比
 * Contents API 那条更重：必须显式提供提交信息、必须输入仓库名二次确认、
 * 提交前打一个 refs/gm/prepush/* 快照、全程写审计日志。
 *
 * 三条结构性安全约束（与 git 引擎的窄化校验配合）：
 *   1. 只推 origin，只推单个分支名 → 结构上排除了 force / mirror / all / tags。
 *   2. 远端地址必须是 https://github.com/owner/name —— 不允许把代码推到别处。
 *   3. 凭据走 GIT_CONFIG_COUNT 环境注入，不写进 .git/config、不进命令行。
 */

export class PublishError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PublishError';
    if (typeof extra === 'string') extra = { code: extra };
    this.status = extra.status || 400;
    this.code = extra.code || null;
    this.hint = extra.hint || null;
    this.stderr = extra.stderr || '';
  }
}

/* ---------------- 状态解析 ---------------- */

const STATUS_LABEL = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  T: '类型变更',
  '?': '未跟踪',
};

function labelFor(x, y) {
  if (x === '?' && y === '?') return '未跟踪';
  // 优先展示暂存区状态
  const code = x && x !== ' ' ? x : y;
  return STATUS_LABEL[code] || '已变更';
}

/** 解析 `git status --porcelain` 输出 */
export function parsePorcelain(raw) {
  const files = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    // 重命名会写成 "old -> new"，取新路径
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, '');
    files.push({
      path: p,
      code: `${x}${y}`,
      label: labelFor(x, y),
      staged: x !== ' ' && x !== '?',
      untracked: x === '?' && y === '?',
    });
  }
  return files;
}

/** 从远端地址里认领 owner/name（仅接受 github 形态） */
export function parseRemoteUrl(url) {
  if (!isSafeGithubUrl(url)) return null;
  const u = new URL(url);
  const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  return { owner: seg[0], name: seg[1].replace(/\.git$/, ''), httpsUrl: `https://github.com/${seg[0]}/${seg[1].replace(/\.git$/, '')}.git` };
}

/** 收集一个本地仓库的发布状态 */
export async function publishStatus(repoPath) {
  const [branchRes, headRes, remoteRes, statusRes, emailRes, nameRes] = await Promise.all([
    gitOk(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    gitOk(repoPath, ['remote', 'get-url', 'origin']),
    gitOk(repoPath, ['status', '--porcelain'], { timeout: 30000 }),
    gitOk(repoPath, ['config', 'user.email']),
    gitOk(repoPath, ['config', 'user.name']),
  ]);

  const branchRaw = branchRes.ok ? branchRes.out.trim() : '';
  const detached = !branchRaw || branchRaw === 'HEAD';
  const branch = detached ? 'main' : branchRaw;
  const hasCommits = headRes.ok && /\b[0-9a-f]{7,40}\b/.test(headRes.out);
  const headSha = hasCommits ? headRes.out.trim().split(/\s+/)[0] : null;

  const remoteUrl = remoteRes.ok ? remoteRes.out.trim() : '';
  const github = parseRemoteUrl(remoteUrl);

  const files = statusRes.ok ? parsePorcelain(statusRes.out) : [];
  const changes = {
    total: files.length,
    staged: files.filter((f) => f.staged).length,
    untracked: files.filter((f) => f.untracked).length,
    modified: files.filter((f) => !f.untracked && !f.staged).length,
    files: files.slice(0, 200),
    truncated: files.length > 200,
  };

  // 与远端比对的领先/落后（仅在远端引用已存在时才有意义）
  let ahead = null;
  let behind = null;
  if (github && hasCommits && !detached) {
    const r = await gitOk(repoPath, ['rev-list', '--count', '--left-right', `origin/${branch}...HEAD`], { timeout: 20000 });
    if (r.ok) {
      const m = r.out.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) {
        behind = Number(m[1]);
        ahead = Number(m[2]);
      }
    }
  }

  // git 提交身份：没配过 identity 时，commit 会直接失败，必须提前告诉用户
  const hasIdentity = emailRes.ok && !!emailRes.out.trim();

  const reasons = [];
  if (!hasCommits && changes.total === 0) reasons.push('这是一个空仓库：既没有提交，工作区也没有任何文件可提交。');

  return {
    branch,
    detached,
    hasCommits,
    headShort: headSha ? headSha.slice(0, 7) : null,
    remote: {
      exists: !!remoteUrl,
      url: remoteUrl || null,
      isGithub: !!github,
      owner: github?.owner || null,
      name: github?.name || null,
    },
    changes,
    ahead,
    behind,
    identity: {
      configured: hasIdentity,
      email: emailRes.ok ? emailRes.out.trim() || null : null,
      name: nameRes.ok ? nameRes.out.trim() || null : null,
    },
    canPublish: reasons.length === 0,
    reasons,
  };
}

/* ---------------- 执行发布 ---------------- */

function sanitizeRefPart(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'ref';
}

/**
 * 执行「提交并推送」。
 *
 * @param {string} repoPath
 * @param {object} opts
 * @param {'create'|'existing'} opts.mode
 * @param {string} [opts.repoName]   mode=create 时必填
 * @param {boolean} [opts.private]   mode=create 时使用
 * @param {string} [opts.description]
 * @param {string} [opts.owner]      mode=existing 时必填
 * @param {string} [opts.name]       mode=existing 时必填
 * @param {string} opts.message      提交信息（有改动或空仓库时必填）
 * @param {boolean} [opts.includeChanges=true] 是否把工作区改动一并提交
 * @param {string} [opts.branch]     目标分支，默认当前分支
 * @param {string} opts.confirm      必须等于目标仓库名（二次确认）
 */
export async function publish(repoPath, opts = {}) {
  const mode = opts.mode === 'existing' ? 'existing' : 'create';
  const includeChanges = opts.includeChanges !== false;
  const message = String(opts.message || '').trim();

  const before = await publishStatus(repoPath);

  const status = await authStatus().catch(() => null);
  if (!status?.connected) {
    throw new PublishError('还没有连接 GitHub。推送需要一个有效的授权。', { code: 'NOT_CONNECTED', status: 401 });
  }

  /* ---- 1. 先定出目标仓库名（纯参数校验，不碰网络） ---- */
  let owner;
  let name;

  if (mode === 'create') {
    name = String(opts.repoName || '').trim();
    if (!name) throw new PublishError('请填写要创建的仓库名', 'NO_NAME');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\./.test(name) || /^\.+$/.test(name)) {
      throw new PublishError('仓库名只能包含字母、数字、. _ -，且不能以 . 开头', 'BAD_NAME');
    }
  } else {
    owner = String(opts.owner || '').trim();
    name = String(opts.name || '').trim();
    const ok = (s) => /^[A-Za-z0-9._-]+$/.test(s) && !/^\.+$/.test(s);
    if (!ok(owner) || !ok(name)) throw new PublishError('目标仓库的 owner / name 不合法', 'BAD_TARGET');
  }

  // 二次确认：必须手打仓库名。放在任何网络调用之前 —— 这是防误操作的闸门，
  // 不该在确认失败时还先去打一通 GitHub API。
  const confirm = String(opts.confirm || '').trim();
  if (confirm !== name) {
    throw new PublishError(`确认串不匹配：为避免误操作，请准确输入仓库名 ${name}`, { code: 'NO_CONFIRM', status: 400 });
  }

  /* ---- 2. 目标仓库的远端校验 ---- */
  if (mode === 'create') {
    const me = await viewer();
    owner = me?.login;
    if (!owner) throw new PublishError('无法读取当前 GitHub 账号', 'NO_VIEWER', 502);

    const token = await getToken().catch(() => null);
    const exists = await probeRepo(owner, name, { token }).catch(() => ({ known: false }));
    if (exists?.known && exists.exists) {
      throw new PublishError(
        `你名下已经存在同名仓库 ${owner}/${name}。请改用「推送到已有仓库」，或换一个名字。`,
        { code: 'ALREADY_EXISTS', status: 409 },
      );
    }
  } else {
    const token = await getToken().catch(() => null);
    const probe = await probeRepo(owner, name, { token }).catch(() => ({ known: false }));
    if (probe?.known && probe.exists === false) {
      throw new PublishError(`找不到仓库 ${owner}/${name}（或当前授权没有访问权限）`, { code: 'TARGET_NOT_FOUND', status: 404 });
    }
  }

  const targetUrl = `https://github.com/${owner}/${name}.git`;
  const steps = [];
  const started = Date.now();

  /* ---- 3. create 模式：先建远端仓库（空仓库，不带 auto_init） ---- */
  let created = false;
  if (mode === 'create') {
    try {
      await createRepo({ name, private: !!opts.private, description: opts.description || '' });
      created = true;
      steps.push({ step: 'create-repo', ok: true, detail: `已在 GitHub 创建 ${owner}/${name}` });
    } catch (e) {
      // 403 / 权限不足时给出可操作的提示，而不是一句“失败了”
      const hint = /scope|permission|403|Forbidden/i.test(e.message)
        ? '当前授权缺少创建仓库的权限。请用「读写」档位重新授权（需要 repo 权限），或在 GitHub 上手动建好空仓库后改用「推送到已有仓库」。'
        : null;
      throw new PublishError(`创建远端仓库失败：${e.message}`, { code: 'CREATE_FAILED', status: e.status || 502, hint });
    }
  }

  /* ---- 4. 提交前快照：把当前 HEAD 记到 refs/gm/prepush/*，随时可回退 ---- */
  let snapshotRef = null;
  if (before.hasCommits && before.headShort) {
    const ref = `refs/gm/prepush/${sanitizeRefPart(before.branch)}-${Date.now()}`;
    const r = await gitOk(repoPath, ['update-ref', ref, 'HEAD']);
    if (r.ok) snapshotRef = ref;
  }

  /* ---- 5. 提交工作区改动 ---- */
  let committed = false;
  let commitShort = null;
  if (includeChanges && before.changes.total > 0) {
    if (!message) throw new PublishError('有未提交的改动，请填写提交信息', 'NO_MESSAGE');
    if (message.length < 3) throw new PublishError('提交信息过短，请写清楚这次改了什么', 'SHORT_MESSAGE');

    try {
      await git(repoPath, ['add', '-A'], { timeout: 60000 });
    } catch (e) {
      throw new PublishError(`暂存改动失败：${e.stderr || e.message}`, { code: 'ADD_FAILED', status: 502, stderr: e.stderr });
    }

    const env = before.identity.configured ? null : await githubIdentityEnv();
    try {
      const out = await git(repoPath, ['commit', '-m', message], { timeout: 60000, ...(env ? { env } : {}) });
      committed = true;
      const m = out.match(/\[[^\]]*?([0-9a-f]{7,40})\]/);
      commitShort = m ? m[1].slice(0, 7) : null;
      steps.push({ step: 'commit', ok: true, detail: `已提交：${message.split('\n')[0]}` });
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      const hint = /Please tell me who you are|user\.email|user\.name/i.test(msg)
        ? 'git 还没配置提交身份。请运行 git config --global user.name "你的名字" 与 git config --global user.email "你的邮箱"，或先在 GitHub 上授权以便本系统代填。'
        : /nothing to commit/i.test(msg)
          ? '暂存后没有可提交的内容。'
          : null;
      throw new PublishError(`提交失败：${msg}`, { code: 'COMMIT_FAILED', status: 502, hint, stderr: msg });
    }
  } else if (!before.hasCommits) {
    throw new PublishError(
      '这个仓库还没有任何提交，没有东西可以推送。请先勾选「一并提交工作区改动」并填写提交信息。',
      { code: 'NO_COMMITS' },
    );
  } else {
    if (before.changes.total > 0) {
      steps.push({ step: 'commit', ok: false, detail: `按你的选择跳过提交，工作区仍有 ${before.changes.total} 项未提交改动` });
    }
  }

  /* ---- 6. 绑定 origin ---- */
  const hasOrigin = before.remote.exists;
  const sameUrl = before.remote.url === targetUrl;
  if (!hasOrigin) {
    await git(repoPath, ['remote', 'add', 'origin', targetUrl]).catch((e) => {
      throw new PublishError(`添加远端失败：${e.stderr || e.message}`, { code: 'REMOTE_FAILED', status: 502 });
    });
    steps.push({ step: 'remote', ok: true, detail: `已绑定 origin → ${targetUrl}` });
  } else if (!sameUrl) {
    await git(repoPath, ['remote', 'set-url', 'origin', targetUrl]).catch((e) => {
      throw new PublishError(`更新远端地址失败：${e.stderr || e.message}`, { code: 'REMOTE_FAILED', status: 502 });
    });
    steps.push({ step: 'remote', ok: true, detail: `origin 已改指 ${targetUrl}（原为 ${before.remote.url}）` });
  } else {
    steps.push({ step: 'remote', ok: true, detail: 'origin 已指向目标仓库' });
  }

  /* ---- 7. 推送 ---- */
  const branch = String(opts.branch || before.branch).trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || /\.\./.test(branch)) {
    throw new PublishError(`分支名不合法：${branch}`, 'BAD_BRANCH');
  }

  const token = await getToken().catch(() => null);
  const env = authGitEnv(token);
  let pushOut = '';
  try {
    pushOut = await git(repoPath, ['push', '-u', 'origin', branch], { timeout: 5 * 60 * 1000, env });
    steps.push({ step: 'push', ok: true, detail: `已推送分支 ${branch}` });
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    let hint = null;
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      hint = '远端已有本地没有的提交（历史分叉）。若目标仓库是刚创建的，请确认创建时「没有」勾选自动生成 README —— 有初始提交的空仓库无法直接推入。';
    } else if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(msg)) {
      hint = '鉴权失败：推送需要「读写」档位的授权（repo 权限）。若当前是只读授权，请重新授权。';
    } else if (/lowSpeedLimit|timed out|timeout|CONNECT tunnel|Could not resolve|Failed to connect/i.test(msg)) {
      hint = '连不上 github.com 的 git 传输端点（API 域名与 git 域名是分开的，有些代理只放行 api.github.com）。';
    } else if (/protected branch|GH006/i.test(msg)) {
      hint = '目标分支受保护，当前账号没有直接推送权限。';
    }
    addLog({
      repoId: null,
      op: 'publish-push',
      source: 'github',
      target: `${owner}/${name}`,
      message: `推送失败：${msg.split('\n')[0]}`,
      ok: false,
    });
    throw new PublishError(`推送失败：${msg}`, { code: 'PUSH_FAILED', status: 502, hint, stderr: msg });
  }

  const entry = addLog({
    repoId: null,
    op: 'publish-push',
    source: 'github',
    target: `${owner}/${name}`,
    branch,
    path: null,
    message,
    commitShort,
    created,
    snapshotRef,
    ok: true,
  });

  return {
    ok: true,
    owner,
    name,
    url: targetUrl,
    branch,
    webUrl: `https://github.com/${owner}/${name}`,
    created,
    committed,
    commitShort,
    snapshotRef,
    pushed: true,
    includeChanges,
    skippedChanges: !includeChanges && before.changes.total > 0 ? before.changes.total : 0,
    steps,
    tookMs: Date.now() - started,
    log: String(pushOut).trim().split('\n').filter(Boolean).slice(-4).join('\n'),
    logId: entry.id,
  };
}

/**
 * 仓库没配 git 身份时，用已连接的 GitHub 账号顶替（通过环境变量，不写任何配置文件）。
 * 调用方已确认该仓库「没有」配置 user.email，才会走到这里。
 */
async function githubIdentityEnv() {
  const me = await viewer().catch(() => null);
  if (!me?.login) return null;
  const id = me.id || 0;
  const name = me.name || me.login;
  const mail = `${id}+${me.login}@users.noreply.github.com`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: mail,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: mail,
  };
}
