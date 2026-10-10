import path from 'node:path';
import { git, gitOk, GitError, assertBranchName } from './git.js';
import { addLog, listLogs, updateLog } from './store.js';
import { gitDirHas } from './repo.js';
import { parseStatus } from './analyzer.js';
import { lines } from './util.js';

const SNAP_NS = 'refs/gm/snapshots';
const SAFE_BRANCH = /^[A-Za-z0-9._\/@-]{1,240}$/;
/** for-each-ref 的字段分隔符（与 analyzer.js 同一约定，够怪就不会撞上真实内容） */
const SEP_F = '|~|';

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

/* ============================================================================
 *  分支的增与删
 * ============================================================================
 *
 *  之前这两个能力**压根不存在** —— 引擎层的 `branch` 走通用 flag 黑名单，
 *  `-d`/`-D` 被整条熔断，所以「新建分支」和「删除分支」在界面上无从做起。
 *  现在按 push/remote 的同一思路，在引擎层开出固定形态的白名单（见 git.js#assertSafeBranch），
 *  这里只负责编排与安全兜底。
 *
 *  删除的设计要点：**删之前先把分支尖端存进 refs/gm/deleted/**。
 *  git 删分支只删指针，提交本身还在，但指针一没就找不到入口了 ——
 *  存进自定义命名空间后，「恢复分支」就只是一次 `git branch <name> <ref>`。
 *  这也是本项目一贯的做法：写操作必须可回滚，不能只靠「你确定吗」。
 * ========================================================================== */

const DELETED_NS = 'refs/gm/deleted';

