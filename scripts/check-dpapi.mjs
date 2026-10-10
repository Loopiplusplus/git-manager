/**
 * 凭据仓库（server/core/secrets.js）端到端验证。
 *
 * 直接跑产品代码路径，不另起炉灶重写一遍 DPAPI 调用 —— 否则测的是"DPAPI 能不能用"，
 * 而不是"我们的凭据仓库对不对"。
 *
 * 两个容易自欺的地方，这里都堵掉了：
 *  1) putSecret 之后 getSecret 会命中内存缓存，根本走不到 DPAPI 解密。
 *     所以"能不能解开"一律到**子进程**里验（冷启动、空缓存）。
 *  2) 只验证往返一致还不够 —— 还要确认落盘内容里没有明文。
 *
 * 用 GM_DATA_DIR 做目录隔离，绝不碰真实 data/secrets.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-vault-'));
process.env.GM_DATA_DIR = TMP; // 必须在 import secrets.js 之前设置（模块加载期就读了）
delete process.env.GM_VAULT_MODE;

const SECRETS_URL = new URL('../server/core/secrets.js', import.meta.url).href;
const { putSecret, getSecret, deleteSecret, listSecretNames, vaultInfo, hasSecret, dpapiSupported } =
  await import('../server/core/secrets.js');

const FILE = path.join(TMP, 'secrets.json');
const NAME = 'github_token';

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${name}] ${ok ? '✓' : '✗'}${extra ? ' ' + extra : ''}`);
};

/**
 * 在全新进程里读取凭据 —— 这是唯一能真正走到 DPAPI 解密的路径。
 * 注意用异步 execFile：沙箱内 execFileSync 会以 EBUSY 失败。
 * 返回值用 JSON 传递，避免 null / 空串 / 哨兵字符互相混淆。
 */
function childGetSecret(name) {
  const code = `
process.env.GM_DATA_DIR = ${JSON.stringify(TMP)};
const { getSecret } = await import(${JSON.stringify(SECRETS_URL)});
try {
  process.stdout.write('GOT:' + JSON.stringify(await getSecret(${JSON.stringify(name)})));
} catch (e) {
  process.stdout.write('ERR:' + e.message);
}
`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', code],
      { encoding: 'utf8', timeout: 30000 },
      (err, stdout) => {
        const s = String(stdout || '').trim();
        if (err && !s) return resolve({ ok: false, error: err.message });
        if (s.startsWith('GOT:')) return resolve({ ok: true, value: JSON.parse(s.slice(4)) });
        resolve({ ok: false, error: s.replace(/^ERR:/, '') || '子进程无输出' });
      },
    );
  });
}

console.log('平台:', process.platform, '| DPAPI 可用:', dpapiSupported);
console.log('隔离目录:', TMP);
console.log('');

const CASES = [
  ['真实 token 形态', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['含中文与特殊字符', 'gho_测试中文_AbC123_xYz!@#$%^&*()_+-=[]{}|;:,.<>?/~`'],
  ['长随机串', Array.from({ length: 8 }, () => Math.random().toString(36).slice(2)).join('')],
];

let totalMs = 0;
let diskLeak = false;
const LAST = CASES[CASES.length - 1][1];

for (const [label, value] of CASES) {
  const t0 = Date.now();
  await putSecret(NAME, value);
  const t1 = Date.now();
  const cached = await getSecret(NAME);
  totalMs += t1 - t0;

  const cold = await childGetSecret(NAME);
  totalMs += Date.now() - t1;

  const disk = fs.readFileSync(FILE, 'utf8');
  if (disk.includes('gho_') || disk.includes(value)) diskLeak = true;

  const coldOk = cold.ok && cold.value === value;
  t(
    label,
    cached === value && coldOk,
    `明文${value.length}字符 · 缓存${cached === value ? '✓' : '✗'} 冷启动${coldOk ? '✓' : '✗'}`,
  );
  if (!coldOk) console.log(`   冷启动实得: ${JSON.stringify(String(cold.value ?? cold.error).slice(0, 80))}`);
}

t('落盘不含任何明文', !diskLeak);
t('密文形态为 base64（非明文结构）', /^[A-Za-z0-9+/=]+$/.test(JSON.parse(fs.readFileSync(FILE, 'utf8')).entries[NAME]));

/* ---------- 空值边界：必须是明确拒绝，而不是把底层报错漏出去 ---------- */
{
  let msg = '';
  try {
    await putSecret(NAME, '');
  } catch (e) {
    msg = e.message;
  }
  t('空值被明确拒绝', msg === '凭据内容不能为空', `提示「${msg}」`);
}
{
  let msg = '';
  try {
    await putSecret(NAME, undefined);
  } catch (e) {
    msg = e.message;
  }
  t('undefined 被明确拒绝', msg === '凭据内容不能为空');
}
{
  let msg = '';
  try {
    await putSecret('', 'abc');
  } catch (e) {
    msg = e.message;
  }
  t('空名称被明确拒绝', msg === '凭据名称非法');
}
{
  const now = await getSecret(NAME);
  t('边界用例没有污染仓库', now === LAST, now === LAST ? '' : `实得 ${JSON.stringify(String(now).slice(0, 40))}`);
}

/* ---------- 删除 ---------- */
{
  await deleteSecret(NAME);
  t('删除后读不到', (await getSecret(NAME)) === null);
  t('删除后 hasSecret 为假', hasSecret(NAME) === false);
  t('删除后名称列表为空', listSecretNames().length === 0);
  const cold = await childGetSecret(NAME);
  t('删除后子进程也读不到', cold.ok && cold.value === null);
}

/* ---------- 状态自述不泄露明文 ---------- */
{
  await putSecret(NAME, CASES[0][1]);
  const info = vaultInfo();
  t('vaultInfo 不含明文', !JSON.stringify(info).includes(CASES[0][1]));
  t(
    'vaultInfo 如实标注模式',
    info.mode === (dpapiSupported ? 'dpapi' : 'plain') && info.encrypted === dpapiSupported,
    `mode=${info.mode} encrypted=${info.encrypted}`,
  );
}

console.log('');
console.log('=== 结论 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`平均单次加/解密开销: ${Math.round(totalMs / (CASES.length * 3))}ms`);
console.log('=> 开销明显，token 解密结果必须在内存缓存，不能每次请求都解密');
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
