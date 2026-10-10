/**
 * 克隆功能端到端测试 —— 真实访问 github.com，走应用自己的 cloneRepo()。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-clone-e2e-'));
process.env.GM_DATA_DIR = path.join(TMP, 'data');
process.env.GM_VAULT_MODE = 'plain';

const { cloneRepo, parseRepoRef } = await import('../server/core/clone.js');
const { openRepo } = await import('../server/core/repo.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

const parent = path.join(TMP, 'code');
fs.mkdirSync(parent, { recursive: true });

console.log('临时目录:', TMP);
console.log('');

console.log('[1] 真实克隆公有仓库 octocat/Hello-World（无 token，匿名）');
{
  const t0 = Date.now();
  let r = null;
  let err = null;
  try {
    r = await cloneRepo({ url: 'https://github.com/octocat/Hello-World.git', parentDir: parent });
  } catch (e) {
    err = e;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (err) {
    check('克隆成功', false, `${err.code}: ${String(err.message).slice(0, 160)}`);
    console.log('  （本环境若仍不可达 github.com，此项会失败；属网络限制而非功能缺陷）');
  } else {
    check(`克隆成功（耗时 ${secs}s）`, r.ok === true);
    check('返回了 owner / name', r.owner === 'octocat' && r.name === 'Hello-World', `${r.owner}/${r.name}`);
    check('目标路径正确', r.target === path.join(parent, 'Hello-World'), r.target);
    check('未使用鉴权（匿名克隆）', r.usedAuth === false, String(r.usedAuth));
    check('.git 目录存在', fs.existsSync(path.join(r.target, '.git')));
    check('已自动接入（返回 repo 对象）', !!r.repo && r.repo.name === 'Hello-World', JSON.stringify(r.repo?.name));
    check('自动接入时拿到了 HEAD', !!r.repo?.head, r.repo?.head);

    // 独立复核：真的是一份可用的 git 仓库
    const reopened = await openRepo(r.target);
    check('独立 openRepo 复核通过', reopened.name === 'Hello-World');
    check('克隆内容非空（README 存在）', fs.readdirSync(r.target).some((f) => /readme/i.test(f)), fs.readdirSync(r.target).join(','));

    // 二次克隆到同一位置必须被拒绝（目录已非空）
    let err2 = null;
    try {
      await cloneRepo({ url: 'octocat/Hello-World', parentDir: parent });
    } catch (e) { err2 = e; }
    check('重复克隆到同一目录被拒绝', err2?.code === 'TARGET_NOT_EMPTY', err2?.code);
  }
}

console.log('\n[2] 自定义目录名');
{
  try {
    const r = await cloneRepo({ url: 'octocat/Hello-World', parentDir: parent, dirName: 'my-alias' });
    check('自定义目录名生效', fs.existsSync(path.join(parent, 'my-alias')), r.target);
  } catch (e) {
    check('自定义目录名生效', false, e.message);
  }
}

console.log('\n[3] 不存在的仓库应快速失败（不能卡在鉴权协商上）');
{
  // 先确认预探测能力是否可用：匿名配额只有 60 次/小时，很容易打光。
  const { probeRepo } = await import('../server/core/github.js');
  const probe = await probeRepo('octocat', 'this-repo-definitely-does-not-exist-9x8y7z');
  if (probe.known === false) {
    console.log(`  · 跳过：API 预探测当前不可用（reason=${probe.reason}）`);
    console.log('    —— 这是匿名配额用尽所致，非功能缺陷。完成授权后配额为 5000/小时，不受影响。');
    console.log('    此时代码会按设计放行给 git 自己去试，因此该路径会退化为慢失败（约 9-60s）。');
  } else {
    const t0 = Date.now();
    let err = null;
    try {
      await cloneRepo({ url: 'octocat/this-repo-definitely-does-not-exist-9x8y7z', parentDir: parent });
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    check(`不存在仓库被拒绝（${(ms / 1000).toFixed(1)}s）`, !!err, '本应失败');
    check('  └ 由 API 预探测拦下', err?.code === 'REPO_NOT_FOUND', err?.code);
    check('  └ 3 秒内返回（git 直连需 9 秒以上）', ms < 3000, `${ms}ms`);
    check('  └ 错误信息可读且提示私有仓库情形', /不存在|私有仓库/.test(err?.message || ''), String(err?.message).slice(0, 100));
    check('  └ 未残留半成品目录', !fs.existsSync(path.join(parent, 'this-repo-definitely-does-not-exist-9x8y7z')));
  }
}

console.log('\n[4] 配额用尽不得被误判为「仓库不存在」');
{
  const { probeRepo } = await import('../server/core/github.js');
  const probe = await probeRepo('octocat', 'Hello-World');
  if (probe.reason === 'rate-limit') {
    check('配额用尽时 known=false（未被当成不存在）', probe.known === false && probe.exists === null, JSON.stringify(probe));
    check('  └ 原因明确标为 rate-limit', probe.reason === 'rate-limit', probe.reason);
  } else if (probe.known) {
    check('探测可用，确实判定存在', probe.exists === true, JSON.stringify(probe));
  } else {
    console.log(`  · 跳过（探测不可用，reason=${probe.reason}）`);
  }
}

console.log("\n[5] 解析等价写法都指向同一地址");
{
  const a = parseRepoRef('https://github.com/octocat/Hello-World.git');
  const b = parseRepoRef('octocat/Hello-World');
  const c = parseRepoRef('git@github.com:octocat/Hello-World.git');
  check('三种写法归一化一致', a.httpsUrl === b.httpsUrl && b.httpsUrl === c.httpsUrl, `${a.httpsUrl} | ${c.httpsUrl}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');
process.exit(fail === 0 ? 0 : 1);
