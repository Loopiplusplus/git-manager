/**
 * 桌面端冒烟测试（Electron）。
 *
 * 为什么必须真的把应用跑起来：
 * 这条链路上的失败模式几乎都是「静态检查看不出来」的 —— sidecar 起来了但窗口连不上、
 * preload 没注入、令牌没传对、渲染层 JS 报错导致白屏。跑一遍才知道。
 *
 * 用法：
 *   node scripts/check-desktop.mjs                  # 测开发态（项目目录 + 打包前的 Electron）
 *   node scripts/check-desktop.mjs --app <dir>      # 测打包产物（dist-desktop/win-unpacked）
 *   node scripts/check-desktop.mjs --exe <path>     # 测**单个可执行文件**（免安装版 / 已安装的 exe）
 *   node scripts/check-desktop.mjs --keep           # 保留临时目录以便排查
 *
 * 隔离：数据目录一律指向临时目录（GM_DATA_DIR），**绝不碰真实的 data/store.json**。
 * 这是踩过的坑：曾经 store.js 不认 GM_DATA_DIR，跑一次测试就把真实仓库列表写脏。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const appArgIdx = argv.indexOf('--app');
const exeArgIdx = argv.indexOf('--exe');
const APP_DIR = appArgIdx >= 0 ? path.resolve(argv[appArgIdx + 1]) : ROOT;
const EXE = exeArgIdx >= 0 ? path.resolve(argv[exeArgIdx + 1]) : null;
const KEEP = argv.includes('--keep');
const TIMEOUT_MS = Number(process.env.GM_DESKTOP_TIMEOUT || 180000);

/* ------------------------------------------------------------------ *
 * 找一个可执行的 Electron
 * ------------------------------------------------------------------ */

function findElectronBinary() {
  // 直接指定了可执行文件（免安装版 exe、或已安装到 Program Files 的 exe）
  if (EXE) {
    if (!fs.existsSync(EXE)) throw new Error(`找不到可执行文件：${EXE}`);
    return { bin: EXE, args: [], kind: 'exe' };
  }

  // 打包产物：目录里直接有 exe（名字来自 productName）
  if (APP_DIR !== ROOT) {
    const exe = fs
      .readdirSync(APP_DIR)
      .filter((f) => f.toLowerCase().endsWith('.exe'))
      .map((f) => path.join(APP_DIR, f))
      .find((p) => !/uninstall/i.test(path.basename(p)));
    if (exe) return { bin: exe, args: [], kind: 'packaged' };
    throw new Error(`在 ${APP_DIR} 里找不到 .exe，确认这是 win-unpacked 目录`);
  }

  // 开发态：用 node_modules 里的 electron
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  ];
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('找不到 Electron，请先 npm install');
  return { bin, args: [ROOT], kind: 'dev' };
}

/* ------------------------------------------------------------------ *
 * 环境：必须清掉会改变 Electron 行为的变量
 * ------------------------------------------------------------------ */

function buildEnv(dataDir, outFile) {
  const env = { ...process.env };

  // ★ ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node，永远进不了 GUI。
  //   某些终端/沙箱环境会全局设上它，这里必须显式清掉，否则整轮测试全是假失败。
  delete env.ELECTRON_RUN_AS_NODE;

  // NODE_OPTIONS 里的 --require 补丁会注入到 Electron 主进程，可能干扰启动
  delete env.NODE_OPTIONS;

  env.GM_DESKTOP_SELFTEST = '1';
  env.GM_DATA_DIR = dataDir;
  env.GM_SELFTEST_OUT = outFile;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  return env;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-desktop-check-'));
const dataDir = path.join(tmpRoot, 'data');
const outFile = path.join(tmpRoot, 'result.txt');
fs.mkdirSync(dataDir, { recursive: true });

function cleanup() {
  if (KEEP) {
    console.log(`\n临时目录已保留：${tmpRoot}`);
    return;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔文件被占用，忽略 */
  }
}

const { bin, args, kind } = findElectronBinary();

const kindLabel =
  kind === 'dev' ? '开发态（项目目录）' : kind === 'exe' ? '可执行文件' : '打包产物';

console.log('桌面端冒烟测试');
console.log('─────────────────────────────────────────────');
console.log(`  被测目标  ${kindLabel}`);
console.log(`  可执行    ${bin}`);
console.log(`  数据目录  ${dataDir}（临时，不碰真实 data/）`);
console.log('');

const child = spawn(bin, args, {
  env: buildEnv(dataDir, outFile),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  stdout += c;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  stderr += c;
});

const timer = setTimeout(() => {
  console.log('!! 超时，强制结束');
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}, TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timer);

  // 优先读文件：打包成 GUI 程序后 stdout 可能接不到父控制台
  let output = stdout;
  if (fs.existsSync(outFile)) {
    output = fs.readFileSync(outFile, 'utf8');
  }

  const lines = output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const checks = lines.filter((l) => /^(PASS|FAIL)\s/.test(l));
  const summaryLine = lines.find((l) => l.startsWith('GM_SELFTEST '));

  for (const l of checks) console.log(`  ${l}`);

  if (stderr.trim()) {
    console.log('\n--- stderr ---');
    console.log(stderr.trim().split('\n').slice(-15).join('\n'));
  }

  let summary = null;
  if (summaryLine) {
    try {
      summary = JSON.parse(summaryLine.slice('GM_SELFTEST '.length));
    } catch {
      /* 下面按失败处理 */
    }
  }

  console.log('');
  console.log('═════════════════════════════════════════════');
  if (!checks.length) {
    console.log('未取到任何断言结果 —— 应用没能跑到自检阶段');
    console.log(`退出码 ${code}`);
    cleanup();
    process.exit(1);
  }

  const failed = checks.filter((l) => l.startsWith('FAIL'));
  console.log(`${summary ? `${summary.passed}/${summary.total} 项通过` : `${checks.length - failed.length}/${checks.length} 项通过`}`);

  if (failed.length === 0 && code === 0) {
    console.log('全部通过 ✓');
    cleanup();
    process.exit(0);
  }

  console.log(`失败 ${failed.length} 项，退出码 ${code}`);
  cleanup();
  process.exit(1);
});

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`无法启动 ${bin}：${e.message}`);
  cleanup();
  process.exit(1);
});
