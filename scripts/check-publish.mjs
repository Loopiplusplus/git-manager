/**
 * 「本地仓库提交并推送」的闸门测试。
 *
 * 这是本系统里唯一会改动**本地提交历史**的路径，所以先验证它拦得住什么：
 *   - push 只允许 origin + 单个分支名（--force / +refspec / --all / --mirror / --tags 全部要挡住）
 *   - remote 只允许操作 origin，且 URL 必须是 https://github.com/owner/name
 *   - 远端地址白名单（isSafeGithubUrl）
 *   - 头像代理只允许 GitHub 旗下主机（防 SSRF）
 *   - 二次确认串、仓库名合法性、未授权三条守卫
 * 再验证它跑得通：真实 git 仓库的状态解析，以及一次真实的 push（用本地裸仓库当 origin）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-publish-'));
process.env.GM_DATA_DIR = TMP;
process.env.GM_VAULT_MODE = 'plain';
process.env.GM_GH_TOKEN = 'gho_test_token_for_unit_tests';

const { assertSafe, git, gitOk, isSafeGithubUrl } = await import('../server/core/git.js');
const { publish, publishStatus, parsePorcelain, parseRemoteUrl, PublishError } = await import('../server/core/publish.js');
const gh = await import('../server/core/github.js');
const auth = await import('../server/core/auth.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}
function rejects(name, args, pattern) {
  try {
    assertSafe(args);
    check(name, false, '本应拒绝，却通过了');
  } catch (e) {
    check(name, pattern ? pattern.test(e.message) : true, pattern && !pattern.test(e.message) ? e.message : '');
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
/** 直接跑原始 git（测试脚手架用，绕开引擎，用于准备夹具） */
function raw(cwd, args, opts = {}) {
  return exec('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', ...opts });
}

/* ================= 1. push 窄化校验 ================= */
console.log('[1] git 引擎：push 只允许 origin + 单个分支名');
{
  accepts('允许 push -u origin main', ['push', '-u', 'origin', 'main']);
  accepts('允许 push origin feat/x', ['push', 'origin', 'feat/x']);
  accepts('允许 push --set-upstream origin main', ['push', '--set-upstream', 'origin', 'main']);
  accepts('允许 push origin refs/heads/dev', ['push', 'origin', 'refs/heads/dev']);

  rejects('拒绝 push --force', ['push', '--force', 'origin', 'main'], /形式|不合法|只接受/);
  rejects('拒绝 push -f', ['push', '-f', 'origin', 'main'], /形式|不合法|只接受/);
  rejects('拒绝 push --mirror', ['push', '--mirror'], /形式|不合法|只接受/);
  rejects('拒绝 push --all origin', ['push', '--all', 'origin'], /形式|不合法|只接受|只允许推送到/);
  rejects('拒绝 push --tags', ['push', '--tags', 'origin'], /形式|不合法|只接受|只允许推送到/);
  rejects('拒绝 push --delete origin main', ['push', '--delete', 'origin', 'main'], /形式|不合法|只接受/);
  rejects('拒绝 force refspec（+main）', ['push', 'origin', '+main'], /不合法/);
  rejects('拒绝带冒号的 refspec（main:other）', ['push', 'origin', 'main:other'], /不合法/);
  rejects('拒绝通配 refspec（refs/*）', ['push', 'origin', 'refs/*'], /不合法/);
  rejects('拒绝非 origin 远端', ['push', '-u', 'upstream', 'main'], /只允许推送到 origin/);
  rejects('拒绝多余参数', ['push', '-u', 'origin', 'main', 'extra'], /只接受/);
  rejects('拒绝 push 不带分支', ['push', 'origin'], /只接受|不合法/);
  rejects('拒绝 .. 形式的分支名', ['push', 'origin', 'a..b'], /不合法/);
  rejects('拒绝 --upload-pack 注入', ['push', '--upload-pack=evil', 'origin', 'main'], /形式|不合法|只接受/);
}

