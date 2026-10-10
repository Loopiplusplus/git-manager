import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAY = 86400000;

/**
 * 版本号单一来源：优先读根 package.json，读不到时回落到常量。
 * 桌面端打包后目录布局可能变化，所以必须容错，不能在加载期抛错。
 */
export const VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* 打包后端忽略 */
  }
  return '0.2.2';
})();

export function nowIso() {
  return new Date().toISOString();
}

export function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

export function humanSize(kib) {
  const n = Number(kib) || 0;
  if (n < 1024) return `${n} KB`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024).toFixed(2)} GB`;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function lines(s) {
  return String(s || '').split('\n').filter((l) => l.length > 0);
}

export function uniq(arr) {
  return Array.from(new Set(arr));
}
