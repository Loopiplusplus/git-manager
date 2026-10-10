import { execFile } from 'node:child_process';

/**
 * git 引擎 —— 命令白名单层。
 *
 * 安全责任放在这一层，而不是 UI 层：
 * UI 可以被绕过，AI 也可以绕过 UI 直接发指令，只有这里才是真正的护城河。
 */

const ALLOWED = new Set([
  'rev-parse',
  'status',
  'log',
  'for-each-ref',
  'branch',
  'tag',
  'stash',
  'switch',
  'rev-list',
  'ls-files',
  'ls-tree',
  'count-objects',
  'shortlog',
  'symbolic-ref',
  'worktree',
  'diff',
  'update-ref',
  'show-ref',
  'config',
  'merge-base',
  'cat-file',
  'add',
  'commit',
  'clone', // 仅允许由 clone.js 以固定参数调用；URL 与目标路径在那里单独校验
]);

// 破坏性 flag：即使上游拼错参数，也在这里被结构性拦下
const FORBIDDEN_FLAGS = [
  /^--force(-create)?$/,
  /^--force$/,
  /^--hard$/,
  /^--discard-changes$/,
  /^--detach$/,
  /^--overwrite-ignore$/,
  /^--amend$/,
  /^-f$/,
  /^-D$/,
  /^-d$/,
  /^-x$/,
  /^-X$/,

  // —— 以下为 clone 引入的新攻击面 ——
  /^--upload-pack/, // 可指定任意可执行文件 → 远程代码执行
  /^--template/, // 可向新仓库注入任意文件
  /^--separate-git-dir/, // 把 .git 写到仓库外的任意位置
  /^--mirror$/, // 复制全部 refspec，包含 refs/pull 等，语义易失控
  /^--bare$/, // 裸仓库，分析器无法工作，且易误删工作区
  /^--config/, // 绕道写配置
  /^--reference/, // 引用本地路径，可越界读取
  /^--recurse-submodules/, // 子模块 URL 未经校验，等于开了后门
  /^--remote-submodules/,
  /^-c$/, // -c key=value 注入配置
];


// 子命令级熔断：这些写操作暂不开放给引擎
const FORBIDDEN_SUBCMDS = new Set(['gc', 'clean', 'reset', 'checkout', 'rebase', 'merge', 'push']);

export class GitError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = extra.stderr || '';
    this.args = extra.args || [];
  }
}

export function assertSafe(args) {
  if (!Array.isArray(args) || args.length === 0) throw new GitError('空 git 参数');
  const sub = args[0];
  if (typeof sub !== 'string') throw new GitError('git 子命令必须是字符串');
  if (FORBIDDEN_SUBCMDS.has(sub)) throw new GitError(`git 子命令被熔断: ${sub}`);
  if (!ALLOWED.has(sub)) throw new GitError(`git 子命令不在白名单: ${sub}`);
  for (const a of args.slice(1)) {
    if (typeof a !== 'string') throw new GitError('git 参数必须是字符串');
    if (!a.startsWith('-')) continue;
    for (const re of FORBIDDEN_FLAGS) {
      if (re.test(a)) throw new GitError(`禁止使用的 git 参数: ${a}`);
    }
  }
}

/**
 * 执行一条 git 命令，失败抛 GitError。
 * env 用于注入临时凭据（见 clone.js），不会写入任何文件。
 */
export function git(repoPath, args, { timeout = 25000, env } = {}) {
  assertSafe(args);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new GitError(`git ${args[0]} 执行失败`, {
              stderr: String(stderr || '').trim() || String(err.message || ''),
              args,
            }),
          );
          return;
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

/** 执行并返回结果对象，不抛异常 */
export async function gitOk(repoPath, args, opts) {
  try {
    return { ok: true, out: await git(repoPath, args, opts) };
  } catch (e) {
    return { ok: false, out: '', err: e };
  }
}

/** 当前 git 版本，用于自检 */
export async function gitVersion() {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}