/* ================= 2. remote 窄化校验 ================= */
console.log('\n[2] git 引擎：remote 只允许 origin + github https');
{
  accepts('允许 remote（列出）', ['remote']);
  accepts('允许 remote -v', ['remote', '-v']);
  accepts('允许 remote get-url origin', ['remote', 'get-url', 'origin']);
  accepts('允许 remote add origin <github https>', ['remote', 'add', 'origin', 'https://github.com/o/n.git']);
  accepts('允许 remote set-url origin <github https>', ['remote', 'set-url', 'origin', 'https://github.com/o/n']);

  rejects('拒绝 remote add 到非 github 主机', ['remote', 'add', 'origin', 'https://gitlab.com/o/n.git'], /github\.com/);
  rejects('拒绝 remote add 用 ssh', ['remote', 'add', 'origin', 'git@github.com:o/n.git'], /github\.com/);
  rejects('拒绝 remote add 用 http', ['remote', 'add', 'origin', 'http://github.com/o/n.git'], /github\.com/);
  rejects('拒绝 remote add 带查询串', ['remote', 'add', 'origin', 'https://github.com/o/n.git?a=b'], /github\.com/);
  rejects('拒绝 remote add 到别的远端名', ['remote', 'add', 'upstream', 'https://github.com/o/n.git'], /只允许操作 origin/);
  rejects('拒绝 remote remove', ['remote', 'remove', 'origin'], /不在白名单/);
  rejects('拒绝 remote rename', ['remote', 'rename', 'origin', 'x'], /不在白名单/);
  rejects('拒绝 remote add 缺参数', ['remote', 'add', 'origin'], /需要/);
}

/* ================= 3. fetch 与仍然熔断的子命令 ================= */
console.log('\n[3] git 引擎：fetch 窄化 + 其余写操作仍然熔断');
{
  accepts('允许 fetch origin', ['fetch', 'origin']);
  accepts('允许 fetch origin main', ['fetch', 'origin', 'main']);
  rejects('拒绝 fetch 非 origin', ['fetch', 'upstream'], /只允许/);
  rejects('拒绝 fetch 多余参数', ['fetch', 'origin', 'main', 'other'], /只接受/);

  for (const sub of ['gc', 'clean', 'reset', 'checkout', 'rebase', 'merge']) {
    rejects(`仍然熔断 ${sub}`, [sub, 'x'], /熔断/);
  }
  rejects('拒绝未在白名单的子命令', ['filter-branch', 'x'], /不在白名单/);
  rejects('拒绝 --hard', ['reset', '--hard'], /熔断|禁止/);
  rejects('拒绝 -c 注入配置', ['commit', '-c', 'x=y'], /禁止使用/);
}

/* ================= 4. 远端地址白名单 ================= */
console.log('\n[4] isSafeGithubUrl');
{
  check('接受 github.com/owner/name.git', isSafeGithubUrl('https://github.com/octocat/Hello-World.git'));
  check('接受 github.com/owner/name', isSafeGithubUrl('https://github.com/octocat/Hello-World'));
  check('接受 www.github.com', isSafeGithubUrl('https://www.github.com/o/n'));
  check('拒绝 gitlab', isSafeGithubUrl('https://gitlab.com/o/n') === false);
  check('拒绝 http', isSafeGithubUrl('http://github.com/o/n') === false);
  check('拒绝 file://', isSafeGithubUrl('file:///etc/passwd') === false);
  check('拒绝 ssh 形态', isSafeGithubUrl('git@github.com:o/n.git') === false);
  check('拒绝三层路径', isSafeGithubUrl('https://github.com/o/n/extra') === false);
  check('拒绝只有 owner', isSafeGithubUrl('https://github.com/o') === false);
  check('拒绝纯点号 name', isSafeGithubUrl('https://github.com/o/..') === false);
  check('拒绝查询串', isSafeGithubUrl('https://github.com/o/n?x=1') === false);
  check('拒绝路径穿越', isSafeGithubUrl('https://github.com/../../etc/passwd') === false);
  check('非字符串安全返回 false', isSafeGithubUrl(null) === false && isSafeGithubUrl(undefined) === false);
}

/* ================= 5. git status 解析 ================= */
console.log('\n[5] parsePorcelain');
{
  const raw1 = ['?? new.txt', ' M changed.js', 'M  staged.js', 'A  added.js', ' D gone.js', 'R  old.js -> renamed.js', 'MM both.js'].join('\n');
  const f = parsePorcelain(raw1);
  check('解析出 7 条', f.length === 7, String(f.length));
  check('未跟踪识别正确', f[0].untracked === true && f[0].label === '未跟踪');
  check('未暂存修改识别正确', f[1].staged === false && f[1].label === '已修改');
  check('已暂存识别正确', f[2].staged === true && f[2].label === '已修改');
  check('重命名取新路径', f[5].path === 'renamed.js', f[5].path);
  check('空输入返回空数组', parsePorcelain('').length === 0);
  check('全是空行也不炸', parsePorcelain('\n\n  \n').length === 0);
}

