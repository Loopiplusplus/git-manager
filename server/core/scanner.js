import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/* ============================================================================
 *  只读扫描器
 * ============================================================================
 *
 *  安全承诺（写进代码，不是写进口头约定）：
 *
 *  1. 只使用 readdir + lstat 两种系统调用 —— 没有任何写操作，一个字节都不写。
 *     连缓存都只写进本项目的 data/ 目录，绝不写进被扫描的目录。
 *  2. 绝不跟随符号链接 / 目录联接（junction）—— 避免死循环和「跑到盘外去」。
 *  3. 每一次入队都做路径包含性校验，确保结果严格落在扫描根目录之内。
 *  4. 三重预算（深度 / 目录数 / 时间）硬上限，防止失控扫爆整个磁盘。
 *  5. 跳过系统目录与重量级缓存目录，既提速也避免触碰操作系统区域。
 *  6. 判定「是否仓库」只看 `.git` 是否存在，不读不解析其内容。
 *
 *  换句话说：即使扫描过程中断电，被扫描的磁盘也不会产生任何变化。
 * ========================================================================== */

/** 跳过的目录名（小写比较）。仅影响效率，不影响正确性。 */
const SKIP_DIRS = new Set([
  // Windows 系统区域 —— 不碰
  'windows', 'system volume information', '$recycle.bin', 'recovery', 'perflogs',
  'program files', 'program files (x86)', 'programdata', 'appdata', 'msocache',
  '$windows.~bt', '$windows.~ws', 'onedrivetemp', 'config.msi',
  // 依赖 / 缓存 / 构建产物 —— 体积巨大且几乎不可能有用户的仓库
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache', '.npm',
  '.pnpm-store', '.yarn', '.gradle', '.m2', '.cargo', '.rustup', '.conda',
  'site-packages', '.next', '.nuxt', '.turbo', '.parcel-cache', '.tox', '.pytest_cache',
  // 类 Unix
  'library', '.trash', 'snap', 'proc', 'sys', 'dev', 'run', 'lost+found',
]);

const MAX_FOUND = 2000;

const jobs = new Map();

/** 参数错误 → HTTP 400（默认的 500 会掩盖调用方的问题） */
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function isSkip(name) {
  return SKIP_DIRS.has(name.toLowerCase());
}

function normCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 路径包含性校验：child 必须严格位于 root 之内 */
function isInside(root, child) {
  const r = normCase(path.resolve(root)) + path.sep;
  const c = normCase(path.resolve(child)) + path.sep;
  return c.startsWith(r);
}

/** 探测某个目录本身是不是 git 仓库（只 lstat 一次，不解引用符号链接） */
async function detectRepo(dir) {
  try {
    const st = await fsp.lstat(path.join(dir, '.git'));
    return { isRepo: true, kind: st.isDirectory() ? 'dir' : 'file' };
  } catch {
    return { isRepo: false };
  }
}

/* ---------------------------------------------------------------- 驱动器 */

export function listDrives() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c += 1) {
      const letter = String.fromCharCode(c);
      const p = `${letter}:\\`;
      try {
        if (fs.existsSync(p)) out.push({ path: p, label: `${letter}:` });
      } catch {
        /* 无权限或无此盘，跳过 */
      }
    }
  } else {
    out.push({ path: '/', label: '根目录 /' });
  }
  return out;
}

/* ------------------------------------------------------------------ 扫描 */

function runScan(job, { maxDepth, budgetMs, maxDirs }) {
  return new Promise((resolve) => {
    const root = job.root;
    const queue = [{ dir: root, depth: 0 }];

    const step = async () => {
      try {
        while (queue.length) {
          if (job.cancelled) { job.status = 'cancelled'; break; }
          if (Date.now() - job.startedAt > budgetMs) { job.status = 'timeout'; break; }
          if (job.scannedDirs >= maxDirs) { job.status = 'limit'; break; }

          const { dir, depth } = queue.shift();
          job.scannedDirs += 1;
          job.current = dir;

          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            job.errors += 1;
            continue;
          }

          let hasGit = false;
          for (const e of entries) {
            // 关键安全点：不跟随符号链接 / 联接点
            if (e.isSymbolicLink()) continue;

            if (e.isDirectory()) {
              if (e.name === '.git') hasGit = true;
              else if (depth < maxDepth && !isSkip(e.name)) {
                const child = path.join(dir, e.name);
                if (isInside(root, child)) queue.push({ dir: child, depth: depth + 1 });
              }
            } else if (e.isFile() && e.name === '.git') {
              hasGit = true; // worktree / submodule 用的是 .git 文件
            }
          }

          if (hasGit && job.found.length < MAX_FOUND) {
            job.found.push({
              path: dir,
              name: path.basename(dir) || dir,
              depth,
              parent: path.dirname(dir),
            });
          }

          job.queueLen = queue.length;
          // 让出事件循环：保证可取消、不长时间占满 CPU 与磁盘
          await new Promise((r) => setImmediate(r));
        }
        if (job.status === 'running') job.status = 'done';
      } catch (e) {
        job.status = 'error';
        job.message = e.message;
      }
      job.endedAt = Date.now();
      job.elapsedMs = job.endedAt - job.startedAt;
      resolve(job);
    };

    step();
  });
}

