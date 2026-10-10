/**
 * GitManager 桌面端 · Electron 主进程
 *
 * 设计要点（为什么长这样）：
 *
 * 1. **不重写后端，而是把它当 sidecar 进程拉起来。**
 *    `docs/03-迁移契约与桌面端.md` 定下的三层边界在这里兑现：`server/core/**` 与传输无关、
 *    `web/**` 与宿主无关，所以桌面端只需要「接线」——`server/` 与 `web/` 一行都不用改。
 *
 * 2. **用 Electron 自带的 Node 跑 sidecar（`ELECTRON_RUN_AS_NODE=1`）。**
 *    Electron 二进制本身就是个 Node 运行时，加这个环境变量即以 node CLI 方式运行脚本。
 *    于是**不必再打一份 Node 进去**，省掉约 40MB。
 *
 * 3. **窗口加载 `127.0.0.1:<port>`，而不是 file://。**
 *    这样页面的 CSP、相对路径、fetch 全部照常工作，前端零改动；
 *    同时保留本机令牌机制——它不是多余的：渲染进程万一被注入脚本，
 *    令牌挡不住它（同源就拿得到），但能挡住**其它本机进程**随意驱动 git 写操作。
 *
 * 4. **端口用 0（由系统分配）。** 用户可能同时开着 Web 版（4599），
 *    写死端口会直接起不来。真实端口从 sidecar 的 stdout 里读回来。
 *
 * 5. **数据目录指向 `userData`。** 安装目录可能只读、且升级会被覆盖，
 *    绝不能往里写缓存与凭据。
 */
// 用默认导入再解构，而不是 `import { app } from 'electron'`。
//
// 具名导入在**真实 Electron 模式**下是可用的（已实测），但有个要命的边界：
// 一旦进程带着 `ELECTRON_RUN_AS_NODE=1` 运行，`electron` 就不再是 Electron 的内建模块，
// 而是被解析成 `node_modules/electron/index.js` —— 那玩意导出的是**二进制路径字符串**。
// 于是具名导入会在模块解析期直接抛
//   SyntaxError: The requested module 'electron' does not provide an export named 'app'
// 连一行代码都执行不到，报错信息还完全指不到真正的成因。
//
// 默认导入在两种模式下都不会炸，所以这里用它，省得哪天调试时被这个假象带偏。
import electron from 'electron';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = electron;

/**
 * 无人值守自检开关（`GM_DESKTOP_SELFTEST=1`）。
 *
 * 这条链路上的问题绝大多数肉眼看不见：sidecar 起来了但窗口连不上、
 * preload 没注入、令牌没传对、前端 JS 报错导致界面空白……
 * 所以让应用自己「启动 → 断言 → 退出」，把结果打到 stdout。
 * 这也是本项目一直强调的：测试全绿 ≠ 功能可用，必须真的把它跑起来。
 */
const SELFTEST = process.env.GM_DESKTOP_SELFTEST === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'index.js');
const IS_WIN = process.platform === 'win32';

/** 与 server/core/dialog.js#readTextFile 保持一致的上限，避免两个入口行为分叉 */
const MAX_TEXT_BYTES = 1024 * 1024;

let win = null;
let sidecar = null;
let readyInfo = null;
let quitting = false;
let starting = false;

/* ------------------------------------------------------------------ *
 * sidecar 生命周期
 * ------------------------------------------------------------------ */

/**
 * 数据目录（仓库列表 / 操作日志 / 加密凭据）放哪。
 *
 * - **打包后**：`userData`（如 `%APPDATA%\GitManager`）。绝不能写安装目录 ——
 *   安装目录可能只读，且升级覆盖时会把用户数据一起抹掉。
 * - **开发态**：与 Web 版共用项目里的 `data/`，这样 `npm run desktop` 与
 *   `npm run start` 看到的是同一批仓库，不会以为是「两个 App」。
 * - 两者都可被外部 `GM_DATA_DIR` 覆盖 —— 自检脚本正是靠它把数据指到临时目录，
 *   从而在不污染真实数据的前提下验证打包产物。
 */
function resolveDataDir() {
  if (process.env.GM_DATA_DIR) return path.resolve(process.env.GM_DATA_DIR);
  return app.isPackaged ? app.getPath('userData') : path.join(APP_ROOT, 'data');
}