/* ================= 6. 远端地址认领 ================= */
console.log('\n[6] parseRemoteUrl');
{
  const r = parseRemoteUrl('https://github.com/octocat/git-manager.git');
  check('认领 owner/name', r && r.owner === 'octocat' && r.name === 'git-manager', JSON.stringify(r));
  check('归一化为 .git 地址', r.httpsUrl.endsWith('.git'));
  check('非 github 返回 null', parseRemoteUrl('https://gitlab.com/a/b.git') === null);
  check('空值返回 null', parseRemoteUrl('') === null && parseRemoteUrl(undefined) === null);
}

/* ================= 7. 头像代理白名单（防 SSRF） ================= */
console.log('\n[7] 头像代理只允许 GitHub 旗下主机');
{
  const ok = gh.resolveAvatarUrl({ login: 'octocat' });
  check('login 形态拼成 github.com/<login>.png', ok === 'https://github.com/octocat.png?size=160', ok);
  check('size 被夹在合理区间', gh.resolveAvatarUrl({ login: 'a', size: 9999 }).includes('size=460'));
  check('接受 avatars.githubusercontent.com', gh.resolveAvatarUrl({ url: 'https://avatars.githubusercontent.com/u/1?v=4' }).includes('avatars.'));
  check('接受 secure.gravatar.com', gh.resolveAvatarUrl({ url: 'https://secure.gravatar.com/avatar/x' }).includes('gravatar'));

  const bad = [
    ['https://evil.com/a.png', 'BAD_HOST'],
    ['https://127.0.0.1:4599/api/repos', 'BAD_HOST'],
    ['https://169.254.169.254/latest/meta-data', 'BAD_HOST'],
    ['http://avatars.githubusercontent.com/u/1', 'BAD_PROTOCOL'],
    ['file:///etc/passwd', 'BAD_PROTOCOL'],
  ];
  for (const [url, code] of bad) {
    try {
      gh.resolveAvatarUrl({ url });
      check(`拒绝头像地址 ${url}`, false, '本应拒绝');
    } catch (e) {
      check(`拒绝头像地址 ${url}`, e.code === code, `${e.code}`);
    }
  }
  try {
    gh.resolveAvatarUrl({ login: '../etc/passwd' });
    check('拒绝非法 login', false, '本应拒绝');
  } catch (e) {
    check('拒绝非法 login', e.code === 'BAD_LOGIN', e.code);
  }
  try {
    gh.resolveAvatarUrl({});
    check('缺少参数时拒绝', false, '本应拒绝');
  } catch (e) {
    check('缺少参数时拒绝', e.code === 'NO_TARGET', e.code);
  }
}

/* ================= 8. 仓库名合法性 ================= */
console.log('\n[8] 新建仓库名校验');
{
  check('接受普通名字', gh.assertRepoName('my-vibe.project') === 'my-vibe.project');
  for (const bad of ['', '.hidden', '..', 'a b', 'a/b', 'a\\b', 'x'.repeat(101)]) {
    try {
      gh.assertRepoName(bad);
      check(`拒绝仓库名 ${JSON.stringify(bad).slice(0, 20)}`, false, '本应拒绝');
    } catch (e) {
      check(`拒绝仓库名 ${JSON.stringify(bad).slice(0, 20)}`, e.code === 'BAD_NAME', e.code);
    }
  }
}

