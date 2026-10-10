/**
 * 分支增删的闸门测试。
 *
 * 覆盖两个此前完全缺失的能力，以及一个真实的扫描 bug：
 *   1. `git branch` 的窄化白名单 —— 能不能写出来比「写出来再拦」更可靠；
 *   2. 新建 / 删除 / 恢复的端到端行为（真实 git 仓库，不是桩）；
 *   3. ★ 盘根做扫描根时的路径包含判定（`isInside('E:\\', …)` 曾恒为 false）。
 *   4. HTTP 路由顺序 —— `/branches/removal` 不能被 `/branches` 抢先匹配；
 *   5. 前端契约 —— renderBranches 必须真的渲染出三个 data-action。
 *
 * 【为什么必须有第 3 组】
 * 之前 `scripts/check-scan.mjs` 是探索性脚本（要外部手工起 4630 端口），
 * 盘根这个边界从来没被自动化覆盖过，所以「扫盘一个仓库都找不到」能溜到用户面前。
 * 这里直接把判定函数暴露出来做纯函数断言 —— 真实扫盘太慢，不适合放进回归。
 *
 * 数据一律指向临时目录（GM_DATA_DIR），不碰真实 data/store.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-branch-'));
process.env.GM_DATA_DIR = TMP;

const { assertSafe } = await import('../server/core/git.js');
const {
  createBranch,
  deleteBranch,
  branchRemovalPrecheck,
  branchRemovalCandidates,
  restoreBranch,
} = await import('../server/core/safety.js');
const { pathIsInside, withTrailingSep } = await import('../server/core/scanner.js');
const { listLogs } = await import('../server/core/store.js');
const views = await import('../web/js/views.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}
function accepts(name, args) {
  try {
    assertSafe(args);
    check(name, true);
  } catch (e) {
    check(name, false, e.message);
  }
}
function rejects(name, args, pattern) {
  try {
    assertSafe(args);
    check(name, false, '本应拒绝，却通过了');
  } catch (e) {
    check(name, pattern ? pattern.test(e.message) : true, pattern && !pattern.test(e.message) ? e.message : '');
  }
}
/** 直接跑原始 git（测试脚手架用，绕开引擎，用于准备夹具与核对现场） */
function raw(cwd, args) {
  return exec('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' });
}
async function branchExists(dir, name) {
  try {
    await raw(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}
async function tipOf(dir, name) {
  const { stdout } = await raw(dir, ['rev-parse', name]);
  return stdout.trim();
}

/* ================= 1. git 引擎：branch 窄化白名单 ================= */
console.log('[1] git 引擎：branch 只允许固定形态');
{
  accepts('允许 branch（列出本地分支）', ['branch']);
  accepts('允许 branch --format=… --merged（analyzer 用的只读列举）', ['branch', '--format=%(refname:short)', '--merged']);
  // `-a` 在 branch 语境下就是「列出所有分支」，是纯只读；不要因为它在别处有别的含义就一并封死
  accepts('允许 branch -a（列出所有分支，只读）', ['branch', '-a']);
  accepts('允许 branch <name>（新建）', ['branch', 'feature/x']);
  accepts('允许 branch <name> <起点>（从指定起点新建）', ['branch', 'feature/x', 'main']);
  accepts('允许 branch -d <name>（删除已合并）', ['branch', '-d', 'old']);
  accepts('允许 branch -D <name>（强制删除）', ['branch', '-D', 'old']);

  rejects('拒绝 branch -m a b（改名不在白名单）', ['branch', '-m', 'a', 'b'], /白名单/);
  rejects('拒绝 branch --list x（只读 flag 后面不许跟名字）', ['branch', '--list', 'x'], /白名单/);
  rejects('拒绝 branch -d（缺少分支名）', ['branch', '-d'], /只接受/);
  rejects('拒绝 branch -d a b（删两个）', ['branch', '-d', 'a', 'b'], /只接受/);
  rejects('拒绝 branch -d main --force（拼接危险 flag）', ['branch', '-d', 'main', '--force'], /只接受/);
  rejects('拒绝 branch --force x', ['branch', '--force', 'x'], /白名单/);
  rejects('拒绝 branch -f x', ['branch', '-f', 'x'], /白名单/);
  rejects('拒绝 branch ..bad（前导 ..）', ['branch', '..bad'], /ref 规则|开头/);
  rejects('拒绝 branch bad.lock（.lock 结尾）', ['branch', 'bad.lock'], /结尾/);
  rejects('拒绝 branch -bad（前导连字符）', ['branch', '-bad'], /开头/);
  rejects('拒绝 branch a..b', ['branch', 'a..b'], /ref 规则/);
  rejects('拒绝 branch a//b', ['branch', 'a//b'], /ref 规则/);
  rejects('拒绝 branch x@{1}', ['branch', 'x@{1}'], /只能包含|ref 规则/);
  rejects('拒绝 branch a b（名字含空格）', ['branch', 'a b'], /只能包含/);
  rejects('拒绝 branch a~1', ['branch', 'a~1'], /只能包含/);
  rejects('拒绝 branch a^1', ['branch', 'a^1'], /只能包含/);
  rejects('拒绝 branch a:b', ['branch', 'a:b'], /只能包含/);
  rejects('拒绝 branch a?b', ['branch', 'a?b'], /只能包含/);
  rejects('拒绝 branch a*b', ['branch', 'a*b'], /只能包含/);
  rejects('拒绝 branch a[b', ['branch', 'a[b'], /只能包含/);

  // update-ref 同样被收窄到 refs/gm/** —— 底层「删任意引用」的写法必须凑不出来
  accepts('允许 update-ref refs/gm/prepush/x HEAD', ['update-ref', 'refs/gm/prepush/x-1', 'HEAD']);
  accepts('允许 update-ref -d refs/gm/deleted/x', ['update-ref', '-d', 'refs/gm/deleted/x-1']);
  rejects('拒绝 update-ref -d refs/heads/main（底层删用户分支）', ['update-ref', '-d', 'refs/heads/main'], /只能删除 refs\/gm/);
  rejects('拒绝 update-ref refs/heads/main <sha>（越界移动用户分支）', ['update-ref', 'refs/heads/main', 'deadbeef'], /不在白名单/);
  rejects('拒绝 update-ref -d（缺少 ref）', ['update-ref', '-d'], /只接受/);
  rejects('拒绝 update-ref --force', ['update-ref', '--force', 'refs/gm/x', 'HEAD'], /不在白名单/);
}

/* ================= 2. ★ 盘根路径包含判定（扫描 bug 的回归） ================= */
console.log('[2] 扫描根：盘根必须能把子目录判为「内部」');
{
  const driveRoot = path.parse(TMP).root; // Windows: 'C:\\'
  const deep = path.join(TMP, 'a', 'b', 'c');

  // ★ 这条就是 bug 本身：修复前 isInside('E:\\', 'E:\\repo') 恒为 false，
  //   因为 path.resolve('E:\\') 已自带结尾分隔符，再拼一次 sep 变成 'E:\\\\'
  check('盘根 → 直接子目录 判为内部', pathIsInside(driveRoot, TMP) === true, `root=${driveRoot}`);
  check('盘根 → 深层子目录 判为内部', pathIsInside(driveRoot, deep) === true);

  // 规整函数不能产生「两个连续分隔符」
  const sep = path.sep;
  check('withTrailingSep(盘根) 不产生双分隔符', !withTrailingSep(driveRoot).includes(sep + sep), withTrailingSep(driveRoot));

  check('普通目录 → 子目录 判为内部', pathIsInside(TMP, deep) === true);
  check('同级前缀目录不算内部（C:\\x vs C:\\x2）', pathIsInside(path.join(TMP, 'x'), path.join(TMP, 'x2')) === false);
  check('父目录方向倒过来为 false', pathIsInside(deep, TMP) === false);
}

/* ================= 3. 真实仓库：新建 / 删除 / 恢复 端到端 ================= */
console.log('[3] 真实仓库：新建 → 删除 → 恢复');
const DIR = path.join(TMP, 'fixture');
{
  fs.mkdirSync(DIR, { recursive: true });
  await raw(DIR, ['init', '-q', '-b', 'main']);
  await raw(DIR, ['config', 'user.email', 'test@example.com']);
  await raw(DIR, ['config', 'user.name', 'Test']);
  await raw(DIR, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(DIR, 'a.txt'), 'hello\n');
  await raw(DIR, ['add', '-A']);
  await raw(DIR, ['commit', '-q', '-m', 'init']);

  const repo = { id: 'fixture', path: DIR, name: 'fixture' };

  // —— 前置评估 ——
  const missing = await branchRemovalPrecheck(repo, 'nope');
  check('precheck：不存在的分支 → 不 ok', missing.ok === false && missing.exists === false);
  check('precheck：不存在的分支给出 not-found blocker', missing.blockers.some((b) => b.id === 'not-found'));

  const cur = await branchRemovalPrecheck(repo, 'main');
  check('precheck：当前分支 → isCurrent 且被拦', cur.isCurrent === true && cur.ok === false);
  check('precheck：当前分支给出 is-current blocker', cur.blockers.some((b) => b.id === 'is-current'));
  check('precheck：只有一个分支 → isOnly', cur.isOnly === true);
  check('precheck：唯一分支给出 is-only blocker', cur.blockers.some((b) => b.id === 'is-only'));
  // ★ 自己检出自己不是「被占用」——worktree list 会把本仓库也算进来，必须排除
  check('★ precheck：本仓库自身检出不算 locked', cur.lockedBy === null && !cur.blockers.some((b) => b.id === 'locked'));
  check('precheck：当前分支不会被判定为需要强制', cur.needsForce === false);

  // —— 新建 ——
  const made = await createBranch(repo, { name: 'feature/x' });
  check('新建分支成功', made.ok && made.name === 'feature/x');
  check('新建后分支确实存在', await branchExists(DIR, 'feature/x'));
  check('新建分支不改变当前分支', (await raw(DIR, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() === 'main');
  check('新建分支的 rollbackHint 指向删除', /branch -d/.test(made.rollbackHint || ''));

  // —— 真正的「被别的 worktree 占用」必须认出来 ——
  const wtPath = path.join(TMP, 'wt-for-feature');
  await raw(DIR, ['worktree', 'add', '-q', wtPath, 'feature/x']);
  const lockedPre = await branchRemovalPrecheck(repo, 'feature/x');
  check('precheck：被其它工作树占用 → locked blocker', lockedPre.ok === false && lockedPre.blockers.some((b) => b.id === 'locked'), `lockedBy=${lockedPre.lockedBy}`);
  check('precheck：占用路径指向那个工作树', path.resolve(lockedPre.lockedBy || '') === path.resolve(wtPath));
  let lockErr = null;
  try { await deleteBranch(repo, { name: 'feature/x' }); } catch (e) { lockErr = e; }
  check('被占用时删除被拒（且没有半删）', !!lockErr && (await branchExists(DIR, 'feature/x')));
  await raw(DIR, ['worktree', 'remove', '--force', wtPath]);
  check('摘掉工作树后 locked 消失', (await branchRemovalPrecheck(repo, 'feature/x')).lockedBy === null);

  await createBranch(repo, { name: 'from-main', from: 'main' });
  check('从指定起点新建成功', await branchExists(DIR, 'from-main'));

  let dupErr = null;
  try { await createBranch(repo, { name: 'feature/x' }); } catch (e) { dupErr = e; }
  check('重名新建被拒', !!dupErr && /已存在/.test(dupErr.message));

  let badFrom = null;
  try { await createBranch(repo, { name: 'ok-name', from: 'no-such-branch' }); } catch (e) { badFrom = e; }
  check('起点不存在被拒', !!badFrom && /不存在/.test(badFrom.message));
  check('起点不存在时不留下半成品分支', (await branchExists(DIR, 'ok-name')) === false);

  let badName = null;
  try { await createBranch(repo, { name: 'bad name' }); } catch (e) { badName = e; }
  check('非法分支名被拒', !!badName);

  // —— 删除「已合并」的分支：走 -d，git 应放行 ——
  const delMerged = await deleteBranch(repo, { name: 'from-main', force: false });
  check('删除已合并分支成功（-d）', delMerged.ok && delMerged.forced === false);
  check('删除后分支消失', (await branchExists(DIR, 'from-main')) === false);
  check('删除时留下了回滚点', /^refs\/gm\/deleted\//.test(delMerged.snapshotRef || ''));
  check('删除的 rollbackHint 指向恢复', /branch from-main refs\/gm\/deleted\//.test(delMerged.rollbackHint || ''));

  // —— 在 feature/x 上造一个「未合并」提交 ——
  await raw(DIR, ['switch', '-q', 'feature/x']);
  fs.writeFileSync(path.join(DIR, 'b.txt'), 'only on feature\n');
  await raw(DIR, ['add', '-A']);
  await raw(DIR, ['commit', '-q', '-m', 'feat: unmerged work']);
  await raw(DIR, ['switch', '-q', 'main']);

  const pre = await branchRemovalPrecheck(repo, 'feature/x');
  check('precheck：未合并提交被数出来', pre.unmerged === 1, `unmerged=${pre.unmerged}`);
  check('precheck：未合并分支需要强制', pre.needsForce === true);
  check('precheck：未合并不是 blocker（交给 git 的 -d 去挡）', pre.ok === true);

  // —— 非强制删除：git 必须拒绝 ——
  let notMerged = null;
  try { await deleteBranch(repo, { name: 'feature/x', force: false }); } catch (e) { notMerged = e; }
  check('非强制删除未合并分支被 git 拒绝', !!notMerged && notMerged.code === 'NOT_MERGED');
  check('被拒后分支仍在（没有半删）', await branchExists(DIR, 'feature/x'));
  check('被拒的提示里指明了可以改用「强制删除」', /强制删除/.test(notMerged?.message || ''));
  check('删除被拒时不留下幽灵回滚点（失败即清理）',
    (await branchRemovalCandidates(repo)).deleted.filter((d) => d.name === 'feature/x').length === 0,
    JSON.stringify((await branchRemovalCandidates(repo)).deleted));

  // —— ★ 强制删除的二次确认串必须**先于任何 git 调用** ——
  let noConfirm = null;
  try { await deleteBranch(repo, { name: 'feature/x', force: true, confirm: 'wrong' }); } catch (e) { noConfirm = e; }
  check('强制删除缺少正确确认串 → 被拒', !!noConfirm && noConfirm.code === 'NO_CONFIRM');
  check('★ 确认串错误时分支完全未被触碰', await branchExists(DIR, 'feature/x'));
  check('★ 确认串错误时也没有留下多余回滚点',
    (await branchRemovalCandidates(repo)).deleted.filter((d) => d.name === 'feature/x').length === 0);

  const tipBefore = await tipOf(DIR, 'feature/x');
  const forced = await deleteBranch(repo, { name: 'feature/x', force: true, confirm: 'feature/x' });
  check('强制删除成功', forced.ok && forced.forced === true);
  check('强制删除后分支消失', (await branchExists(DIR, 'feature/x')) === false);

  // —— 恢复 ——
  const cand = await branchRemovalCandidates(repo);
  const rec = cand.recoverable.find((d) => d.name === 'feature/x');
  check('删除点出现在候选列表', !!rec);
  check('候选里的名字把 __ 还原成了 /', rec?.name === 'feature/x');
  check('候选带出被删分支的尖端与提交信息', !!rec?.sha && rec?.subject === 'feat: unmerged work');

  const restored = await restoreBranch(repo, { name: rec.name, ref: rec.ref });
  check('恢复分支成功', restored.ok);
  check('恢复后分支存在', await branchExists(DIR, 'feature/x'));
  check('★ 恢复后的尖端与删除前一致（提交没丢）', (await tipOf(DIR, 'feature/x')) === tipBefore, `${await tipOf(DIR, 'feature/x')} vs ${tipBefore}`);

  let dupRestore = null;
  try { await restoreBranch(repo, { name: 'feature/x', ref: rec.ref }); } catch (e) { dupRestore = e; }
  check('重复恢复被拒', !!dupRestore && /已存在/.test(dupRestore.message));

  let badRef = null;
  try { await restoreBranch(repo, { name: 'evil', ref: 'refs/heads/main' }); } catch (e) { badRef = e; }
  check('只能从 refs/gm/deleted/ 下恢复', !!badRef && /refs\/gm\/deleted/.test(badRef.message));
  check('越权恢复没有真的建出分支', (await branchExists(DIR, 'evil')) === false);

  // —— 兜底：正检出的分支、唯一分支都不能删 ——
  let curErr = null;
  try { await deleteBranch(repo, { name: 'main' }); } catch (e) { curErr = e; }
  check('删除当前分支被拒', !!curErr && curErr.precheck?.blockers?.some((b) => b.id === 'is-current'));

  // —— 审计日志 ——
  const logs = listLogs(repo.id, 100);
  const ops = logs.map((l) => l.op);
  check('日志记录了 branch-create', ops.includes('branch-create'));
  check('日志记录了 branch-delete', ops.includes('branch-delete'));
  check('日志记录了 branch-restore', ops.includes('branch-restore'));
  const delLog = logs.find((l) => l.op === 'branch-delete' && l.name === 'feature/x');
  check('删除日志带 forced / snapshotRef / 回滚信息', !!delLog && delLog.forced === true && /^refs\/gm\/deleted\//.test(delLog.snapshotRef || ''));
  check('删除日志的 rollback 是可执行的恢复结构', delLog?.rollback?.kind === 'branch-restore' && delLog?.rollback?.name === 'feature/x');
}

/* ================= 4. HTTP 路由：顺序与可用性 ================= */
console.log('[4] HTTP 路由：/branches/removal 不能被 /branches 抢先匹配');
{
  const httpData = path.join(TMP, 'http-data');
  fs.mkdirSync(httpData, { recursive: true });

  const child = spawn(process.execPath, ['server/index.js', '--port', '0', '--quiet'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, GM_DATA_DIR: httpData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('服务 15s 内未就绪')), 15000);
    child.stdout.on('data', (c) => {
      buf += String(c);
      const m = buf.match(/GM_READY (\{.*\})/);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    child.stderr.on('data', (c) => {
      const s = String(c);
      if (s.trim()) console.error('[server stderr]', s.trim());
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出，code=${code}`));
    });
  }).catch((e) => {
    console.error(`  跳过 HTTP 组：${e.message}`);
    return null;
  });

  if (!ready) {
    console.log('  · 跳过（无法启动本地服务）');
  } else {
    const base = `http://127.0.0.1:${ready.port}/api`;
    const call = async (p, { method = 'GET', body } = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'x-gm-token': ready.token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
      return { status: res.status, data };
    };

    try {
      const opened = await call('/repos/open', { method: 'POST', body: { path: DIR } });
      check('POST /repos/open 接入夹具仓库', opened.status === 200 && !!opened.data?.repo?.id);
      const id = encodeURIComponent(opened.data.repo.id);

      const list = await call(`/repos/${id}/branches`);
      check('GET /branches 仍返回分支列表', list.status === 200 && Array.isArray(list.data?.local));

      // ★ 关键：这条路径比 /branches 长，若路由顺序写反就会被当成列表返回
      const rem = await call(`/repos/${id}/branches/removal?name=${encodeURIComponent('feature/x')}`);
      check('GET /branches/removal 返回的是「删除前评估」而不是分支列表',
        rem.status === 200 && rem.data?.blockers !== undefined && rem.data?.local === undefined,
        JSON.stringify(rem.data).slice(0, 120));

      const del = await call(`/repos/${id}/branches/deleted`);
      check('GET /branches/deleted 返回删除点候选', del.status === 200 && Array.isArray(del.data?.deleted));

      const cr = await call(`/repos/${id}/branches`, { method: 'POST', body: { name: 'http/created' } });
      check('POST /branches 新建成功', cr.status === 200 && cr.data?.ok === true && cr.data?.name === 'http/created');

      // 二次确认串错误 → 400，且分支必须还在
      const bad = await call(`/repos/${id}/branches/delete`, { method: 'POST', body: { name: 'http/created', force: true, confirm: 'nope' } });
      check('POST /branches/delete 二次确认错误 → 400 NO_CONFIRM', bad.status === 400 && bad.data?.code === 'NO_CONFIRM');

      const d2 = await call(`/repos/${id}/branches/delete`, { method: 'POST', body: { name: 'http/created', force: false } });
      check('POST /branches/delete 普通删除成功', d2.status === 200 && d2.data?.ok === true);

      const sref = d2.data?.snapshotRef;
      const rs = await call(`/repos/${id}/branches/restore`, { method: 'POST', body: { name: 'http/created', ref: sref } });
      check('POST /branches/restore 恢复成功', rs.status === 200 && rs.data?.ok === true);
      check('恢复后分支真的回来了', await branchExists(DIR, 'http/created'));

      const badName = await call(`/repos/${id}/branches`, { method: 'POST', body: { name: 'bad name' } });
      check('非法分支名 → 400', badName.status === 400 && badName.data?.error === true);
    } catch (e) {
      check('HTTP 组整体执行', false, e.message);
    } finally {
      child.kill();
    }
  }
}

/* ================= 5. 前端契约 ================= */
console.log('[5] 前端契约：renderBranches 必须渲染出三个操作入口');
{
  const sample = {
    current: 'main',
    dirtyCount: 0,
    local: [
      { name: 'main', sha: 'aaa1111', subject: 'init', date: new Date().toISOString(), isCurrent: true, isMerged: true, isStale: false, lockedBy: null, upstream: '', ahead: 0, behind: 0 },
      { name: 'feat/x', sha: 'bbb2222', subject: 'wip', date: new Date().toISOString(), isCurrent: false, isMerged: false, isStale: false, lockedBy: null, upstream: '', ahead: 1, behind: 0 },
    ],
    remotes: [],
  };
  const deleted = {
    deleted: [{ ref: 'refs/gm/deleted/old-20260101T000000', name: 'old', sha: 'ccc3333', subject: 'gone', date: new Date().toISOString(), deletedAt: '20260101T000000', restored: false }],
    recoverable: [],
    localCount: 2,
  };

  const html = views.renderBranches({ branches: sample, deleted });
  check('渲染出「新建分支」按钮', html.includes('data-action="branch-new"'));
  check('渲染出每行「删除」按钮', html.includes('data-action="branch-delete"'));
  check('渲染出「可恢复的删除点」分组', html.includes('可恢复的删除点'));
  check('渲染出「恢复」按钮', html.includes('data-action="branch-restore"'));

  // 正检出的分支不能删：按钮必须带 disabled
  const mainRow = html.split('branch-row').find((s) => s.includes('main</div>')) || '';
  check('正检出的分支：删除按钮被禁用', /data-action="branch-delete"[^>]*disabled/.test(mainRow), mainRow.slice(0, 160));

  // 没有删除点时不该出现空分组
  const html2 = views.renderBranches({ branches: sample, deleted: null });
  check('无删除点时不渲染空分组', !html2.includes('可恢复的删除点'));

  // 日志视图：三种新操作都要有中文标签，不能裸漏 op 名
  const logs = views.renderLog({
    logs: [
      { ts: new Date().toISOString(), op: 'branch-create', name: 'feat/x', from: 'main', result: 'ok' },
      { ts: new Date().toISOString(), op: 'branch-delete', name: 'feat/x', forced: true, unmerged: 1, snapshotRef: 'refs/gm/deleted/x-1', result: 'ok' },
      { ts: new Date().toISOString(), op: 'branch-restore', name: 'feat/x', from: 'refs/gm/deleted/x-1', result: 'ok' },
    ],
  });
  check('日志：新建分支有中文标签', logs.includes('新建分支'));
  check('日志：删除分支有中文标签', logs.includes('删除分支'));
  check('日志：恢复分支有中文标签', logs.includes('恢复分支'));
  check('日志：不再裸漏 branch-create 这类原始 op', !logs.includes('>branch-create<'));
}

/* ================= 汇总 ================= */
console.log('');
console.log(`分支测试：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录残留无害 */ }
process.exit(fail ? 1 : 0);
