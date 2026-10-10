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
  'update-ref', // 收窄：只允许操作 refs/gm/**，见 assertSafeUpdateRef
  'show-ref',
  'config',
  'merge-base',
  'cat-file',
  'add',
  'commit',
  'clone', // 仅允许由 clone.js 以固定参数调用；URL 与目标路径在那里单独校验
  // —— 以下三个走「窄化专用校验」，见 assertSafePush / assertSafeRemote / assertSafeFetch，
  //    不走下面通用的 flag 黑名单（因为它们的参数形态完全固定）。
  'remote',
  'fetch',
  'push',
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
// 注意 push 不在这里 —— 它由 assertSafePush 以「只允许 origin + 单一分支名」的
// 窄化形态开放，见下方。撤销 / 合并 / rebase 等仍然整条熔断。
const FORBIDDEN_SUBCMDS = new Set(['gc', 'clean', 'reset', 'checkout', 'rebase', 'merge']);

/* ------------------------------------------------------------------
   窄化写操作校验：remote / fetch / push

   这三个子命令的参数形态是固定的，因此不走通用 flag 黑名单，而是逐个
   精确校验。核心约束：
     - 远端名只允许 origin（不接受任意 remote，避免把代码推到别处）
     - 远端地址必须是 https://github.com/owner/name(.git)
     - push 的 refspec 只能是「单个分支名」，从而结构性排除
       --force / +refspec / --mirror / --all / --tags / --delete 等一切
       强制或批量推送形态
   ------------------------------------------------------------------ */

const REMOTE_NAME_OK = /^[A-Za-z0-9._-]{1,60}$/;
const REFSPEC_OK = /^[A-Za-z0-9._/-]{1,200}$/;
const ALLOWED_REMOTE = 'origin';

/** 只接受 https://github.com/owner/name(.git) */
export function isSafeGithubUrl(u) {
  const raw = String(u || '');
  // 必须在**原始字符串**上查 ..：WHATWG URL 解析器会先把 ../ 归一化掉，
  // 于是 https://github.com/../../etc/passwd 会变成 pathname=/etc/passwd，
  // 事后查 pathname 什么都查不到，还会被当成一个「合法」的两段式地址放过。
  if (/(^|[/:\\])\.\.([/\\:]|$)/.test(raw) || raw.includes('%2e%2e')) return false;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return false;
  if (url.search || url.hash) return false;
  const seg = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (seg.length !== 2) return false;
  const name = seg[1].replace(/\.git$/, '');
  const ok = (s) => /^[A-Za-z0-9._-]+$/.test(s) && !/^\.+$/.test(s);
  return ok(seg[0]) && ok(name);
}

function assertSafeRemote(args) {
  const rest = args.slice(1);
  if (rest.length === 0) return; // git remote（列出远端名）
  if (rest.length === 1 && /^(--verbose|-v)$/.test(rest[0])) return;

  const [op, name, url] = rest;
  if (op === 'get-url') {
    if (rest.length !== 2 || !REMOTE_NAME_OK.test(String(name || ''))) {
      throw new GitError('remote get-url 只接受 <remote>');
    }
    return;
  }
  if (op === 'add' || op === 'set-url') {
    if (rest.length !== 3) throw new GitError(`remote ${op} 需要 <name> <url>`);
    if (name !== ALLOWED_REMOTE) throw new GitError(`只允许操作 ${ALLOWED_REMOTE} 远端，收到：${name}`);
    if (!isSafeGithubUrl(url)) throw new GitError(`远端地址必须是 https://github.com/owner/name(.git)，收到：${url}`);
    return;
  }
  throw new GitError(`remote 子操作不在白名单：${op}`);
}

function assertSafeFetch(args) {
  const rest = args.slice(1);
  const name = rest[0];
  if (name !== ALLOWED_REMOTE) throw new GitError(`fetch 只允许 ${ALLOWED_REMOTE}，收到：${name}`);
  const branch = rest[1];
  if (rest.length > 2) throw new GitError('fetch 只接受 `git fetch origin [branch]`');
  if (branch !== undefined && !REFSPEC_OK.test(branch)) throw new GitError(`fetch 的分支名不合法：${branch}`);
}

function assertSafePush(args) {
  const rest = args.slice(1);
  let i = 0;
  if (rest[i] === '-u' || rest[i] === '--set-upstream') i++;
  const remote = rest[i++];
  const refspec = rest[i++];

  if (i !== rest.length) {
    throw new GitError('push 只接受 `git push [-u|--set-upstream] <remote> <branch>` 这一种形式');
  }
  if (remote !== ALLOWED_REMOTE) throw new GitError(`push 只允许推送到 ${ALLOWED_REMOTE}，收到：${remote}`);
  if (!refspec || !REFSPEC_OK.test(refspec) || /\.\./.test(refspec)) {
    throw new GitError(`push 的分支名不合法：${refspec}`);
  }
}

/* ---------------------------------------------------------------- 分支 */

/**
 * 分支名的唯一校验入口。
 *
 * 刻意**不**去调 `git check-ref-format` 来判定：那要给引擎再开一个子命令白名单，
 * 而且名字以 `-` 开头时它自己也会被当成选项解析，反而更绕。
 * 用字符集 + 结构规则把 git 的 ref 约束表达清楚，足够且可测。
 *
 * 规则来源：git-check-ref-format(1)。这里把「能表达的」都表达了 ——
 * 字符集排除空格与 ~ ^ : ? * [ \ 及控制字符；再单独挡掉前导 `-`/`.`、结尾 `.`/`.lock`、
 * 以及 `..` `//` `@{` 这些 git 明确禁止的组合。
 */
