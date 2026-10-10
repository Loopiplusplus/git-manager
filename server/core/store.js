import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 极简本地存储。
 * 接口被刻意抽象（get/set），后续可无痛替换为 SQLite（桌面端）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
// GM_DATA_DIR 用于测试隔离（与 secrets.js 保持同一约定），也让桌面端能把数据挪到用户目录。
// ★ 曾经这里写死成 ROOT/data，于是测试跑一遍就把真实的 data/store.json 写脏了 —— 别再写死。
export const DATA_DIR = process.env.GM_DATA_DIR ? path.resolve(process.env.GM_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'store.json');

let state = { repos: [], logs: [], lastRepoId: null };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = {
        repos: Array.isArray(raw.repos) ? raw.repos : [],
        logs: Array.isArray(raw.logs) ? raw.logs : [],
        // 上次选中的仓库：下次打开直接恢复，而不是硬编码「列表里的第一个」
        lastRepoId: typeof raw.lastRepoId === 'string' ? raw.lastRepoId : null,
      };
    }
  } catch {
    state = { repos: [], logs: [], lastRepoId: null };
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* 存储失败不应中断主流程 */
  }
}

export function listRepos() {
  load();
  return state.repos.slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

export function findRepo(idOrPath) {
  load();
  const key = String(idOrPath);
  return state.repos.find((r) => r.id === key || r.path === key) || null;
}

export function upsertRepo(repo) {
  load();
  const i = state.repos.findIndex((r) => r.id === repo.id);
  if (i >= 0) state.repos[i] = { ...state.repos[i], ...repo };
  else state.repos.push(repo);
  save();
  return repo;
}

export function removeRepo(id) {
  load();
  state.repos = state.repos.filter((r) => r.id !== id);
  // 被移除的正好是「上次打开的」时候，一并清掉，避免下次恢复到一个已不存在的仓库
  if (state.lastRepoId === id) state.lastRepoId = null;
  save();
}

/** 上次选中的仓库 id（关闭前停留在哪个仓库，下次打开就回到哪个） */
export function getLastRepoId() {
  load();
  return state.lastRepoId || null;
}

export function setLastRepoId(id) {
  load();
  state.lastRepoId = id ? String(id) : null;
  save();
  return state.lastRepoId;
}

/**
 * 计算「下次打开应该落到哪个仓库」。
 * 优先级：记住的那个 → 最后一个接入的 → 任意一个存在的。
 * 记住的仓库若已从列表移除或目录已不存在，自动降级，不会卡在空状态。
 */
export function resolveStartupRepo(existsFn) {
  load();
  const repos = state.repos.slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const alive = (r) => (typeof existsFn === 'function' ? !!existsFn(r) : true);

  if (state.lastRepoId) {
    const remembered = repos.find((r) => r.id === state.lastRepoId);
    if (remembered && alive(remembered)) return remembered;
  }
  return repos.find(alive) || repos[0] || null;
}

export function listLogs(repoId, limit = 100) {
  load();
  return state.logs
    .filter((l) => !repoId || l.repoId === repoId)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, limit);
}

export function addLog(entry) {
  load();
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), undone: false, ...entry };
  state.logs.push(row);
  if (state.logs.length > 2000) state.logs = state.logs.slice(-2000);
  save();
  return row;
}

export function updateLog(id, patch) {
  load();
  const i = state.logs.findIndex((l) => l.id === id);
  if (i >= 0) {
    state.logs[i] = { ...state.logs[i], ...patch };
    save();
    return state.logs[i];
  }
  return null;
}