function startSidecar() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // 让 Electron 二进制以纯 Node 模式运行我们的服务
    env.ELECTRON_RUN_AS_NODE = '1';
    env.GM_DATA_DIR = resolveDataDir();
    // 清掉可能从外部继承来的端口，确保 --port 0 生效
    delete env.GM_PORT;

    sidecar = spawn(process.execPath, [SERVER_ENTRY, '--port', '0', '--quiet'], {
      cwd: APP_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`本地服务启动超时。\n\n${stderr.slice(-2000)}`));
    }, 20000);

    sidecar.stdout.setEncoding('utf8');
    sidecar.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (settled) return;
      const line = stdout.split('\n').find((l) => l.startsWith('GM_READY '));
      if (!line) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line.slice('GM_READY '.length)));
      } catch (e) {
        reject(new Error(`无法解析服务启动信息：${e.message}`));
      }
    });

    sidecar.stderr.setEncoding('utf8');
    sidecar.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    sidecar.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动本地服务：${e.message}`));
    });

    sidecar.on('exit', (code) => {
      sidecar = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`本地服务启动时即退出（code=${code}）。\n\n${stderr.slice(-2000)}`));
        return;
      }
      // 已经跑起来之后才挂 —— 可能是崩溃，也可能是用户从菜单主动重启
      if (quitting || starting) return;
      dialog.showErrorBox('GitManager 的后台服务已停止', `服务进程意外退出（code=${code}）。\n\n${stderr.slice(-2000)}`);
      app.quit();
    });
  });
}

function stopSidecar() {
  if (!sidecar) return;
  const child = sidecar;
  sidecar = null;
  try {
    child.kill();
  } catch {
    /* 进程可能已经没了 */
  }
}

/* ------------------------------------------------------------------ *
 * 外链
 * ------------------------------------------------------------------ */

/**
 * 页面里的外链（OAuth 设备码地址、仓库地址等）必须交给系统浏览器打开。
 * `window.open` 与 `<a target="_blank">` 在 Electron 里不会自动出去。
 * 只放行 http(s)：`file:` / `javascript:` 这类一律拒绝。
 */
function openExternal(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  shell.openExternal(url.href).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ *
 * 原生文件对话框（替换 server/core/dialog.js 的 PowerShell 方案）
 * ------------------------------------------------------------------ */

/** '所有文件|*.*' → [{ name:'所有文件', extensions:['*'] }]；支持 '*.txt;*.md' 多模式 */
function parseFilter(spec) {
  const out = [];
  for (const part of String(spec || '').split(';;')) {
    const [label, patterns] = part.split('|');
    if (!label || !patterns) continue;
    const exts = patterns
      .split(';')
      .map((p) => p.trim().replace(/^\*\.?/, ''))
      .filter(Boolean);
    if (exts.length) out.push({ name: label, extensions: exts });
  }
  return out.length ? out : [{ name: '所有文件', extensions: ['*'] }];
}

/** 与 server/core/dialog.js#readTextFile 同样的判定：超限 / 二进制 / 正常文本 */
async function readTextFileSafe(filePath) {
  const p = path.resolve(String(filePath));
  const st = await fs.stat(p);
  const name = path.basename(p);
  if (st.size > MAX_TEXT_BYTES) return { tooBig: true, size: st.size, name };
  const buf = await fs.readFile(p);
  if (buf.includes(0)) return { binary: true, size: st.size, name };
  return { content: buf.toString('utf8'), size: st.size, name };
}

function registerIpc() {
  ipcMain.handle('gm:dialog:pickFolder', async (_evt, opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: String(opts.title || '选择一个文件夹'),
      defaultPath: opts.defaultPath ? String(opts.defaultPath) : undefined,
      properties: ['openDirectory', 'dontAddToRecent'],
      buttonLabel: '选择',
    });
    const picked = r.filePaths?.[0];
    if (r.canceled || !picked) return { ok: true, cancelled: true };
    return { ok: true, cancelled: false, path: picked };
  });

  ipcMain.handle('gm:dialog:pickFile', async (_evt, opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: String(opts.title || '选择一个文件'),
      defaultPath: opts.defaultPath ? String(opts.defaultPath) : undefined,
      properties: ['openFile', 'dontAddToRecent'],
      filters: parseFilter(opts.filter),
      buttonLabel: '选择',
    });
    const picked = r.filePaths?.[0];
    if (r.canceled || !picked) return { ok: true, cancelled: true };

    const base = { ok: true, cancelled: false, path: picked };
    if (!opts.withContent) return base;
    try {
      return { ...base, ...(await readTextFileSafe(picked)) };
    } catch (e) {
      return { ...base, readError: e.message };
    }
  });

  ipcMain.handle('gm:app:info', async () => ({
    productName: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    dataDir: resolveDataDir(),
    port: readyInfo?.port ?? null,
  }));

  ipcMain.handle('gm:app:openDataDir', async () => {
    await shell.openPath(resolveDataDir());
    return { ok: true };
  });

  // 服务重启：换网络环境 / 令牌失效后不用整个重开应用
  ipcMain.handle('gm:app:restartSidecar', async () => {
    stopSidecar();
    starting = true;
    try {
      readyInfo = await startSidecar();
      await win?.loadURL(`http://127.0.0.1:${readyInfo.port}/`);
      return { ok: true, port: readyInfo.port };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      starting = false;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 窗口与菜单
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载界面', accelerator: 'F5', click: () => win?.webContents.reload() },
        { label: '重启后台服务', click: () => ipcMain.emit('gm:menu:restart') },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(resolveDataDir()) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 GitManager', click: () => showAbout() },
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于 GitManager',
    message: `GitManager ${app.getVersion()}`,
    detail:
      `本地 Git 仓库可视化体检与维护中枢\n\n` +
      `Electron ${process.versions.electron} · Node ${process.versions.node}\n` +
      `数据目录 ${resolveDataDir()}\n\n` +
      `所有分析都在本机完成，不上传任何仓库数据。`,
    buttons: ['好'],
  });
}