const BRANCH_NAME_RE = /^[A-Za-z0-9._/@-]{1,200}$/;

export function assertBranchName(name, label = '分支名') {
  const s = String(name ?? '');
  if (!s) throw new GitError(`缺少${label}`);
  if (!BRANCH_NAME_RE.test(s)) {
    throw new GitError(`${label}只能包含字母、数字与 . _ / @ - ：${s}`);
  }
  if (s.startsWith('-') || s.startsWith('.') || s.startsWith('/')) {
    throw new GitError(`${label}不能以 - . / 开头：${s}`);
  }
  if (s.endsWith('.') || s.endsWith('/') || s.endsWith('.lock')) {
    throw new GitError(`${label}不能以 . / .lock 结尾：${s}`);
  }
  if (s.includes('..') || s.includes('//') || s.includes('@{') || s === '@') {
    throw new GitError(`${label}不符合 git 的 ref 规则：${s}`);
  }
  return s;
}

/** 只读的列举形态：`git branch --format=… --merged` 这类，全部参数都得是这些 flag */
const BRANCH_READONLY_FLAG =
  /^(--merged|--no-merged|--all|--remotes|-a|-r|--verbose|-v|--list|--no-column|--column(=.+)?|--color(=.+)?|--sort=.+|--format=.+|--points-at=.+)$/;

/**
 * `branch` 是第五个「窄化」子命令。
 *
 * 它此前走通用 flag 黑名单，因此 `-d` / `-D` 被整条熔断 —— 结果就是**删分支这个能力
 * 在引擎层压根不存在**，界面上自然也没有（用户反馈「不能在可视化页面添删分支」）。
 * 这里改成固定形态白名单：能写出来的只有这几种，其余的连语法都凑不出来。
 *
 * | 形态 | 含义 | 等级 |
 * |---|---|---|
 * | `branch` | 列出本地分支 | 只读 |
 * | `branch <只读flag…>` | 列举（analyzer 用的 `--format=… --merged`） | 只读 |
 * | `branch <name> [<起点>]` | 新建分支 | L1 可回滚写 |
 * | `branch -d <name>` | 删除已合并分支（git 自己会拒绝未合并的） | L2 |
 * | `branch -D <name>` | 强制删除 | L2 |
 *
 * 注意 `-d` / `-D` 的区别是**交给 git 去挡**：`-d` 遇到未合并分支会失败，
 * 这就是我们希望的第二道防线，不要自己实现合并判断去替代它。
 */
function assertSafeBranch(args) {
  const rest = args.slice(1);

  if (rest.length === 0) return; // git branch：列出本地分支

  if (rest[0] === '-d' || rest[0] === '-D') {
    if (rest.length !== 2) throw new GitError('branch 删除只接受 `git branch -d|-D <name>` 这一种形式');
    assertBranchName(rest[1]);
    return;
  }

  // 只读列举：必须全是只读 flag，不接受任何位置参数
  if (rest.every((a) => typeof a === 'string' && a.startsWith('-') && BRANCH_READONLY_FLAG.test(a))) return;

  // 新建：branch <name> [<起点>]
  if (rest.length === 1) {
    assertBranchName(rest[0]);
    return;
  }
  if (rest.length === 2 && !rest[0].startsWith('-')) {
    assertBranchName(rest[0]);
    assertBranchName(rest[1], '起点');
    return;
  }

  throw new GitError(`branch 参数不在白名单：${rest.join(' ')}`);
}

/* ------------------------------------------------------- update-ref */

/**
 * 我们自己维护的命名空间。`update-ref` 是引擎里唯一能「凭空造 / 删引用」的命令，
 * 所以把它也收窄到 refs/gm/** 之内：
 *
 *   update-ref <refs/gm/…> <sha|HEAD>     建 / 移动引用
 *   update-ref -d <refs/gm/…>             删除引用（收窄口子）
 *
 * 好处是 `update-ref -d refs/heads/main` 这种「用底层命令删掉用户分支」的写法
 * **在语法层面就凑不出来** —— 与 push / branch 同一思路，比逐条枚举黑名单可靠。
 * 顺带解决了删除分支失败后清理回滚点的需求（见 safety.js#deleteBranch）。
 */
const GM_REF = /^refs\/gm\/[A-Za-z0-9._@/-]{1,200}$/;

function assertSafeUpdateRef(args) {
  const rest = args.slice(1);
  if (rest[0] === '-d') {
    if (rest.length !== 2) throw new GitError('update-ref 删除只接受 `update-ref -d <refs/gm/…>`');
    if (!GM_REF.test(rest[1])) throw new GitError(`update-ref 只能删除 refs/gm/ 下的引用，收到：${rest[1]}`);
    return;
  }
  if (rest.length === 2 && GM_REF.test(rest[0]) && typeof rest[1] === 'string' && !rest[1].startsWith('-')) return;
  throw new GitError(`update-ref 参数不在白名单（只允许操作 refs/gm/ 下的引用）：${rest.join(' ')}`);
}

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

  // 窄化写操作：参数形态固定，单独校验后直接返回
  if (sub === 'push') return assertSafePush(args);
  if (sub === 'remote') return assertSafeRemote(args);
  if (sub === 'fetch') return assertSafeFetch(args);
  if (sub === 'branch') return assertSafeBranch(args);
  if (sub === 'update-ref') return assertSafeUpdateRef(args);

  for (let idx = 1; idx < args.length; idx++) {
    const a = args[idx];
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