export function startScan(root, opts = {}) {
  if (!root || typeof root !== 'string') throw bad('缺少扫描根目录');
  const abs = path.resolve(root.trim());
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw bad(`目录不存在：${abs}`);
  }
  if (!st.isDirectory()) throw bad('扫描根必须是目录，不能是文件');

  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    root: abs,
    status: 'running',
    startedAt: Date.now(),
    scannedDirs: 0,
    found: [],
    errors: 0,
    current: abs,
    queueLen: 0,
    cancelled: false,
  };
  jobs.set(job.id, job);

  // 硬上限：深度 ≤ 10，时间 ≤ 5 分钟，目录数 ≤ 40 万
  const maxDepth = Math.min(Math.max(Number(opts.maxDepth) || 5, 1), 10);
  const budgetMs = Math.min(Math.max(Number(opts.budgetMs) || 180000, 5000), 300000);
  const maxDirs = Math.min(Math.max(Number(opts.maxDirs) || 400000, 1000), 400000);
  job.maxDepth = maxDepth;

  runScan(job, { maxDepth, budgetMs, maxDirs }).then(() => {
    // 任务保留 10 分钟供前端轮询，之后清理
    setTimeout(() => jobs.delete(job.id), 600000).unref?.();
  });

  return job;
}

export function getScan(id) {
  return jobs.get(id) || null;
}

export function cancelScan(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.cancelled = true;
  return job;
}

/** 输出给前端的精简视图 */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    root: job.root,
    status: job.status,
    scannedDirs: job.scannedDirs,
    queueLen: job.queueLen,
    errors: job.errors,
    current: job.current,
    maxDepth: job.maxDepth,
    elapsedMs: job.endedAt ? job.endedAt - job.startedAt : Date.now() - job.startedAt,
    found: job.found,
    foundCount: job.found.length,
    message: job.message,
  };
}

/* ------------------------------------------------------ 单目录探测（选择后） */

/**
 * 用户选中一个目录后的判定：
 *   1. 它自己是不是仓库？
 *   2. 不是的话，它是不是在某个仓库内部？（向上找）
 *   3. 都不是的话，浅扫一层找嵌套仓库。
 */
export async function probeFolder(input) {
  if (!input || typeof input !== 'string') throw bad('缺少路径');
  const abs = path.resolve(input.trim());

  const out = {
    path: abs,
    exists: false,
    isRepo: false,
    isInsideRepo: false,
    repoRoot: null,
    gitKind: null,
    childRepos: [],
    scanned: false,
  };

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    out.reason = 'not-found';
    return out;
  }
  if (!st.isDirectory()) {
    out.reason = 'not-a-directory';
    return out;
  }
  out.exists = true;

  // 1) 自身
  const self = await detectRepo(abs);
  if (self.isRepo) {
    out.isRepo = true;
    out.repoRoot = abs;
    out.gitKind = self.kind;
    return out;
  }

  // 2) 向上找父级仓库（限制 40 层，到盘根即停）
  let cur = path.dirname(abs);
  for (let i = 0; i < 40; i += 1) {
    const r = await detectRepo(cur);
    if (r.isRepo) {
      out.isInsideRepo = true;
      out.repoRoot = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 3) 浅扫（深度 2、4 秒、5000 目录）找子仓库
  try {
    const job = {
      id: `probe-${Date.now()}`,
      root: abs,
      status: 'running',
      startedAt: Date.now(),
      scannedDirs: 0,
      found: [],
      errors: 0,
      current: abs,
      queueLen: 0,
      cancelled: false,
    };
    await runScan(job, { maxDepth: 2, budgetMs: 4000, maxDirs: 5000 });
    out.childRepos = job.found.filter((f) => path.resolve(f.path) !== abs);
    out.scanned = true;
    out.scannedDirs = job.scannedDirs;
    if (out.childRepos.length === 1 && path.resolve(out.childRepos[0].path) === abs) out.childRepos = [];
  } catch {
    out.scanned = false;
  }

  return out;
}

export { detectRepo };
