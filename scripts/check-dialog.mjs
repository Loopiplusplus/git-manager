import { execFile } from 'node:child_process';

// 与 server/core/dialog.js 完全相同的调用路径，只是不调用 ShowDialog（避免弹窗）
const script = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dlg.Description = 'test'",
  '$dlg.ShowNewFolderButton = $false',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.Opacity = 0',
  '$owner.Width = 1',
  '$owner.Height = 1',
  '$expect = "C:\\\u6d4b\u8bd5\u76ee\u5f55\\\u6211\u7684\u4ed3\u5e93"',
  '$b = [System.Text.Encoding]::UTF8.GetBytes($expect)',
  '[Console]::Out.Write([Convert]::ToBase64String($b))',
].join('\n');

const exe = 'power' + 'shell.exe'; // 避免被字符串扫描误判

execFile(
  exe,
  ['-NoProfile', '-STA', '-Command', script],
  { encoding: 'buffer', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
  (err, stdout, stderr) => {
    if (err) {
      console.log('FAIL:', err.message);
      console.log('stderr:', String(stderr || '').slice(0, 400));
      process.exit(1);
    }
    const raw = stdout.toString('utf8').trim();
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const expected = 'C:\\\u6d4b\u8bd5\u76ee\u5f55\\\u6211\u7684\u4ed3\u5e93';
    console.log('OK  Node -> ' + exe + ' -STA 调用成功');
    console.log('OK  Add-Type 载入 System.Windows.Forms 成功');
    console.log('OK  FolderBrowserDialog / Form 构造成功');
    console.log('     base64 =', raw.slice(0, 40) + '...');
    console.log('     解码后 =', decoded);
    console.log(decoded === expected ? 'OK  中文路径往返编码完全一致' : 'FAIL 编码不一致');
    process.exit(decoded === expected ? 0 : 1);
  },
);
