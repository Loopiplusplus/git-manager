const BASE = 'http://127.0.0.1:4630';
const [FIXTURE, REALREPO] = process.argv.slice(2);

const cfg = await (await fetch(`${BASE}/gm-config.js`)).text();
const token = cfg.match(/"token":"([^"]+)"/)[1];

async function rq(p, opt = {}) {
  const r = await fetch(BASE + '/api' + p, {
    method: opt.method || 'GET',
    headers: { 'x-gm-token': token, ...(opt.body ? { 'content-type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const rel = (p) => String(p).replace(FIXTURE, '.').replace(/\\/g, '/');

console.log('=== 1. 驱动器列表 ===');
const dr = await rq('/fs/drives');
console.log('   drives:', dr.drives.map((d) => d.label).join(', ') || '(无)');
console.log('   原生对话框支持:', dr.dialogSupported);

console.log('\n=== 2. probe 一个真实仓库目录 ===');
const p1 = await rq('/fs/probe', { method: 'POST', body: { path: REALREPO } });
console.log('   isRepo:', p1.isRepo, '| repoRoot:', p1.repoRoot, '| .git 类型:', p1.gitKind);

console.log('\n=== 3. probe 一个「未初始化」的目录 ===');
const p2 = await rq('/fs/probe', { method: 'POST', body: { path: FIXTURE } });
console.log('   isRepo:', p2.isRepo, '| exists:', p2.exists, '| scanned:', p2.scanned, '| 扫了', p2.scannedDirs, '个目录');
console.log('   找到的子仓库:', p2.childRepos.map((r) => rel(r.path)).join(' , ') || '(无)');

console.log('\n=== 4. 目录扫描（深度 5）===');
let { job } = await rq('/scan', { method: 'POST', body: { root: FIXTURE, maxDepth: 5 } });
const t0 = Date.now();
while (job.status === 'running') {
  await new Promise((r) => setTimeout(r, 100));
  job = (await rq(`/scan/${job.id}`)).job;
}
console.log(`   status=${job.status}  scannedDirs=${job.scannedDirs}  elapsed=${job.elapsedMs}ms`);
console.log('   共找到', job.foundCount, '个仓库:');
for (const f of job.found) console.log(`     ${rel(f.path)}  (depth ${f.depth})`);

const inNodeModules = job.found.filter((f) => /node_modules/i.test(f.path));
const hasRepoC = job.found.some((f) => f.path.endsWith('repoC'));
console.log('\n   跳过 node_modules:', inNodeModules.length === 0 ? '✓' : '✗');
console.log('   深层仓库 repoC 被发现:', hasRepoC ? '✓' : '✗');

console.log('\n=== 5. 取消扫描 ===');
const j2 = (await rq('/scan', { method: 'POST', body: { root: FIXTURE, maxDepth: 8 } })).job;
const cancelled = (await rq(`/scan/${j2.id}/cancel`, { method: 'POST' })).job;
console.log('   cancel 后 status:', cancelled.status);

console.log('\n=== 6. 非法输入防御 ===');
for (const [label, body] of [
  ['不存在的目录', { root: 'Z:\\definitely-not-here-12345' }],
  ['传文件而非目录', { path: REALREPO + '/.git' }],
]) {
  try {
    await rq('/scan', { method: 'POST', body });
    console.log(`   ${label}: ✗ 未报错`);
  } catch (e) {
    console.log(`   ${label}: ✓ 已拒绝 → ${e.message.split('\n')[0].slice(0, 60)}`);
  }
}

console.log('\n扫描接口测试完成');
