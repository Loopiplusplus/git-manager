export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function relTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  let s = Math.floor((Date.now() - t) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} 个月前`;
  return `${(s / 86400 / 365).toFixed(1)} 年前`;
}

export function fmtDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function pct(n) {
  return `${Math.round((Number(n) || 0) * 100)}%`;
}

export function toast(message, kind = '') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast-${kind}` : ''}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 5200 : 3200);
}

/** 环形进度（健康度评分） */
export function ring(score, { size = 116, stroke = 6 } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(score) || 0));
  const dash = (c * v) / 100;
  const color = v >= 90 ? '#30d158' : v >= 75 ? '#30d158' : v >= 60 ? '#ff9f0a' : '#ff453a';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#2c2c2e" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"/>
  </svg>`;
}

export const GRADE = {
  excellent: '状态优秀',
  good: '状态良好',
  watch: '需要关注',
  cleanup: '建议清理',
};

/** 风险徽章 */
export function branchBadges(b) {
  const out = [];
  if (b.isCurrent) out.push('<span class="badge b-blue">当前</span>');
  if (b.dirty > 0) out.push('<span class="badge b-orange">有未提交改动</span>');
  if (b.lockedBy) out.push('<span class="badge b-red">被其它工作树占用</span>');
  if (b.ahead) out.push(`<span class="badge b-blue">领先 ${b.ahead}</span>`);
  if (b.behind) out.push(`<span class="badge b-plain">落后 ${b.behind}</span>`);
  if (!b.isMerged && !b.isCurrent) out.push('<span class="badge b-plain">未合并</span>');
  if (b.isStale) out.push(`<span class="badge b-gray">${b.staleDays} 天未动</span>`);
  return out.join('');
}

export function heatmap(activity) {
  const { days = [], max = 0 } = activity || {};
  const cells = days
    .map((d) => {
      if (d.future) return '<div class="hm hm-future"></div>';
      let lvl = 0;
      if (d.count > 0 && max > 0) lvl = Math.min(4, 1 + Math.floor((d.count / max) * 3.99));
      return `<div class="hm hm-${lvl}" title="${d.date} · ${d.count} 次提交"></div>`;
    })
    .join('');
  return `<div class="heatmap">${cells}</div>`;
}