async function createWindow(info) {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    title: 'GitManager',
    // 与页面深色底一致，避免启动瞬间白屏闪一下
    backgroundColor: '#1C1C1E',
    autoHideMenuBar: true,
    icon: IS_WIN ? path.join(__dirname, 'build', 'icon.ico') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 页面是本机服务，允许直接加载
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => {
    if (!SELFTEST) win.show();
  });

  // 页面标题会覆盖窗口标题，统一成产品名
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('GitManager');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    const self = `http://127.0.0.1:${info.port}`;
    if (!url.startsWith(self)) {
      e.preventDefault();
      openExternal(url);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('界面进程异常', `渲染进程退出：${details.reason}`);
  });

  await win.loadURL(`http://127.0.0.1:${info.port}/`);
}

/* ------------------------------------------------------------------ *
 * 无人值守自检
 * ------------------------------------------------------------------ */

async function runSelfTest(info) {
  const rows = [];
  const check = (name, pass, extra) => rows.push({ name, pass: !!pass, extra: extra ?? '' });

  /**
   * 结果同时写 stdout 和（可选）一个文件。
   * 打包后的 exe 是 GUI 程序，stdout 不一定接得到父控制台 —— 靠文件才稳，
   * 验证脚本因此能在任何终端环境下拿到结果。
   */
  const lines = [];
  const emit = (line) => {
    lines.push(line);
    process.stdout.write(`${line}\n`);
  };

  const js = (code) => win.webContents.executeJavaScript(code);

  try {
    check('sidecar 已就绪并回报端口', Number(info.port) > 0, `port=${info.port}`);
    check('令牌已下发且长度合理', typeof info.token === 'string' && info.token.length >= 32, `len=${info.token?.length}`);

    const title = await js('document.title');
    check('窗口已加载页面', !!title, `title=${JSON.stringify(title)}`);

    const brand = await js('(window.__GM__||{}).version');
    check('页面读到版本号', brand === info.version, `version=${brand}`);

    const tok = await js('(window.__GM__||{}).token || ""');
    check('页面拿到本机令牌', tok.length >= 32, `len=${tok.length}`);

    const hasDesktop = await js('!!(window.gmDesktop && window.gmDesktop.isDesktop)');
    check('preload 已注入 gmDesktop 桥', hasDesktop);

    const skeleton = await js(
      '!!(document.querySelector(".app") && document.querySelector("#nav") && document.querySelector("#view"))',
    );
    check('前端已渲染出界面骨架', skeleton);

    const buildTag = await js('(document.querySelector("#build-tag")||{}).textContent || ""');
    check('构建版本标签已填充', /v\d/.test(buildTag), `tag=${JSON.stringify(buildTag)}`);

    const api = await js(`
      (async () => {
        const t = (window.__GM__ || {}).token;
        const r = await fetch('/api/repos', { headers: { 'x-gm-token': t } });
        let body = null;
        try { body = await r.json(); } catch {}
        return { status: r.status, repos: Array.isArray(body && body.repos) ? body.repos.length : -1 };
      })()
    `);
    check('页面经 HTTP 打通本机 API', api.status === 200 && api.repos >= 0, `status=${api.status} repos=${api.repos}`);

    const noToken = await js(`
      (async () => {
        const r = await fetch('/api/repos');
        return r.status;
      })()
    `);
    check('无令牌请求被拒绝（403）', noToken === 403, `status=${noToken}`);

    // 桌面端专属：对话框桥必须真的可调用（走 IPC 到主进程再回来）
    const bridge = await js('typeof (window.gmDesktop && window.gmDesktop.pickFolder)');
    check('原生对话框桥可调用', bridge === 'function');

    const dataDir = resolveDataDir();
    check('数据目录已就绪', fsSync.existsSync(dataDir), dataDir);

    const override = process.env.GM_DATA_DIR;
    const inAppDir = path.resolve(dataDir).startsWith(path.resolve(APP_ROOT) + path.sep);

    if (override) {
      // 自检脚本靠这个把数据指到临时目录 —— 必须真的生效，否则下一步就是在啃真实数据
      check('GM_DATA_DIR 覆盖已生效', path.resolve(dataDir) === path.resolve(override), dataDir);
      // 曾经的教训：store.js 不认 GM_DATA_DIR，跑一次测试就把真实 data/store.json 写脏。
      // 这条断言就是那个坑的回归守卫。
      check(
        '隔离目录不等于真实 data/（防测试污染真实数据）',
        path.resolve(dataDir) !== path.resolve(APP_ROOT, 'data'),
        dataDir,
      );
    } else if (app.isPackaged) {
      // 安装目录可能只读，且升级覆盖时会连用户数据一起抹掉 —— 打包态这条是硬要求
      check('打包后数据目录不在应用目录内', !inAppDir, `dataDir=${dataDir}`);
    } else {
      // 开发态是有意与 Web 版共用项目里的 data/，这样两个入口看到同一批仓库
      check('开发态与 Web 版共用项目 data/（预期行为）', inAppDir, `dataDir=${dataDir}`);
    }
  } catch (e) {
    check('自检过程中抛出异常', false, String(e?.message || e));
  }

  for (const r of rows) {
    emit(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  emit(`GM_SELFTEST ${JSON.stringify({ passed, total: rows.length, port: info.port, packaged: app.isPackaged })}`);

  const outFile = process.env.GM_SELFTEST_OUT;
  if (outFile) {
    try {
      fsSync.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
    } catch {
      /* 写不了就算了，stdout 已经尽力 */
    }
  }

  quitting = true;
  stopSidecar();
  app.exit(passed === rows.length ? 0 : 1);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function bootstrap() {
  app.setAppUserModelId('com.gitmanager.desktop');

  ipcMain.on('gm:menu:restart', async () => {
    stopSidecar();
    starting = true;
    try {
      readyInfo = await startSidecar();
      await win?.loadURL(`http://127.0.0.1:${readyInfo.port}/`);
    } catch (e) {
      dialog.showErrorBox('重启后台服务失败', e.message);
    } finally {
      starting = false;
    }
  });

  registerIpc();
  buildMenu();

  try {
    readyInfo = await startSidecar();
  } catch (e) {
    // 自检模式下不能弹模态框：那会一直挂着等人点，无人值守直接卡死
    if (SELFTEST) {
      const brief = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 400);
      const lines = [`FAIL  启动失败  (${brief})`, `GM_SELFTEST ${JSON.stringify({ passed: 0, total: 1 })}`];
      process.stdout.write(`${lines.join('\n')}\n`);
      const outFile = process.env.GM_SELFTEST_OUT;
      if (outFile) {
        try {
          fsSync.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
        } catch {
          /* ignore */
        }
      }
      app.exit(1);
      return;
    }
    dialog.showErrorBox('GitManager 启动失败', String(e?.message || e));
    app.quit();
    return;
  }

  await createWindow(readyInfo);

  if (SELFTEST) {
    // 留出首屏渲染与首次数据拉取的时间，否则会误判「骨架未渲染」
    await new Promise((r) => setTimeout(r, 1800));
    await runSelfTest(readyInfo);
  }
}

if (!app.requestSingleInstanceLock()) {
  // 已经有实例在跑：直接退出，让已有窗口接管
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(bootstrap);

  app.on('window-all-closed', () => {
    quitting = true;
    stopSidecar();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopSidecar();
  });

  // sidecar 是子进程，主进程被强杀时它不会自己走，这里兜一层
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      quitting = true;
      stopSidecar();
      app.quit();
    });
  }
}
