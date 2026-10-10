import { api } from './api.js';
import { $, $$, esc, toast } from './util.js';
import { renderEmpty, renderLoading, renderOverview, renderBranches, renderCommits, renderLog } from './views.js';
import { openPalette, openSwitchFlow, openRepoModal, closeOverlay, pickAndOpen, openScanModal } from './palette.js';

const NAV = [
  { id: 'overview', label: '概览', ico: '◉' },
  { id: 'commits', label: '提交记录', ico: '≡' },
  { id: 'branches', label: '分支与引用', ico: '⑂' },
  { id: 'log', label: '操作日志', ico: '⟲' },
];

const state = { repos: [], repo: null, view: 'overview' };
let seq = 0;

/* ---------------- 导航 ---------------- */

function renderNav() {
  $('#nav').innerHTML = NAV.map(
    (n) => `<button class="nav-btn${state.view === n.id ? ' active' : ''}" data-view="${n.id}">
      <span class="nav-ico">${n.ico}</span><span>${n.label}</span>
    </button>`,
  ).join('');
  $$('#nav .nav-btn').forEach((el) => el.addEventListener('click', () => setView(el.dataset.view)));
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  renderNav();
  render();
}

/* ---------------- 头部 ---------------- */

function setHeader(o) {
  $('#repo-name').textContent = o.name;
  const sub = $('#repo-sub');
  sub.className = 'repo-sub mono';
  sub.textContent = `${o.head || '—'} · ${o.totalCommits} commits · ${o.size} · ${o.path}`;
}

async function updateUndoButton() {
  const btn = $('#btn-undo');
  if (!state.repo) { btn.hidden = true; return; }
  try {
    const logs = await api.logs(state.repo.id);
    btn.hidden = !logs.some((l) => l.op === 'switch' && !l.undone);
  } catch {
    btn.hidden = true;
  }
}

/* ---------------- 渲染 ---------------- */

async function render() {
  const view = $('#view');

  if (!state.repo) {
    $('#repo-name').textContent = '未接入仓库';
    const sub = $('#repo-sub');
    sub.className = 'repo-sub';
    sub.textContent = '接入一个本地 Git 仓库后开始体检';
    $('#btn-undo').hidden = true;
    view.innerHTML = renderEmpty(state);
    return;
  }

  const repo = state.repo;
  const mine = ++seq;
  view.innerHTML = renderLoading();

  try {
    if (state.view === 'overview') {
      const [o, h, a, cm] = await Promise.all([
        api.overview(repo.id),
        api.healthReport(repo.id),
        api.activity(repo.id, 12),
        api.commits(repo.id, 12),
      ]);
      if (mine !== seq) return;
      setHeader(o);
      view.innerHTML = renderOverview({ overview: o, health: h, activity: a, commits: cm });
    } else if (state.view === 'branches') {
      const br = await api.branches(repo.id);
      if (mine !== seq) return;
      const o = await api.overview(repo.id);
      if (mine !== seq) return;
      setHeader(o);
      view.innerHTML = renderBranches({ branches: br });
    } else if (state.view === 'commits') {
      const cm = await api.commits(repo.id, 60);
      if (mine !== seq) return;
      view.innerHTML = renderCommits({ commits: cm });
    } else if (state.view === 'log') {
      const logs = await api.logs(repo.id);
      if (mine !== seq) return;
      view.innerHTML = renderLog({ logs });
    }
  } catch (e) {
    if (mine !== seq) return;
    view.innerHTML = `<div class="note note-err">${esc(e.message)}</div>`;
  }
}

/* ---------------- 仓库 ---------------- */

async function loadRepos() {
  const { repos } = await api.listRepos();
  state.repos = repos;
  if (state.repo && !repos.some((r) => r.id === state.repo.id)) state.repo = null;
  return repos;
}

async function selectRepo(id) {
  const repo = state.repos.find((r) => r.id === id) || { id, path: id, name: id };
  state.repo = repo;
  await render();
  await updateUndoButton();
}

const ctx = {
  state,
  loadRepos,
  selectRepo,
  refresh: async () => {
    await loadRepos();
    await render();
    await updateUndoButton();
  },
};

/* ---------------- 全局事件 ---------------- */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;

  if (action === 'open-repo') {
    const input = $('#repo-path');
    const path = input?.value.trim();
    if (!path) { toast('请填写仓库路径'); return; }
    try {
      const { repo } = await api.openRepo(path);
      await loadRepos();
      await selectRepo(repo.id);
      toast(`已接入 ${repo.name}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  } else if (action === 'select-repo') {
    await selectRepo(t.dataset.id);
  } else if (action === 'pick-folder') {
    await pickAndOpen(ctx);
  } else if (action === 'open-scan') {
    await openScanModal(ctx);
  } else if (action === 'toggle-manual') {
    const box = $('#manual-box');
    if (box) {
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) $('#repo-path')?.focus();
    }
  } else if (action === 'switch') {
    openSwitchFlow(ctx, t.dataset.branch);
  } else if (action === 'undo') {
    try {
      const r = await api.undo(state.repo.id);
      await ctx.refresh();
      toast(`已撤销，回到 ${r.to}${r.restoredSnapshot ? '，改动已恢复' : ''}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
});

$('#overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closeOverlay();
});

$('#btn-switch').addEventListener('click', () => openPalette(ctx));
$('#btn-repos').addEventListener('click', () => openRepoModal(ctx));
$('#btn-refresh').addEventListener('click', () => ctx.refresh());
$('#btn-undo').addEventListener('click', async () => {
  try {
    const r = await api.undo(state.repo.id);
    await ctx.refresh();
    toast(`已撤销，回到 ${r.to}${r.restoredSnapshot ? '，改动已恢复' : ''}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette(ctx);
  }
  if (e.key === 'r' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    ctx.refresh();
  }
});

window.addEventListener('error', (e) => toast(e.message || '发生未知错误', 'err'));
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || '请求失败', 'err'));

/* ---------------- 启动 ---------------- */

(async function boot() {
  renderNav();
  try {
    await api.health();
  } catch {
    $('#view').innerHTML = '<div class="note note-err">无法连接本地服务，请确认 <span class="mono">node server/index.js</span> 正在运行。</div>';
    return;
  }
  const repos = await loadRepos();
  if (repos.length) {
    const first = repos.find((r) => r.exists) || repos[0];
    await selectRepo(first.id);
  } else {
    await render();
  }
})();
