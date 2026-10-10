import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 原生文件夹选择器。
 *
 * 为什么必须放在服务端：浏览器出于安全拿不到真实绝对路径
 * （File System Access API 只返回句柄），而 git 引擎需要真实路径。
 * 服务端跑在用户本机，可以直接调用 Windows 的原生对话框。
 *
 * 桌面端迁移时：把这个函数换成 Tauri 的 dialog.open() /
 * Electron 的 dialog.showOpenDialog()，上层 api.js 契约不变。
 */

const IS_WIN = process.platform === 'win32';

/** PowerShell 里单引号字符串的转义：' → '' */
const psq = (s) => String(s ?? '').replace(/'/g, "''");

function buildScript({ title, defaultPath }) {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dlg.Description = '${psq(title)}'`,
    '$dlg.ShowNewFolderButton = $false',
    defaultPath
      ? `if (Test-Path -LiteralPath '${psq(defaultPath)}') { $dlg.SelectedPath = '${psq(defaultPath)}' }`
      : '',
    // 用一个「不可见但置顶」的宿主窗体作为 owner，确保对话框弹在最前面
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Opacity = 0',
    '$owner.Width = 1',
    '$owner.Height = 1',
    '$owner.Show()',
    '$owner.Activate()',
    '$r = $dlg.ShowDialog($owner)',
    '$owner.Close()',
    '$owner.Dispose()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {',
    '  # 用 Base64 回传，彻底规避控制台编码把中文路径压坏的问题',
    '  $b = [System.Text.Encoding]::UTF8.GetBytes($dlg.SelectedPath)',
    '  [Console]::Out.Write([Convert]::ToBase64String($b))',
    '} else {',
    '  [Console]::Out.Write("__CANCEL__")',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

export function pickFolder({ title = '选择一个文件夹', defaultPath = '', timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      resolve({ ok: false, cancelled: false, unsupported: true, message: '当前系统暂不支持原生对话框，请手动输入路径' });
      return;
    }

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', buildScript({ title, defaultPath })],
      { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const raw = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        const text = raw.trim();

        if (err && err.killed) {
          resolve({ ok: false, cancelled: true, timeout: true, message: '选择超时，已自动取消' });
          return;
        }
        if (text === '__CANCEL__') {
          resolve({ ok: true, cancelled: true });
          return;
        }
        if (!text) {
          resolve({ ok: false, cancelled: true, message: err?.message || '未取到路径' });
          return;
        }
        try {
          const decoded = Buffer.from(text, 'base64').toString('utf8');
          if (!decoded) {
            resolve({ ok: false, cancelled: true, message: '路径解析为空' });
            return;
          }
          resolve({ ok: true, cancelled: false, path: decoded });
        } catch {
          resolve({ ok: false, cancelled: true, message: '路径解析失败' });
        }
      },
    );

    // 兜底：父进程若异常退出，别留下孤儿对话框
    child.on('error', () => resolve({ ok: false, cancelled: true, message: '无法启动系统对话框' }));
  });
}

export const dialogSupported = IS_WIN;

/** 文件选择器：用于「上传本地文件到 GitHub」时挑一个文件 */
function buildFileScript({ title, defaultPath, filter = '所有文件|*.*' }) {
  const [label, pattern] = String(filter).split('|');
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    `$dlg.Title = '${psq(title)}'`,
    '$dlg.Multiselect = $false',
    '$dlg.CheckFileExists = $true',
    `$dlg.Filter = '${psq(`${label}|${pattern}`)}'`,
    defaultPath
      ? `if (Test-Path -LiteralPath '${psq(defaultPath)}') { $dlg.InitialDirectory = '${psq(defaultPath)}' }`
      : '',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Opacity = 0',
    '$owner.Width = 1',
    '$owner.Height = 1',
    '$owner.Show()',
    '$owner.Activate()',
    '$r = $dlg.ShowDialog($owner)',
    '$owner.Close()',
    '$owner.Dispose()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName) {',
    '  $b = [System.Text.Encoding]::UTF8.GetBytes($dlg.FileName)',
    '  [Console]::Out.Write([Convert]::ToBase64String($b))',
    '} else {',
    '  [Console]::Out.Write("__CANCEL__")',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

export function pickFile({ title = '选择一个文件', defaultPath = '', filter = '所有文件|*.*', timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      resolve({ ok: false, cancelled: false, unsupported: true, message: '当前系统暂不支持原生对话框，请手动输入路径' });
      return;
    }

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', buildFileScript({ title, defaultPath, filter })],
      { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const raw = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        const text = raw.trim();

        if (err && err.killed) {
          resolve({ ok: false, cancelled: true, timeout: true, message: '选择超时，已自动取消' });
          return;
        }
        if (text === '__CANCEL__') {
          resolve({ ok: true, cancelled: true });
          return;
        }
        if (!text) {
          resolve({ ok: false, cancelled: true, message: err?.message || '未取到路径' });
          return;
        }
        try {
          const decoded = Buffer.from(text, 'base64').toString('utf8');
          if (!decoded) {
            resolve({ ok: false, cancelled: true, message: '路径解析为空' });
            return;
          }
          resolve({ ok: true, cancelled: false, path: decoded });
        } catch {
          resolve({ ok: false, cancelled: true, message: '路径解析失败' });
        }
      },
    );

    child.on('error', () => resolve({ ok: false, cancelled: true, message: '无法启动系统对话框' }));
  });
}

/**
 * 读取用户刚选中的文件内容（供「上传本地文件到 GitHub」用）。
 * 上限与在线编辑器一致（1 MB），二进制（含 NUL 字节）直接拒绝。
 * 只应在 pickFile 成功之后立刻调用 —— 不要把它做成「给路径就读」的通用能力。
 */
export async function readTextFile(filePath, { maxBytes = 1024 * 1024 } = {}) {
  const p = String(filePath || '').trim();
  if (!p) throw new Error('路径为空');
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('选中的不是一个文件');
  if (st.size > maxBytes) return { tooBig: true, size: st.size, name: path.basename(p) };

  const buf = await fsp.readFile(p);
  if (buf.includes(0)) return { binary: true, size: st.size, name: path.basename(p) };
  return { content: buf.toString('utf8'), size: st.size, name: path.basename(p) };
}
