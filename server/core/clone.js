import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import { getToken } from './auth.js';
import { probeRepo } from './github.js';
import { openRepo } from './repo.js';

/**
 * 从 GitHub 克隆仓库到本地。
 *
 * 两个安全要点：
 *
 * 1. URL 白名单。git 支持 `ext::`、`file://`、`ssh://` 等多种传输协议，
 *    其中 `ext::` 可以直接执行任意命令。这里只放行 github.com 的 https 与 ssh 形态，
 *    其余一律拒绝。owner/name 也做字符校验，防止路径回溯。
 *
 * 2. 凭据不落盘。绝不把 token 拼进 clone URL（那会被 git 写进 .git/config，
 *    永久留在磁盘上，还可能被后续 `git remote -v` 打印出来）。
 *    改用环境变量注入一次性 http.extraheader，进程结束即消失。
 */

const OK_HOSTS = new Set(['github.com', 'www.github.com']);

export class CloneError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CloneError';
    // 允许 new CloneError(msg, 'CODE') 的简写形式
    if (typeof extra === 'string') extra = { code: extra };
    this.status = extra.status || 400;
    this.code = extra.code || null;
    this.usedAuth = extra.usedAuth;
    this.leftover = extra.leftover || null;
  }
}

/**
 * 解析仓库地址。接受三种写法：
 *   https://github.com/owner/name(.git)
 *   git@github.com:owner/name(.git)
 *   owner/name
 */
export function parseRepoRef(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new CloneError('请填写仓库地址', 'NO_URL');

  const NAME = /^[A-Za-z0-9._-]+$/;
  const OWNER = /^[A-Za-z0-9._-]+$/;
  if (raw.length > 300) throw new CloneError('仓库地址过长', 'BAD_URL');

  // 必须检查原始字符串：WHATWG URL 解析器会在我们看到之前就把 ../ 归一化掉，
  // 例如 https://github.com/../../etc/passwd 会变成 pathname=/etc/passwd，
  // 只在 pathname 上查 .. 是查不到的。
  // 匹配「作为独立路径片段的 ..」，不会误伤 a..b 这类合法仓库名。
  if (/(^|[/:\\])\.\.([/\\:]|$)/.test(raw)) {
    throw new CloneError('仓库地址中包含 .. 路径片段，已拒绝', 'BAD_URL');
  }

  const check = (owner, name) => {
    if (!OWNER.test(owner) || !NAME.test(name)) throw new CloneError('owner / name 含非法字符', 'BAD_URL');
    // 正则允许 . 与 -，但纯点号（. / .. / ...）必须挡掉
    if (/^\.+$/.test(owner) || /^\.+$/.test(name)) throw new CloneError('owner / name 不能是纯点号', 'BAD_URL');
    return { owner, name };
  };

  // git@github.com:owner/name.git
  let m = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(raw);
  if (m) {
    if (!OK_HOSTS.has(m[1].toLowerCase())) throw new CloneError(`只支持从 github.com 克隆，收到：${m[1]}`, 'BAD_HOST');
    const { owner, name } = check(m[2], m[3]);
    return { owner, name, httpsUrl: `https://github.com/${owner}/${name}.git`, input: raw };
  }

  // 带协议的
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || raw.startsWith('ext::') || raw.startsWith('file:')) {
    if (/^ext::/i.test(raw)) throw new CloneError('ext:: 传输协议可执行任意命令，已被拒绝', 'EXT_BLOCKED');
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new CloneError('仓库地址格式不正确', 'BAD_URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') {
      throw new CloneError(`不支持的协议：${u.protocol}`, 'BAD_PROTOCOL');
    }
    if (!OK_HOSTS.has(u.hostname.toLowerCase())) {
      throw new CloneError(`只支持从 github.com 克隆，收到：${u.hostname}`, 'BAD_HOST');
    }
    // URL 解析器会把 ../ 规范化掉，虽不至于真的越界，但语义上必须直接拒绝，
    // 避免 https://github.com/../../x 被悄悄当成 /x 处理。
    if (/(^|\/)\.\.(\/|$)/.test(u.pathname) || u.pathname.includes('%2e%2e')) {
      throw new CloneError('仓库地址中包含 .. 路径片段，已拒绝', 'BAD_URL');
    }
    const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (seg.length !== 2) throw new CloneError('地址应形如 https://github.com/owner/name', 'BAD_URL');
    const { owner, name } = check(seg[0], seg[1].replace(/\.git$/, ''));
    return { owner, name, httpsUrl: `https://github.com/${owner}/${name}.git`, input: raw };
  }

  // owner/name 简写
  const seg = raw.split('/').filter(Boolean);
  if (seg.length === 2 && seg.every((x) => x !== '..' && x !== '.')) {
    const { owner, name } = check(seg[0], seg[1].replace(/\.git$/, ''));
    return { owner, name, httpsUrl: `https://github.com/${owner}/${name}.git`, input: raw };
  }

  throw new CloneError('无法识别的仓库地址，请输入 owner/name 或完整 GitHub 地址', 'BAD_URL');
}

/** 目录安全性检查：不存在、或是空目录，才允许 clone 进去 */
async function assertTargetUsable(target) {
  let st = null;
  try {
    st = await fsp.stat(target);
  } catch {
    st = null;
  }
  if (!st) return { exists: false, empty: true };
  if (!st.isDirectory()) throw new CloneError(`目标已存在且不是目录：${target}`, 'TARGET_NOT_DIR');
  const entries = await fsp.readdir(target);
  if (entries.length > 0) {
    throw new CloneError(
      `目标目录非空，拒绝覆盖（含 ${entries.length} 项）：${target}\n请换一个位置，或先自行清理该目录。`,
      'TARGET_NOT_EMPTY',
    );
  }
  return { exists: true, empty: true };
}

