import path from 'node:path';
import { git, gitOk, GitError } from './git.js';
import { addLog, listLogs, updateLog } from './store.js';
import { gitDirHas } from './repo.js';
import { parseStatus } from './analyzer.js';
import { lines } from './util.js';

const SNAP_NS = 'refs/gm/snapshots';
const SAFE_BRANCH = /^[A-Za-z0-9._\/@-]{1,240}$/;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function gitDirOf(repoPath) {
  const r = await gitOk(repoPath, ['rev-parse', '--git-dir']);
  return r.ok ? path.resolve(repoPath, r.out.trim()) : path.join(repoPath, '.git');
}

/**
 * Preflight：切换前强制检查。
 * 这是整个安全模型里最关键的一步——不检查就切换，等于裸奔。
 */
export async function preflight(repo, target) {
  const p = repo.path;
  const name = String(target || '').trim();
  if (!name) throw new Error('缺少目标分支');
  if (!SAFE_BRANCH.test(name)) throw new Error('分支名包含非法字符');

  const checks = [];
  const warnings = [];
  const blockers = [];

  const gitDir = await gitDirOf(p);

  // 1. 当前状态
  const stRaw = await gitOk(p, ['status', '--porcelain=v2', '--branch']);
  const st = parseStatus(stRaw.ok ? stRaw.out : '');
  const current = st.head || null;

  // 2. 目标分支是否存在
  const exists = await gitOk(p, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  if (!exists.ok) {
    blockers.push({ id: 'target-missing', label: `本地不存在分支 ${name}`, detail: '可先基于远端创建，或切换其它分支' });
    checks.push({ id: 'target-exists', label: '目标分支存在', level: 'block', detail: '未找到' });
  } else {
    checks.push({ id: 'target-exists', label: '目标分支存在', level: 'ok', detail: name });
  }

  if (current === name) {
    blockers.push({ id: 'same-branch', label: `已经处于 ${name}，无需切换`, detail: '' });
  }

  // 3. detached HEAD
  const sym = await gitOk(p, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const detached = !sym.ok;
  if (detached) {
    blockers.push({ id: 'detached', label: '当前处于 detached HEAD', detail: '请先 git switch -c <name> 固化，再切换' });
    checks.push({ id: 'not-detached', label: '不在 detached HEAD', level: 'block', detail: 'detached' });
  } else {
    checks.push({ id: 'not-detached', label: '不在 detached HEAD', level: 'ok', detail: current || '' });
  }

  // 4. 进行中的变基 / 合并 / 拣选
  const inProgress = [
    gitDirHas(gitDir, 'rebase-merge', 'rebase-apply') ? 'rebase' : null,
    gitDirHas(gitDir, 'MERGE_HEAD') ? 'merge' : null,
    gitDirHas(gitDir, 'CHERRY_PICK_HEAD') ? 'cherry-pick' : null,
  ].filter(Boolean);
  if (inProgress.length) {
    blockers.push({ id: 'in-progress', label: `有进行中的 ${inProgress.join(' / ')}`, detail: '请先完成或中止' });
    checks.push({ id: 'no-in-progress', label: '无进行中的变基/合并', level: 'block', detail: inProgress.join('/') });
  } else {
    checks.push({ id: 'no-in-progress', label: '无进行中的变基/合并', level: 'ok', detail: '' });
  }

  // 5. 未被其它 worktree 占用
  const wtRaw = await gitOk(p, ['worktree', 'list', '--porcelain']);
  if (wtRaw.ok) {
    for (const block of wtRaw.out.split('\n\n')) {
      const wt = block.match(/^worktree (.+)$/m);
      const br = block.match(/^branch refs\/heads\/(.+)$/m);
      if (wt && br && br[1].trim() === name && path.resolve(wt[1].trim()) !== path.resolve(p)) {
        blockers.push({ id: 'worktree-locked', label: `分支被另一个工作树检出`, detail: wt[1].trim() });
        checks.push({ id: 'worktree-free', label: '分支未被其它工作树占用', level: 'block', detail: wt[1].trim() });
      }
    }
  }
  if (!checks.some((c) => c.id === 'worktree-free')) {
    checks.push({ id: 'worktree-free', label: '分支未被其它工作树占用', level: 'ok', detail: '' });
  }

  // 6. 工作区是否干净
  if (st.dirtyCount > 0) {
    warnings.push({
      id: 'dirty',
      label: `工作区有 ${st.dirtyCount} 处未提交改动`,
      detail: `${st.staged} 已暂存 · ${st.unstaged} 未暂存 · ${st.untracked} 未跟踪`,
    });
    checks.push({ id: 'clean', label: '工作区干净', level: 'warn', detail: `${st.dirtyCount} 处改动待处理` });
  } else {
    checks.push({ id: 'clean', label: '工作区干净', level: 'ok', detail: '' });
  }

  // 7. 未跟踪文件与目标分支的冲突（只有存在未跟踪文件时才计算）
  let untrackedConflicts = [];
  if (st.untracked > 0 && exists.ok) {
    const [othersRaw, treeRaw] = await Promise.all([
      gitOk(p, ['ls-files', '--others', '--exclude-standard']),
      gitOk(p, ['ls-tree', '-r', '--name-only', name]),
    ]);
    const tree = new Set(treeRaw.ok ? lines(treeRaw.out) : []);
    if (tree.size) {
      untrackedConflicts = (othersRaw.ok ? lines(othersRaw.out) : []).filter((f) => tree.has(f));
    }
    if (untrackedConflicts.length) {
      const detail = untrackedConflicts.slice(0, 5).join('、') + (untrackedConflicts.length > 5 ? ` 等 ${untrackedConflicts.length} 个` : '');
      warnings.push({ id: 'untracked-conflict', label: `会覆盖 ${untrackedConflicts.length} 个未跟踪文件`, detail });
      checks.push({ id: 'no-untracked-conflict', label: '无未跟踪文件冲突', level: 'warn', detail });
    } else {
      checks.push({ id: 'no-untracked-conflict', label: '无未跟踪文件冲突', level: 'ok', detail: '' });
    }
  } else {
    checks.push({ id: 'no-untracked-conflict', label: '无未跟踪文件冲突', level: 'ok', detail: '' });
  }

  return {
    target: name,
    current,
    ok: blockers.length === 0,
    dirty: { count: st.dirtyCount, staged: st.staged, unstaged: st.unstaged, untracked: st.untracked },
    checks,
    warnings,
    blockers,
    untrackedConflicts,
    suggestions: st.dirtyCount > 0 ? ['snapshot', 'commit', 'abort'] : ['direct'],
  };
}

export { SNAP_NS };

async function createSnapshot(repo, target) {
  const p = repo.path;
  const msg = `gm-snapshot: before switch to ${target}`;
  const push = await git(p, ['stash', 'push', '-u', '-m', msg]);
  const shaRaw = await gitOk(p, ['rev-parse', 'stash@{0}']);
  if (!shaRaw.ok) throw new Error('快照创建失败：无法解析 stash 提交');
  const sha = shaRaw.out.trim();
  const ref = `${SNAP_NS}/${stamp()}`;
  await git(p, ['update-ref', ref, sha]);
  // 从 stash 栈里摘掉，避免污染用户的 stash 列表（对象由我们的 ref 保住）
  const drop = await gitOk(p, ['stash', 'drop', 'stash@{0}']);
  return { ref, sha, pushOutput: push.trim(), dropped: drop.ok };
}

async function restoreSnapshot(repo, ref) {
  return git(repo.path, ['stash', 'apply', ref]);
}

/**
 * 安全切换分支。
 * strategy: 'direct'（工作区已干净）| 'snapshot' | 'commit' | 'abort'
 */
export async function switchBranch(repo, { target, strategy = 'snapshot', message } = {}) {
  const pf = await preflight(repo, target);
  if (!pf.ok) {
    const err = new Error(`存在阻塞项：${pf.blockers.map((b) => b.label).join('；')}`);
    err.preflight = pf;
    throw err;
  }

  const from = pf.current;
  let snapshotRef = null;
  let committed = null;

  if (pf.dirty.count > 0) {
    if (strategy === 'abort') {
      const err = new Error('工作区有未提交改动，已按你的选择取消切换');
      err.preflight = pf;
      throw err;
    }
    if (strategy === 'commit') {
      const msg = String(message || '').trim() || `chore: 切换分支前保存 (${stamp()})`;
      await git(repo.path, ['add', '-A']);
      const c = await gitOk(repo.path, ['commit', '-m', msg]);
      if (!c.ok) {
        const err = new Error(`提交失败：${c.err?.stderr || '未知原因'}`);
        err.preflight = pf;
        throw err;
      }
      committed = msg;
    } else {
      const snap = await createSnapshot(repo, target);
      snapshotRef = snap.ref;
    }
  }

  // 真正切换：绝不带 --force
  const sw = await gitOk(repo.path, ['switch', target]);
  if (!sw.ok) {
    // 切换失败 → 尽力把快照恢复回工作区，保证改动不丢
    let restored = false;
    if (snapshotRef) {
      const r = await gitOk(repo.path, ['stash', 'apply', snapshotRef]);
      restored = r.ok;
    }
    const err = new Error(`切换失败：${sw.err?.stderr || '未知原因'}${snapshotRef ? (restored ? '（已自动恢复快照到工作区）' : '（快照已保留，可手动恢复）') : ''}`);
    err.preflight = pf;
    err.snapshotRef = snapshotRef;
    throw err;
  }

  // 校验
  const nowSym = await gitOk(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const nowBranch = nowSym.ok ? nowSym.out.trim() : null;
  const stNow = parseStatus((await gitOk(repo.path, ['status', '--porcelain=v2', '--branch'])).out || '');
  const verified = nowBranch === target;

  const entry = addLog({
    repoId: repo.id,
    repoPath: repo.path,
    op: 'switch',
    from,
    to: target,
    strategy: pf.dirty.count > 0 ? strategy : 'direct',
    snapshotRef,
    committed,
    result: verified ? 'ok' : 'unverified',
    rollbackHint: snapshotRef
      ? `git switch ${from} && git stash apply ${snapshotRef}`
      : `git switch ${from}`,
  });

  return {
    ok: true,
    verified,
    from,
    to: target,
    snapshotRef,
    committed,
    workingTreeClean: stNow.dirtyCount === 0,
    logId: entry.id,
    rollbackHint: entry.rollbackHint,
    warnings: pf.warnings,
  };
}

/** 撤销上一次切换 */
export async function undoLast(repo) {
  const logs = listLogs(repo.id, 200);
  const last = logs.find((l) => l.op === 'switch' && !l.undone);
  if (!last) throw new Error('没有可撤销的切换操作');

  const sw = await gitOk(repo.path, ['switch', last.from]);
  if (!sw.ok) throw new Error(`撤销失败：${sw.err?.stderr || '未知原因'}`);

  let restored = false;
  if (last.snapshotRef) {
    const r = await gitOk(repo.path, ['stash', 'apply', last.snapshotRef]);
    restored = r.ok;
    if (!r.ok && r.err) {
      const e = new Error(`已切回 ${last.from}，但快照恢复失败：${r.err.stderr || '未知原因'}`);
      e.partial = true;
      throw e;
    }
  }

  updateLog(last.id, { undone: true, undoneAt: new Date().toISOString() });
  addLog({
    repoId: repo.id,
    repoPath: repo.path,
    op: 'undo',
    from: last.to,
    to: last.from,
    result: restored || !last.snapshotRef ? 'ok' : 'partial',
    rollbackHint: '',
  });

  return { ok: true, from: last.to, to: last.from, restoredSnapshot: restored, undoneLogId: last.id };
}

export { GitError };
