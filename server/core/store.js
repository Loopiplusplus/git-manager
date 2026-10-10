import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 极简本地存储。
 * 接口被刻意抽象（get/set），后续可无痛替换为 SQLite（桌面端）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'store.json');

let state = { repos: [], logs: [] };
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
      };
    }
  } catch {
    state = { repos: [], logs: [] };
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
  save();
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