/* ================= 9. publish 的守卫 ================= */
console.log('\n[9] publish 守卫');
{
  // authStatus 会去 /user 验活；这里桩掉，让 connected=true，从而走到后续守卫
  const fakeFetch = async (url) => {
    const payload = String(url).includes('/user')
      ? { login: 'tester', id: 42, name: 'Tester', avatar_url: '', html_url: '' }
      : {};
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => payload,
      // ★ ghFetch 读的是 res.text() 再自己 JSON.parse，只给 json() 是不够的
      text: async () => JSON.stringify(payload),
    };
  };
  auth.setFetchImpl(fakeFetch);
  gh.setFetchImpl(fakeFetch);

  const work = path.join(TMP, 'guard-repo');
  fs.mkdirSync(work, { recursive: true });
  await raw(work, ['init', '-b', 'main']);
  await raw(work, ['config', 'user.email', 't@example.com']);
  await raw(work, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
  await raw(work, ['add', '-A']);
  await raw(work, ['commit', '-m', 'init']);

  async function expectCode(name, opts, code) {
    try {
      await publish(work, opts);
      check(name, false, '本应抛错，却成功了');
    } catch (e) {
      check(name, e instanceof PublishError && e.code === code, `${e.code || e.name}: ${e.message}`);
    }
  }

  await expectCode('确认串不匹配 → NO_CONFIRM', { mode: 'create', repoName: 'demo', confirm: 'deom' }, 'NO_CONFIRM');
  await expectCode('确认串为空 → NO_CONFIRM', { mode: 'create', repoName: 'demo' }, 'NO_CONFIRM');
  await expectCode('仓库名为空 → NO_NAME', { mode: 'create', repoName: '', confirm: '' }, 'NO_NAME');
  await expectCode('仓库名含斜杠 → BAD_NAME', { mode: 'create', repoName: 'a/b', confirm: 'a/b' }, 'BAD_NAME');
  await expectCode('仓库名以点开头 → BAD_NAME', { mode: 'create', repoName: '.env', confirm: '.env' }, 'BAD_NAME');
  await expectCode('已有模式 owner 非法 → BAD_TARGET', { mode: 'existing', owner: 'a/b', name: 'x', confirm: 'x' }, 'BAD_TARGET');
  await expectCode('已有模式 name 非法 → BAD_TARGET', { mode: 'existing', owner: 'a', name: '', confirm: '' }, 'BAD_TARGET');
  // 确认串校验必须发生在任何网络调用之前：repoName 合法且 confirm 匹配时才可能往下走
  await expectCode('确认串先于网络校验（不存在仓库也会因确认错了先被拦）', { mode: 'existing', owner: 'ghost', name: 'nope', confirm: 'wrong' }, 'NO_CONFIRM');
}

/* ================= 10. publishStatus 真实仓库 ================= */
console.log('\n[10] publishStatus 真实仓库端到端');
{
  const repo = path.join(TMP, 'real-repo');
  fs.mkdirSync(repo, { recursive: true });
  await raw(repo, ['init', '-b', 'main']);
  await raw(repo, ['config', 'user.email', 't@example.com']);
  await raw(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  await raw(repo, ['add', '-A']);
  await raw(repo, ['commit', '-m', 'init']);

  // 制造三种改动
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\nmore\n'); // modified
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n'); // untracked
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'y\n');
  await raw(repo, ['add', 'staged.txt']);

  const st = await publishStatus(repo);
  check('读到当前分支 main', st.branch === 'main', st.branch);
  check('识别为有提交', st.hasCommits === true);
  check('headShort 是 7 位', /^[0-9a-f]{7}$/.test(st.headShort || ''), st.headShort);
  check('改动共 3 项', st.changes.total === 3, String(st.changes.total));
  check('  └ 已暂存 1 项', st.changes.staged === 1, String(st.changes.staged));
  check('  └ 未跟踪 1 项', st.changes.untracked === 1, String(st.changes.untracked));
  check('  └ 未暂存修改 1 项', st.changes.modified === 1, String(st.changes.modified));
  check('文件明细里能看到具体路径', st.changes.files.some((f) => f.path === 'untracked.txt'));
  check('没有 origin', st.remote.exists === false);
  check('git 身份已配置', st.identity.configured === true);
  check('允许发布（无阻塞原因）', st.canPublish === true, st.reasons.join(';'));

  // 空仓库（尚未 commit）
  const empty = path.join(TMP, 'empty-repo');
  fs.mkdirSync(empty, { recursive: true });
  await raw(empty, ['init', '-b', 'main']);
  const st2 = await publishStatus(empty);
  check('空仓库识别为 hasCommits=false', st2.hasCommits === false);
  check('空仓库且无文件 → canPublish=false', st2.canPublish === false);
  check('  └ 给出原因', (st2.reasons[0] || '').includes('空仓库'), st2.reasons.join(';'));
}

