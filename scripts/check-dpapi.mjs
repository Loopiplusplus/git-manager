/**
 * 验证 Windows DPAPI 能否用于加密本地 token 落盘。
 * 代码路径与应用完全一致（Node spawn powershell.exe），不是另起炉灶。
 */
import { execFile } from 'node:child_process';

// 关键：Windows 控制台默认代码页是 GBK，[Console]::Out.Write 会把非 ASCII 写坏。
// 必须直接用 UTF-8 字节流写 stdout。
const PRELUDE = `
$ErrorActionPreference = 'Stop'
function Write-Utf8([string]$s) {
  $out = [Console]::OpenStandardOutput()
  $b = [Text.Encoding]::UTF8.GetBytes($s)
  $out.Write($b, 0, $b.Length)
  $out.Flush()
}
try {
  Add-Type -AssemblyName System.Security
  GM_BODY
} catch {
  Write-Utf8 ('ERR:' + $_.Exception.Message)
}
`;

const BODY_ENC = `
  $bytes = [Text.Encoding]::UTF8.GetBytes($env:GM_IN)
  $prot  = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  Write-Utf8 ('ENC:' + [Convert]::ToBase64String($prot))
`;

const BODY_DEC = `
  $prot  = [Convert]::FromBase64String($env:GM_IN)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($prot, $null, 'CurrentUser')
  Write-Utf8 ('DEC:' + [Text.Encoding]::UTF8.GetString($bytes))
`;

const build = (body) => PRELUDE.replace('GM_BODY', body);

function run(script, input) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, GM_IN: input }, timeout: 20000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({ err: err?.message || null, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }),
    );
  });
}

const CASES = [
  ['真实 token 形态', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['含中文与特殊字符', 'gho_测试中文_AbC123_xYz!@#$%^&*()_+-=[]{}|;:,.<>?/~`'],
  ['长随机串', Array.from({ length: 8 }, () => Math.random().toString(36).slice(2)).join('')],
  ['空字符串', ''],
];

console.log('平台:', process.platform);
console.log('');

let allPass = true;
let totalMs = 0;

for (const [name, secret] of CASES) {
  const t0 = Date.now();
  const enc = await run(build(BODY_ENC), secret);
  const t1 = Date.now();
  totalMs += t1 - t0;

  if (!enc.stdout.startsWith('ENC:')) {
    console.log(`[${name}] ✗ 加密失败: ${enc.stdout || enc.err || enc.stderr}`);
    allPass = false;
    continue;
  }
  const cipher = enc.stdout.slice(4);
  const t2 = Date.now();
  const dec = await run(build(BODY_DEC), cipher);
  const t3 = Date.now();
  totalMs += t3 - t2;

  const ok = dec.stdout.startsWith('DEC:') && dec.stdout.slice(4) === secret;
  if (!ok) allPass = false;
  console.log(`[${name}] ${ok ? '✓' : '✗'} 明文${secret.length}字符 | 密文${cipher.length}字符 | 往返${ok ? '一致' : '不一致'}`);
  if (!ok) console.log(`   期望: ${JSON.stringify(secret)}\n   实得: ${JSON.stringify(dec.stdout)}`);
}

console.log('');
console.log('=== 结论 ===');
console.log('DPAPI 全部用例通过:', allPass);
console.log(`平均单次加/解密开销: ${Math.round(totalMs / (CASES.length * 2))}ms`);
console.log('=> 开销明显，token 解密结果必须在内存缓存，不能每次请求都解密');
