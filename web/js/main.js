import { api } from './api.js';
import { $, $$, esc, toast } from './util.js';
import { renderEmpty, renderLoading, renderOverview, renderBranches, renderCommits, renderLog, renderGithub } from './views.js';
import {
  openPalette,
  openSwitchFlow,
  openRepoModal,
  closeOverlay,
  pickAndOpen,
  openScanModal,
  openGithubAuthorize,
  openGithubRepo,
  openCloneWizard,
} from './palette.js';

const NAV = [
  { id: 'overview', label: '概览', ico: '◉' },
  { id: 'commits', label: '提交记录', ico: '≡' },
  { id: 'branches', label: '分支与引用', ico: '⑂' },
  { id: 'log', label: '操作日志', ico: '⟲' },
  { id: 'github', label: 'GitHub', ico: '⌂' },
];

const state = { repos: [], repo: null, view: 'overview', ghScope: 'write', ghFilter: { q: '', visibility: 'all' }, ghRepos: [], ghAuth: null, ghNet: null, ghError: null, ghLogs: [] };
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

  // GitHub 视图与本地仓库无关，单独走一条渲染路径
  if (state.view === 'github') return renderGh();

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

/* ---------------- GitHub 视图 ---------------- */

function applyGhFilter(list) {
  const q = (state.ghFilter.q || '').trim().toLowerCase();
  const vis = state.ghFilter.visibility || 'all';
  return (list || []).filter((r) => {
    if (vis === 'private' && !r.private) return false;
    if (vis === 'public' && r.private) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      String(r.fullName || '').toLowerCase().includes(q) ||
      String(r.description || '').toLowerCase().includes(q)
    );
  });
}

/** 用缓存重绘（不重新请求），用于搜索框输入这类高频操作 */
function repaintGh() {
  const view = $('#view');
  view.innerHTML = renderGithub({
    auth: state.ghAuth,
    net: state.ghNet,
    repos: applyGhFilter(state.ghRepos),
    error: state.ghError,
    filter: state.ghFilter,
    logs: state.ghLogs,
  });
  bindGh();
  const q = $('#gh-q');
  if (q) {
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }
}

let ghSearchTimer = null;

function bindGh() {
  const view = $('#view');

  const ci = view.querySelector('#gh-client-id');
  if (ci) ci.value = state.ghClientId || '';

  const q = view.querySelector('#gh-q');
  if (q) {
    q.addEventListener('input', () => {
      state.ghFilter.q = q.value;
      clearTimeout(ghSearchTimer);
      ghSearchTimer = setTimeout(repaintGh, 200);
    });
  }
  const patInput = view.querySelector('#gh-pat');
  if (patInput) patInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePat(); });
}

async function savePat() {
  const el = $('#gh-pat');
  if (!el) return;
  const token = el.value.trim();
  if (!token) return toast('请先粘贴 token', 'err');
  try {
    const r = await api.ghSetPat(token);
    toast(`已连接：@${r.viewer?.login || ''}`, 'ok');
    await renderGh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renderGh() {
  const view = $('#view');
  const mine = ++seq;

  $('#repo-name').textContent = 'GitHub';
  const sub = $('#repo-sub');
  sub.className = 'repo-sub';
  sub.textContent = '远端仓库的读取 · 提交 · 克隆';
  $('#btn-undo').hidden = true;

  view.innerHTML = renderLoading('正在读取 GitHub…');

  try {
    const [auth, net] = await Promise.all([api.ghStatus(), api.netProbe().catch(() => null)]);
    if (mine !== seq) return;
    state.ghAuth = auth;
    state.ghNet = net;
    state.ghError = null;
    state.ghClientId = auth.clientId || '';

    // 审计日志是本地文件，与是否已授权无关
    state.ghLogs = await api.ghLog().catch(() => []);
    if (mine !== seq) return;

    if (auth.connected) {
      try {
        state.ghRepos = await api.ghRepos({ perPage: 100 });
      } catch (e) {
        state.ghRepos = [];
        state.ghError = e.message;
      }
    } else {
      state.ghRepos = [];
    }
    if (mine !== seq) return;
    repaintGh();
  } catch (e) {
    if (mine !== seq) return;
    view.innerHTML = `<div class="section"><div class="note note-err">${esc(e.message)}</div></div>`;
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
  } else if (action === 'gh-save-client-id') {
    const v = $('#gh-client-id')?.value.trim();
    if (!v) { toast('请先填写 Client ID', 'err'); return; }
    try {
      const r = await api.ghSetClientId(v);
      state.ghClientId = r.clientId;
      toast('Client ID 已保存', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  } else if (action === 'gh-scope') {
    state.ghScope = t.dataset.scope;
    $$('#gh-scope .seg-item').forEach((el) => el.classList.toggle('active', el === t));
    const hint = $('#gh-scope-hint');
    if (hint) {
      hint.innerHTML =
        state.ghScope === 'readonly'
          ? '只读授权仅能查看仓库，<b>无法提交</b>。适合先试水。'
          : '读写需要 <span class="mono">repo</span> 权限（可读写你所有私有仓库），提交功能必需。';
    }
  } else if (action === 'gh-authorize') {
    openGithubAuthorize(ctx);
  } else if (action === 'gh-toggle-pat') {
    $('#gh-pat-box')?.classList.toggle('hidden');
    $('#gh-pat')?.focus();
  } else if (action === 'gh-save-pat') {
    await savePat();
  } else if (action === 'gh-open-repo') {
    openGithubRepo(ctx, t.dataset.owner, t.dataset.name);
  } else if (action === 'gh-vis') {
    state.ghFilter.visibility = t.dataset.vis;
    repaintGh();
  } else if (action === 'gh-refresh') {
    await renderGh();
  } else if (action === 'gh-clone-wizard') {
    openCloneWizard(ctx);
  } else if (action === 'gh-logout') {
    try {
      const r = await api.ghLogout();
      toast(r.hadToken ? '已退出，本地凭据已删除' : '本来就没有保存凭据', 'ok');
      if (r.revokeUrl) toast(`如需彻底撤销，请到 ${r.revokeUrl} 移除该应用授权`, '');
      await renderGh();
    } catch (err) {
      toast(err.message, 'err');
    }
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