/* ================= 11. 真实 push 端到端（本地裸仓库当 origin） ================= */
console.log('\n[11] 真实 push 端到端（用本地裸仓库当 origin）');
{
  const bare = path.join(TMP, 'origin.git');
  await raw(TMP, ['init', '--bare', bare]);

  const work = path.join(TMP, 'push-repo');
  fs.mkdirSync(work, { recursive: true });
  await raw(work, ['init', '-b', 'main']);
  await raw(work, ['config', 'user.email', 't@example.com']);
  await raw(work, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(work, 'f.txt'), 'content\n');
  await raw(work, ['add', '-A']);
  await raw(work, ['commit', '-m', 'first']);

  // 直接用原始 git 挂上本地裸仓库（引擎只允许 github 地址，这里是为了验证 push 本身）
  await raw(work, ['remote', 'add', 'origin', bare]);

  // 走引擎的 push 路径
  const out = await git(work, ['push', '-u', 'origin', 'main'], { timeout: 60000 });
  check('引擎接受并执行了 push -u origin main', typeof out === 'string');

  const log = await raw(bare, ['log', '--oneline', 'main']);
  check('裸仓库收到了提交', log.stdout.includes('first'), log.stdout.trim());

  // 再推一次（无新提交）应该也成功（up-to-date）
  const out2 = await git(work, ['push', 'origin', 'main'], { timeout: 60000 });
  check('重复推送不报错', typeof out2 === 'string');

  // 本地推送后状态应能识别 origin
  const st = await publishStatus(work);
  check('publishStatus 认出 origin 存在', st.remote.exists === true);

  // ahead/behind 在非 github origin 上不做推断（返回 null），不能崩
  check('非 github 远端不做 ahead/behind 推断', st.remote.isGithub === false && st.ahead === null);
}

/* ================= 12. 快照 ref 命名安全 ================= */
console.log('\n[12] 提交前快照引用合法');
{
  const repo = path.join(TMP, 'snap-repo');
  fs.mkdirSync(repo, { recursive: true });
  await raw(repo, ['init', '-b', 'main']);
  await raw(repo, ['config', 'user.email', 't@example.com']);
  await raw(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'x.txt'), '1\n');
  await raw(repo, ['add', '-A']);
  await raw(repo, ['commit', '-m', 'init']);

  const ref = 'refs/gm/prepush/main-test';
  const r = await gitOk(repo, ['update-ref', ref, 'HEAD']);
  check('update-ref 能建 refs/gm/prepush/*', r.ok === true, r.err?.message || '');
  const show = await gitOk(repo, ['rev-parse', ref]);
  check('该 ref 指向 HEAD', show.ok === true && /^[0-9a-f]{40}$/.test(show.out.trim()));
  const heads = await gitOk(repo, ['for-each-ref', '--format=%(refname)', 'refs/gm/']);
  check('clean/branch 列表不会被它污染（独立命名空间）', heads.ok === true && heads.out.includes('refs/gm/prepush/'));
}

/* ================= 13. 记住上次打开的仓库 ================= */
console.log('\n[13] 记住上次打开的仓库（而不是永远给列表第一个）');
{
  const store = await import('../server/core/store.js');

  const mk = (id, exists = true) => ({ id, path: path.join(TMP, id), name: id, addedAt: `2026-10-10T0${id.slice(-1)}:00:00.000Z` });
  // 列表按 addedAt 倒序 → 后接入的排前面，所以「列表第一个」跟「用户上次用的」常常不是同一个
  store.upsertRepo(mk('repo-1'));
  store.upsertRepo(mk('repo-2'));
  store.upsertRepo(mk('repo-3'));

  const existsFn = () => true;

  store.setLastRepoId(null);
  const auto = store.resolveStartupRepo(existsFn);
  check('没记住过时回退到「最后接入的」', auto?.id === 'repo-3', auto?.id);

  store.setLastRepoId('repo-1');
  const restored = store.resolveStartupRepo(existsFn);
  check('★ 记住过时优先恢复它（而不是列表第一个）', restored?.id === 'repo-1', restored?.id);
  check('getLastRepoId 能读回', store.getLastRepoId() === 'repo-1');

  // 记住的仓库目录没了 → 不能卡在它上面
  const onlyRepo2Exists = (r) => r.id !== 'repo-1';
  const fallback = store.resolveStartupRepo(onlyRepo2Exists);
  check('记住的仓库已不存在时自动降级', fallback?.id !== 'repo-1' && !!fallback?.id, fallback?.id);

  // 被移除的正好是记住的那个 → 一起清掉
  store.setLastRepoId('repo-2');
  store.removeRepo('repo-2');
  check('移除记住的仓库时一并清空记录', store.getLastRepoId() === null, String(store.getLastRepoId()));
  check('清空后仍能解析出一个可用仓库', !!store.resolveStartupRepo(existsFn));

  // 记录指向一个不存在的 id：不能崩，兜底给列表第一个
  store.setLastRepoId('whatever');
  const last = store.resolveStartupRepo(() => false);
  check('记录指向不存在的仓库时不崩、兜底给出列表第一个', last?.id === 'repo-3', last?.id);
}

