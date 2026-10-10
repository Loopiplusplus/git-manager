import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 凭据仓库 —— 本地加密落盘。
 *
 * 设计要点：
 * 1. Windows 上优先用 DPAPI（CurrentUser 作用域）加密，密文绑定当前 Windows 账户，
 *    即使 secrets.json 被拷走 / 进了网盘同步 / 被截图，换台机器也解不开。
 * 2. DPAPI 不可用时回退到 0600 明文，并在界面如实标注（不假装安全）。
 * 3. DPAPI 单次调用约 800ms（PowerShell 启动开销），所以解密结果进程内缓存，
 *    绝不在每次请求时重复解密。
 * 4. 明文 token 永不返回给前端，也不写日志。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
// GM_DATA_DIR 用于测试隔离；GM_VAULT_MODE=plain 可在 DPAPI 异常时强制降级
const DATA_DIR = process.env.GM_DATA_DIR ? path.resolve(process.env.GM_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'secrets.json');

export const dpapiSupported = process.platform === 'win32' && process.env.GM_VAULT_MODE !== 'plain';

// 直接写 UTF-8 字节流，绕开 Windows 控制台默认的 GBK 代码页
const PS_PRELUDE = `
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

const BODY_PROTECT = `
  if ([string]::IsNullOrEmpty($env:GM_IN)) { Write-Utf8 'ERR:拒绝加密空值'; return }
  $bytes = [Text.Encoding]::UTF8.GetBytes($env:GM_IN)
  $prot  = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  Write-Utf8 ('OK:' + [Convert]::ToBase64String($prot))
`;

const BODY_UNPROTECT = `
  $prot  = [Convert]::FromBase64String($env:GM_IN)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($prot, $null, 'CurrentUser')
  Write-Utf8 ('OK:' + [Text.Encoding]::UTF8.GetString($bytes))
`;

function psRun(body, input) {
  const script = PS_PRELUDE.replace('GM_BODY', body);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, GM_IN: input }, timeout: 20000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (err && !out) return reject(new Error(`凭据加解密失败：${err.message}`));
        if (out.startsWith('OK:')) return resolve(out.slice(3));
        reject(new Error(out.replace(/^ERR:/, '') || '凭据加解密失败'));
      },
    );
  });
}

/* ---------------- 文件读写 ---------------- */

let state = null; // { v, mode, entries: { name: value } }
const plainCache = new Map(); // name -> 已解密的明文（避免重复跑 800ms 的 DPAPI）

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = {
        v: raw.v || 1,
        mode: raw.mode === 'dpapi' || raw.mode === 'plain' ? raw.mode : 'plain',
        entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
      };
    } else {
      state = { v: 1, mode: dpapiSupported ? 'dpapi' : 'plain', entries: {} };
    }
  } catch {
    // 文件损坏：不静默吞掉，重置为可用状态并保留现场
    try {
      fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`);
    } catch { /* 忽略 */ }
    state = { v: 1, mode: dpapiSupported ? 'dpapi' : 'plain', entries: {} };
  }
  return state;
}

function save() {
  const s = load();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
  try {
    fs.chmodSync(FILE, 0o600); // 仅当前用户可读写
  } catch { /* Windows 上可能无效，忽略 */ }
}

/* ---------------- 对外接口 ---------------- */

export function listSecretNames() {
  return Object.keys(load().entries);
}

/** 仓库当前状态（不含任何明文），用于前端如实展示安全等级 */
export function vaultInfo() {
  const s = load();
  return {
    mode: s.mode,
    dpapiAvailable: dpapiSupported,
    encrypted: s.mode === 'dpapi',
    file: FILE,
    filePerm: (() => {
      try {
        return (fs.statSync(FILE).mode & 0o777).toString(8);
      } catch {
        return null;
      }
    })(),
    names: Object.keys(s.entries),
  };
}

export async function putSecret(name, value) {
  if (!name || typeof name !== 'string') throw new Error('凭据名称非法');
  if (typeof value !== 'string' || !value) throw new Error('凭据内容不能为空');

  const s = load();
  const mode = dpapiSupported ? 'dpapi' : 'plain';

  // 已有条目是另一种模式时，先按旧模式解出来再统一重写（避免模式混用）
  if (Object.keys(s.entries).length > 0 && s.mode === 'dpapi' && mode !== 'dpapi') {
    throw new Error('现有凭据为 DPAPI 加密，当前环境无法解密；请先清除凭据');
  }

  s.mode = mode;
  s.entries[name] = mode === 'dpapi' ? await psRun(BODY_PROTECT, value) : value;
  plainCache.set(name, value);
  save();
  return vaultInfo();
}

export async function getSecret(name) {
  const s = load();
  const raw = s.entries[name];
  if (raw === undefined) return null;
  if (plainCache.has(name)) return plainCache.get(name);

  if (s.mode === 'plain') {
    plainCache.set(name, raw);
    return raw;
  }
  try {
    const value = await psRun(BODY_UNPROTECT, raw);
    plainCache.set(name, value);
    return value;
  } catch (e) {
    const err = new Error(
      `无法解密已保存的凭据（${e.message}）。若 secrets.json 来自其它机器或其它 Windows 账户，请重新授权。`,
    );
    err.code = 'VAULT_DECRYPT_FAILED';
    throw err;
  }
}

export function deleteSecret(name) {
  const s = load();
  delete s.entries[name];
  plainCache.delete(name);
  save();
  return vaultInfo();
}

export function clearAllSecrets() {
  const s = load();
  s.entries = {};
  plainCache.clear();
  save();
  return vaultInfo();
}

/** 已保存但不落盘明文的存在性检查（不触发解密） */
export function hasSecret(name) {
  return Object.prototype.hasOwnProperty.call(load().entries, name);
}