/**
 * 组装临时 git 配置注入。key 与 value 走环境变量，不进命令行、不落盘。
 *
 * 除鉴权外还注入低速保护：连接被墙/被代理静默丢弃时，git 默认会一直挂着，
 * 加上 lowSpeedLimit/lowSpeedTime 后可在 30 秒内快速失败并给出明确报错。
 */
function gitEnv(token) {
  const cfg = [
    ['http.lowSpeedLimit', '1000'], // 低于 1KB/s
    ['http.lowSpeedTime', '30'], // 持续 30 秒即判定为卡死
  ];
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    cfg.unshift(['http.extraheader', `Authorization: Basic ${basic}`]);
  }

  const env = {
    GIT_TERMINAL_PROMPT: '0', // 禁止 git 弹交互式登录，避免卡死
    GCM_INTERACTIVE: 'never', // 禁止 Git Credential Manager 弹窗
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/**
 * 执行克隆。
 * @param {{url:string, parentDir:string, dirName?:string, shallow?:boolean}} opts
 */
export async function cloneRepo({ url, parentDir, dirName, depth } = {}) {
  const ref = parseRepoRef(url);

  const parent = String(parentDir || '').trim();
  if (!parent) throw new CloneError('请选择要克隆到哪个目录', 'NO_PARENT');

  let parentStat;
  try {
    parentStat = await fsp.stat(parent);
  } catch {
    throw new CloneError(`父目录不存在：${parent}`, 'NO_PARENT');
  }
  if (!parentStat.isDirectory()) throw new CloneError(`父目录不是目录：${parent}`, 'NO_PARENT');

  // 目录名单独校验，防止 ../ 越界
  const dir = String(dirName || ref.name).trim();
  if (!dir || dir === '.' || dir === '..' || /[\\/]/.test(dir) || dir.includes('\0')) {
    throw new CloneError('目录名非法：不能包含路径分隔符或 ..', 'BAD_DIRNAME');
  }

  const target = path.resolve(parent, dir);
  const parentResolved = path.resolve(parent);
  const rel = path.relative(parentResolved, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CloneError('目标目录超出了所选父目录的范围', 'ESCAPE');
  }
  if (path.resolve(target) === parentResolved) throw new CloneError('目标目录不能就是父目录本身', 'SAME_DIR');

  await assertTargetUsable(target);

  const token = await getToken().catch(() => null);

  // 先用 API 快速判断仓库是否存在（约 0.3s），避免直接 clone 时长时间卡在鉴权协商上。
  // 注意：只有「确认 404」才拦截。「问不出来」（匿名配额用尽 / 网络问题）必须放行，
  // 否则会把用户的正常克隆误拦。
  const probe = await probeRepo(ref.owner, ref.name, { token }).catch(() => ({ known: false }));
  if (probe?.known && probe.exists === false) {
    const hint = token
      ? `仓库不存在，或当前授权没有访问权限：${ref.owner}/${ref.name}`
      : `仓库不存在，或者它是私有仓库而当前**尚未连接 GitHub**。\n私有仓库需要先完成授权才能克隆：${ref.owner}/${ref.name}`;
    throw new CloneError(hint, { code: 'REPO_NOT_FOUND', status: 404 });
  }

  const env = gitEnv(token);

  const started = Date.now();
  let stdout = '';
  try {
    stdout = await git(parentResolved, ['clone', ref.httpsUrl, target], { timeout: 5 * 60 * 1000, env });
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    let hint = msg;
    if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(msg)) {
      hint =
        '鉴权失败。私有仓库需要先连接 GitHub 才能克隆；也可能是当前授权没有该仓库的访问权限。\n\n原始信息：' +
        msg;
    } else if (/not found|404|Repository not found/i.test(msg)) {
      hint = `仓库不存在或无权访问：${ref.owner}/${ref.name}\n\n原始信息：` + msg;
    } else if (/lowSpeedLimit|timed out|timeout|CONNECT tunnel|Could not resolve/i.test(msg)) {
      hint =
        '连不上 github.com（连接超时或被网络/代理拦截）。\n注意：GitHub 的 API 域名与 git 传输域名是分开的，' +
        '有些代理只放行 api.github.com，而 github.com 的 git 流量会被挡下。\n\n原始信息：' +
        msg;
    } else if (/already exists and is not an empty directory/i.test(msg)) {
      hint = `目标目录已存在且非空：${target}`;
    }
    const err = new CloneError(hint, { code: 'CLONE_FAILED', status: 502 });
    err.usedAuth = !!token;
    err.stderr = msg;
    // 失败后 git 通常已自行清理；若残留空目录，如实告知，不擅自删除
    err.leftover = fs.existsSync(target) ? target : null;
    throw err;
  }

  // 克隆完必须真的是个仓库，才允许接入
  const gitDir = path.join(target, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new CloneError(`克隆似乎未成功：目标目录里没有 .git（${target}）`, { code: 'VERIFY_FAILED', status: 502 });
  }

  let repo = null;
  let openError = null;
  try {
    repo = await openRepo(target);
  } catch (e) {
    openError = e.message;
  }

  return {
    ok: true,
    owner: ref.owner,
    name: ref.name,
    url: ref.httpsUrl,
    target,
    usedAuth: !!token,
    action: 'create',
    tookMs: Date.now() - started,
    log: String(stdout).trim().split('\n').slice(-3).join('\n'),
    repo,
    openError,
  };
}