/* ================= 14. GitHub 同名仓库探测 ================= */
console.log('\n[14] 本地仓库有没有 GitHub 对应（目录名推断）');
{
  const { findGithubCounterpart } = await import('../server/core/publish.js');

  const dir = path.join(TMP, 'my-cool-project');
  fs.mkdirSync(dir, { recursive: true });

  // 账号里存在同名仓库
  gh.setFetchImpl(async (url) => {
    const u = String(url);
    let payload = null;
    let status = 200;
    if (u.includes('/user')) {
      payload = { login: 'tester', id: 42, name: 'Tester' };
    } else if (u.includes('/repos/tester/my-cool-project')) {
      payload = { id: 9, name: 'my-cool-project', full_name: 'tester/my-cool-project', private: true, default_branch: 'main', pushed_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/tester/my-cool-project', owner: { login: 'tester' } };
    } else {
      status = 404;
      payload = { message: 'Not Found' };
    }
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });

  const hit = await findGithubCounterpart(dir);
  check('★ 账号里有同名仓库时能认出来', hit?.fullName === 'tester/my-cool-project', JSON.stringify(hit));
  check('  └ 带上私有性与默认分支', hit?.private === true && hit?.defaultBranch === 'main');
  check('★ 标注判断依据是名字匹配（不是凭据级事实）', hit?.basis === 'name-match', hit?.basis);

  // 账号里没有同名仓库
  const ghost = path.join(TMP, 'no-such-repo-here');
  fs.mkdirSync(ghost, { recursive: true });
  const miss = await findGithubCounterpart(ghost);
  check('没有同名仓库时返回 null', miss === null, JSON.stringify(miss));

  // 目录名不是合法仓库名时不能去调 API、更不能炸
  const weird = path.join(TMP, 'has space');
  fs.mkdirSync(weird, { recursive: true });
  const illegal = await findGithubCounterpart(weird);
  check('目录名不合法时安全返回 null', illegal === null, JSON.stringify(illegal));

  // 没连接 GitHub 时也不能炸（连身份都取不到 → 直接返回 null）
  gh.setFetchImpl(async () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    json: async () => ({ message: 'Bad credentials' }),
    text: async () => JSON.stringify({ message: 'Bad credentials' }),
  }));
  const offline = await findGithubCounterpart(dir);
  check('未授权/取不到身份时安全返回 null', offline === null, JSON.stringify(offline));
}

/* ================= 15. 头像 data URL（与令牌、网络、CSP 全无关） ================= */
console.log('\n[15] 头像转 data URL + 进程内缓存');
{
  gh.clearAvatarCache();

  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG 魔数开头即可
  let calls = 0;
  gh.setFetchImpl(async (url) => {
    calls++;
    check('抓取的是白名单内的头像地址', /^https:\/\/(github\.com|avatars\.githubusercontent\.com)\//.test(String(url)), String(url));
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
    };
  });

  const d1 = await gh.avatarDataUrl({ login: 'tester', size: 160 });
  check('★ 返回的是 data: URL（CSP img-src 显式放行 data:）', d1.startsWith('data:image/png;base64,'), d1.slice(0, 40));
  check('  └ base64 内容可还原', Buffer.from(d1.split(',')[1], 'base64').equals(pngBytes));
  check('  └ 抓取发生了一次', calls === 1, String(calls));

  const d2 = await gh.avatarDataUrl({ login: 'tester', size: 160 });
  check('★ 第二次命中缓存，不再重复抓取', calls === 1 && d2 === d1, `calls=${calls}`);

  // 头像抓取失败不能让状态接口整体失败（调用方会 catch）
  gh.clearAvatarCache();
  gh.setFetchImpl(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}) }));
  let threw = false;
  try {
    await gh.avatarDataUrl({ login: 'tester' });
  } catch {
    threw = true;
  }
  check('抓取失败时抛错（由调用方降级处理，而不是返回坏 data URL）', threw === true);
}

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
process.exit(fail === 0 ? 0 : 1);