/** 分支名 → 可安全放进 ref 路径的片段（git ref 不允许 `..`，且分支名可能含 `/`） */
function refSafeName(name) {
  return String(name).replace(/\//g, '__').replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 120);
}

async function revCount(repoPath, spec) {
  const r = await gitOk(repoPath, ['rev-list', '--count', ...spec]);
  if (!r.ok) return null;
  const n = Number(r.out.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 删除分支前的**只读**评估。界面上先展示这些，再让用户决定 ——
 * 而不是弹一个「确定吗？」就把决定权推给用户。
 */
export async function branchRemovalPrecheck(repo, name) {
  const p = repo.path;
  const target = assertBranchName(name);

  const local = await gitOk(p, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const all = local.ok ? lines(local.out) : [];

  const headSym = await gitOk(p, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = headSym.ok ? headSym.out.trim() : null;

  const exists = all.includes(target);
  const isCurrent = current === target;
  const isOnly = all.length <= 1;

  let sha = null;
  let subject = null;
  let date = null;
  let upstream = '';
  if (exists) {
    const info = await gitOk(p, [
      'for-each-ref',
      `--format=%(objectname:short)${SEP_F}%(subject)${SEP_F}%(committerdate:iso-strict)${SEP_F}%(upstream:short)`,
      `refs/heads/${target}`,
    ]);
    if (info.ok && info.out.trim()) {
      [sha, subject, date, upstream] = info.out.trim().split(SEP_F);
    }
  }

  // 相对当前分支有多少提交会失去入口（0 = 已合并，删了不丢东西）
  const unmerged = exists && !isCurrent ? await revCount(p, [target, '--not', 'HEAD']) : 0;

  // 远端是否有同名分支 —— 说明删掉的只是本地副本，不吓人；反之要提醒
  const remoteSameName = (await gitOk(p, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${target}`])).ok;

  // 是否已被某个工作树占用（占用时 git 会直接拒绝，提前告知比报错友好）
  // ★ 必须排除「本仓库自己」的检出：`worktree list` 会把当前工作树也算进来，
  //   不排除的话分支只要是被检出的那个就会被误判成 locked
  //   （preflight / analyzer 都做了这个排除，这里最初漏了）。
  const wt = await gitOk(p, ['worktree', 'list', '--porcelain']);
  let lockedBy = null;
  if (wt.ok) {
    for (const block of wt.out.split('\n\n')) {
      const w = block.match(/^worktree (.+)$/m);
      const b = block.match(/^branch refs\/heads\/(.+)$/m);
      if (!w || !b || b[1].trim() !== target) continue;
      const wtPath = w[1].trim();
      if (path.resolve(wtPath) !== path.resolve(p)) lockedBy = wtPath;
    }
  }

  const blockers = [];
  if (!exists) blockers.push({ id: 'not-found', label: '分支不存在' });
  if (isCurrent) blockers.push({ id: 'is-current', label: `正检出于 ${target}，git 不允许删除当前分支（先切到别的分支）` });
  if (isOnly) blockers.push({ id: 'is-only', label: '这是仓库里唯一的本地分支，删掉会让仓库失去 HEAD 指向' });
  if (lockedBy) blockers.push({ id: 'locked', label: `被工作树占用：${lockedBy}` });

  return {
    name: target,
    exists,
    isCurrent,
    isOnly,
    isRepoEmpty: all.length === 0,
    sha,
    subject,
    date,
    upstream: upstream || '',
    unmerged, // null 表示拿不到
    remoteSameName,
    lockedBy,
    branchCount: all.length,
    otherBranches: all.filter((b) => b !== target),
    ok: blockers.length === 0,
    blockers,
    // -d 由 git 自己把关：未合并时它会拒绝。所以「有未合并提交」不是 blocker，只是一条要提醒的事实。
    needsForce: unmerged === null ? true : unmerged > 0,
  };
}

/**
 * 新建分支。L1（可回滚写）：只是多一个指针，没有任何东西被覆盖。
 */
export async function createBranch(repo, { name, from } = {}) {
  const p = repo.path;
  const target = assertBranchName(name);
  const start = from ? assertBranchName(from, '起点') : null;

  const existing = await gitOk(p, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
  if (existing.ok) {
    const err = new Error(`分支 ${target} 已存在`);
    err.status = 400;
    throw err;
  }

  if (start) {
    const fromOk = await gitOk(p, ['show-ref', '--verify', '--quiet', `refs/heads/${start}`]);
    if (!fromOk.ok) {
      const err = new Error(`起点分支不存在：${start}`);
      err.status = 400;
      throw err;
    }
  }

  const args = start ? ['branch', target, start] : ['branch', target];
  const r = await gitOk(p, args);
  if (!r.ok) {
    const err = new Error(`新建分支失败：${r.err?.stderr || '未知原因'}`);
    err.status = 400;
    throw err;
  }

  const head = await gitOk(p, ['rev-parse', '--short', target]);
  const entry = addLog({
    repoId: repo.id,
    repoPath: p,
    op: 'branch-create',
    name: target,
    from: start || (await currentBranch(p)),
    sha: head.ok ? head.out.trim() : null,
    result: 'ok',
    rollbackHint: `git branch -d ${target}`,
  });

  return {
    ok: true,
    name: target,
    from: entry.from,
    sha: entry.sha,
    logId: entry.id,
    rollbackHint: entry.rollbackHint,
  };
}

async function currentBranch(repoPath) {
  const r = await gitOk(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

/**
 * 删除分支。
 *
 * 两道门：
 *   1. `-d`（非强制）—— 交给 git 拒绝未合并分支，这是第二道防线，别自己实现去替代它；
 *   2. `-D`（强制）—— 必须 `confirm === name` 才放行，且**校验先于任何 git 调用**。
 *      这条顺序很重要：确认串错了就不该已经动过仓库。
 */
export async function deleteBranch(repo, { name, force = false, confirm } = {}) {
  const p = repo.path;
  const target = assertBranchName(name);

  // ★ 二次确认串校验放在最前面，早于快照与任何 git 写操作
  if (force && String(confirm ?? '') !== target) {
    const err = new Error(`强制删除需要二次确认：请原样输入分支名 ${target}`);
    err.status = 400;
    err.code = 'NO_CONFIRM';
    throw err;
  }

  const pre = await branchRemovalPrecheck(repo, target);
  if (!pre.ok) {
    const err = new Error(`无法删除：${pre.blockers.map((b) => b.label).join('；')}`);
    err.status = 400;
    err.precheck = pre;
    throw err;
  }

  // ★ 先把尖端存进自定义命名空间 —— 否则指针一删，提交就找不回来了
  const ts = stamp();
  const snapshotRef = `${DELETED_NS}/${refSafeName(target)}-${ts}`;
  let refCreated = false;
  if (pre.sha) {
    const full = await gitOk(p, ['rev-parse', target]);
    if (full.ok) {
      const mk = await gitOk(p, ['update-ref', snapshotRef, full.out.trim()]);
      if (!mk.ok) throw new Error(`无法为删除操作建立回滚点：${mk.err?.stderr || '未知原因'}`);
      refCreated = true;
    }
  }

  const flag = force ? '-D' : '-d';
  const del = await gitOk(p, ['branch', flag, target]);
  if (!del.ok) {
    // 删除没成功 → 分支尖端没变，刚建的回滚点就是多余的。清掉它，
    // 否则候选列表里会冒出一个「名字还在」的幽灵删除点。
    // 这一步之所以安全，是因为 update-ref 被收窄到 refs/gm/** 之内（见 git.js）。
    if (refCreated) await gitOk(p, ['update-ref', '-d', snapshotRef]);

    const stderr = String(del.err?.stderr || '').trim();
    const err = new Error(
      force
        ? `强制删除失败：${stderr || '未知原因'}`
        : `删除被 git 拒绝：${stderr || '未知原因'}\n\n` +
          `该分支有未合并的提交，git 不会用 -d 删除它。分支保持原样，没有任何改动。\n` +
          `确认这些提交不再需要时，可以用「强制删除」—— 那时会先把分支尖端存入回滚点，随时可以恢复。`,
    );
    err.status = 400;
    err.code = force ? 'FORCE_DELETE_FAILED' : 'NOT_MERGED';
    throw err;
  }

  const entry = addLog({
    repoId: repo.id,
    repoPath: p,
    op: 'branch-delete',
    name: target,
    sha: pre.sha,
    unmerged: pre.unmerged,
    forced: !!force,
    snapshotRef,
    result: 'ok',
    rollbackHint: `git branch ${target} ${snapshotRef}`,
    rollback: { kind: 'branch-restore', name: target, ref: snapshotRef },
  });

  return {
    ok: true,
    name: target,
    sha: pre.sha,
    unmerged: pre.unmerged,
    forced: !!force,
    snapshotRef,
    logId: entry.id,
    rollbackHint: entry.rollbackHint,
    rollback: entry.rollback,
  };
}

/** 列出可恢复的已删除分支（来自 refs/gm/deleted） */
export async function listDeletedBranches(repo) {
  const r = await gitOk(repo.path, [
    'for-each-ref',
    `--format=%(refname)${SEP_F}%(objectname:short)${SEP_F}%(subject)${SEP_F}%(committerdate:iso-strict)`,
    DELETED_NS,
  ]);
  if (!r.ok) return [];

  const local = await gitOk(repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const alive = new Set(local.ok ? lines(local.out) : []);

  return lines(r.out)
    .map((l) => {
      const [ref, sha, subject, date] = l.split(SEP_F);
      const tail = String(ref).slice(DELETED_NS.length + 1);
      // 形如 <name>-<YYYYMMDDTHHMMSS>；名字里可能出现 `-`，所以从**最后一段**时间戳倒着切
      const m = tail.match(/^(.*)-(\d{8}T\d{6})$/);
      return {
        ref,
        name: m ? m[1].replace(/__/g, '/') : tail,
        sha,
        subject: subject || '',
        date: date || null,
        deletedAt: m ? m[2] : null,
        // 同名分支又存在了 → 不必再恢复
        restored: m ? alive.has(m[1].replace(/__/g, '/')) : false,
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** 恢复一个被删除的分支：`git branch <name> <refs/gm/deleted/...>` */
export async function restoreBranch(repo, { name, ref } = {}) {
  const p = repo.path;
  const target = assertBranchName(name);
  const source = String(ref || '');
  if (!source.startsWith(`${DELETED_NS}/`)) {
    const err = new Error(`只能从 ${DELETED_NS}/ 下恢复，收到：${source}`);
    err.status = 400;
    throw err;
  }

  const still = await gitOk(p, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
  if (still.ok) {
    const err = new Error(`分支 ${target} 已存在，无需恢复`);
    err.status = 400;
    throw err;
  }

  const r = await gitOk(p, ['branch', target, source]);
  if (!r.ok) {
    const err = new Error(`恢复失败：${r.err?.stderr || '未知原因'}`);
    err.status = 400;
    throw err;
  }

  addLog({
    repoId: repo.id,
    repoPath: p,
    op: 'branch-restore',
    name: target,
    from: source,
    result: 'ok',
    rollbackHint: `git branch -d ${target}`,
  });

  return { ok: true, name: target, ref: source };
}

/** 把 refs/gm/deleted 下的所有删除点列出来（含已被恢复的） */
export async function branchRemovalCandidates(repo) {
  const [deleted, branches] = await Promise.all([listDeletedBranches(repo), gitOk(repo.path, ['branch'])]);
  return {
    deleted,
    recoverable: deleted.filter((d) => !d.restored),
    localCount: branches.ok ? lines(branches.out).length : 0,
  };
}

export { GitError };
