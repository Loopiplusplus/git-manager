import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, gitOk } from './git.js';

export function repoId(absPath) {
  return crypto.createHash('sha1').update(path.resolve(absPath)).digest('hex').slice(0, 12);
}

/**
 * 中途接入一个已有仓库。
 * 零侵入：只读探测，绝不 checkout / fetch / 修改工作区。
 */
export async function openRepo(input) {
  if (!input || typeof input !== 'string') throw new Error('缺少仓库路径');
  const p = path.resolve(input.trim().replace(/^"|"$/g, ''));

  if (!fs.existsSync(p)) throw new Error(`路径不存在：${p}`);
  if (!fs.statSync(p).isDirectory()) throw new Error('需要传入仓库目录，而不是文件');

  const inside = await gitOk(p, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') {
    throw new Error('这不是一个 Git 工作区（找不到 .git）');
  }

  const top = await gitOk(p, ['rev-parse', '--show-toplevel']);
  const root = top.ok ? top.out.trim() : p;

  const gitDirRaw = await gitOk(root, ['rev-parse', '--git-dir']);
  const gitDir = gitDirRaw.ok ? path.resolve(root, gitDirRaw.out.trim()) : path.join(root, '.git');

  const headRaw = await gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = headRaw.ok ? headRaw.out.trim() : 'HEAD';

  return {
    id: repoId(root),
    name: path.basename(root),
    path: root,
    gitDir,
    head,
    isWorktree: path.join(root, '.git') !== gitDir,
    addedAt: new Date().toISOString(),
  };
}

export function ensureRepo(pathOrId, resolveById) {
  if (!pathOrId) throw new Error('缺少仓库标识');
  const byId = resolveById(pathOrId);
  if (byId) return byId;
  if (fs.existsSync(pathOrId)) return { id: repoId(pathOrId), path: pathOrId };
  throw new Error(`未找到仓库：${pathOrId}`);
}

/** 读一个 git 目录下的文件内容（用于探测 rebase/merge 进行中） */
export function gitDirHas(gitDir, ...names) {
  return names.some((n) => fs.existsSync(path.join(gitDir, n)));
}

export async function currentBranch(root) {
  const r = await gitOk(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

export { git };
