import { api } from './api.js';
import { $, esc, toast, branchBadges } from './util.js';

let dispose = null;

export function closeOverlay() {
  const o = $('#overlay');
  if (dispose) { dispose(); dispose = null; }
  o.hidden = true;
  o.innerHTML = '';
}

function mount(html) {
  const o = $('#overlay');
  if (dispose) { dispose(); dispose = null; }
  o.innerHTML = html;
  o.hidden = false;
  return o;
}

function escClose(handler) {
  const fn = (e) => { if (e.key === 'Escape') { e.preventDefault(); handler(); } };
  document.addEventListener('keydown', fn);
  return () => document.removeEventListener('keydown', fn);
}

/* ============================================================
   ⌘K 分支快速切换面板
   ============================================================ */

export async function openPalette(ctx) {
  const repo = ctx.state.repo;
  if (!repo) { toast('请先接入一个仓库'); return; }

  mount(`<div class="palette"><div class="loading"><span class="spinner"></span><span>正在读取分支…</span></div></div>`);

  let br;
  try {
    br = await api.branches(repo.id);
  } catch (e) {
    mount(`<div class="palette"><div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div></div>`);
    dispose = escClose(closeOverlay);
    return;
  }

  const all = br.local;
  let filtered = all.slice();
  let cursor = Math.max(0, filtered.findIndex((b) => b.isCurrent));

  mount(`<div class="palette" role="dialog" aria-modal="true">
    <div class="palette-search">
      <span class="mag">⌕</span>
      <input id="pal-input" placeholder="输入分支名筛选…" autocomplete="off" spellcheck="false">
      <kbd>esc</kbd>
    </div>
    <div class="palette-list" id="pal-list"></div>
    <div class="palette-foot">
      <span>↑↓ 选择</span><span>⏎ 切换</span>
      <span class="muted" style="margin-left:auto">共 ${all.length} 个本地分支</span>
    </div>
  </div>`);

  const listEl = $('#pal-list');
  const inputEl = $('#pal-input');

  const paint = () => {
    listEl.querySelectorAll('.palette-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === cursor));
  };
  const scrollActive = () => {
    const el = listEl.querySelector('.palette-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  const pick = (b) => {
    if (!b) return;
    if (b.isCurrent) { toast('已经在这个分支上了'); return; }
    if (b.lockedBy) { toast('该分支被另一个工作树占用，无法在此切换', 'err'); return; }
    openSwitchFlow(ctx, b.name);
  };

  const draw = () => {
    if (!filtered.length) {
      listEl.innerHTML = '<p class="muted tiny" style="padding:16px 10px">没有匹配的分支</p>';
      return;
    }
    listEl.innerHTML =
      '<div class="palette-group">本地分支</div>' +
      filtered
        .map(
          (b, i) => `<button class="palette-item${i === cursor ? ' active' : ''}" data-i="${i}">
            <span class="branch-glyph">⑂</span>
            <span class="mono" style="font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.name)}</span>
            <span class="branch-badges" style="margin-left:0">${branchBadges(b)}</span>
          </button>`,
        )
        .join('');
    listEl.querySelectorAll('.palette-item').forEach((el) => {
      el.addEventListener('mouseenter', () => { cursor = Number(el.dataset.i); paint(); });
      el.addEventListener('click', () => pick(filtered[Number(el.dataset.i)]));
    });
    scrollActive();
  };

  const refilter = () => {
    const s = inputEl.value.trim().toLowerCase();
    filtered = s ? all.filter((b) => b.name.toLowerCase().includes(s)) : all.slice();
    cursor = 0;
    draw();
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(filtered.length - 1, cursor + 1); paint(); scrollActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); scrollActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[cursor]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
  };

  inputEl.addEventListener('input', refilter);
  document.addEventListener('keydown', onKey);
  dispose = () => document.removeEventListener('keydown', onKey);

  draw();
  setTimeout(() => inputEl.focus(), 30);
}

/* ============================================================
   安全切换流程
   ============================================================ */

function checkRow(c) {
  const mark = { ok: '✓', warn: '!', block: '✕' }[c.level] || '·';
  return `<div class="check">
    <span class="check-mark m-${esc(c.level)}">${mark}</span>
    <div>
      <div class="check-label">${esc(c.label)}</div>
      ${c.detail ? `<div class="check-detail">${esc(c.detail)}</div>` : ''}
    </div>
  </div>`;
}

export async function openSwitchFlow(ctx, target) {
  const repo = ctx.state.repo;
  if (!repo) return;

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">安全切换 · ${esc(target)}</h3>
      <p class="modal-sub">正在执行切换前检查…</p>
    </div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>Preflight 检查中</span></div></div>
  </div>`);
  dispose = escClose(closeOverlay);

  let pf;
  try {
    pf = await api.preflight(repo.id, target);
  } catch (e) {
    mount(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">检查失败</h3></div>
      <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
      <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
    </div>`);
    $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    dispose = escClose(closeOverlay);
    return;
  }

  renderPreflight(ctx, pf);
}

function renderPreflight(ctx, pf) {
  const dirty = pf.dirty.count > 0;
  const blocked = !pf.ok;
  let strategy = 'snapshot';

  const strategyCards = !dirty
    ? ''
    : `
    <p class="section-title" style="margin:18px 0 8px">工作区有 ${pf.dirty.count} 处未提交改动，如何处理？</p>
    <button class="strategy sel" data-strategy="snapshot">
      <span class="badge b-green">推荐</span>
      <span style="flex:1">
        <span class="strategy-title" style="display:block">快照并切换</span>
        <span class="strategy-desc" style="display:block">把改动存进 <span class="mono">refs/gm/snapshots</span>，工作区清空后切换。改动不会丢，可随时取回，也不会污染你的 stash 列表。</span>
      </span>
    </button>
    <button class="strategy" data-strategy="commit">
      <span class="badge b-plain">可选</span>
      <span style="flex:1">
        <span class="strategy-title" style="display:block">先提交再切换</span>
        <span class="strategy-desc" style="display:block">把这些改动作为一个新提交固化下来，然后再切换。</span>
      </span>
    </button>
    <div class="note" style="margin-top:6px">本系统不提供「丢弃改动」选项 —— 未提交内容一律进快照，永不静默丢弃。</div>`;

  const blockers = blocked
    ? `<div class="note note-err" style="margin-bottom:12px">无法切换，存在 ${pf.blockers.length} 项阻塞：<br>${pf.blockers.map((b) => '· ' + esc(b.label)).join('<br>')}</div>`
    : '';

  const cleanNote = !dirty && !blocked ? '<div class="note note-ok" style="margin-top:6px">工作区干净，可直接切换。</div>' : '';

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">安全切换 · ${esc(pf.target)}</h3>
      <p class="modal-sub">${esc(pf.current || '—')} → ${esc(pf.target)}</p>
    </div>
    <div class="modal-body">
      ${blockers}
      <p class="section-title" style="margin:0 0 6px">切换前检查</p>
      ${pf.checks.map(checkRow).join('')}
      ${cleanNote}
      ${strategyCards}
      <div id="commit-box" class="hidden" style="margin-top:10px">
        <p class="section-title" style="margin:0 0 6px">提交信息</p>
        <textarea class="input" id="commit-msg" placeholder="例如：wip: 切换分支前保存进度"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="go" ${blocked ? 'disabled' : ''}>${dirty ? '执行安全切换' : '切换'}</button>
    </div>
  </div>`);

  const o = $('#overlay');
  const goBtn = o.querySelector('[data-act="go"]');
  const commitBox = o.querySelector('#commit-box');
  const commitMsg = o.querySelector('#commit-msg');

  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);

  o.querySelectorAll('.strategy').forEach((el) => {
    el.addEventListener('click', () => {
      strategy = el.dataset.strategy;
      o.querySelectorAll('.strategy').forEach((x) => x.classList.toggle('sel', x === el));
      commitBox.classList.toggle('hidden', strategy !== 'commit');
      if (strategy === 'commit') commitMsg.focus();
    });
  });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span> 切换中';
    try {
      const res = await api.switchBranch(ctx.state.repo.id, {
        target: pf.target,
        strategy: dirty ? strategy : 'direct',
        message: strategy === 'commit' ? commitMsg.value : undefined,
      });
      renderResult(ctx, res, pf);
    } catch (e) {
      const detail = e.data?.preflight
        ? e.data.preflight.blockers.map((b) => '· ' + b.label).join('<br>')
        : esc(e.message);
      mount(`<div class="modal">
        <div class="modal-head"><h3 class="modal-title">切换未完成</h3><p class="modal-sub">${esc(pf.current || '—')} → ${esc(pf.target)}</p></div>
        <div class="modal-body">
          <div class="note note-err">${detail}</div>
          ${e.data?.snapshotRef ? `<p class="tiny muted" style="margin-top:12px">快照已保留，可手动恢复：</p><div class="code">git stash apply ${esc(e.data.snapshotRef)}</div>` : ''}
        </div>
        <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
      </div>`);
      $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
      dispose = escClose(closeOverlay);
    }
  });
}

function renderResult(ctx, res, pf) {
  const warn = res.warnings?.length
    ? `<div class="note" style="margin-top:12px">注意：${res.warnings.map((w) => esc(w.label)).join('；')}</div>`
    : '';

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">切换完成</h3>
      <p class="modal-sub">${esc(res.from || '—')} → ${esc(res.to)}</p>
    </div>
    <div class="modal-body">
      <div class="note note-ok">已切换到 <span class="mono">${esc(res.to)}</span>${res.workingTreeClean ? '，工作区干净' : ''}。</div>
      ${res.snapshotRef ? `<p class="tiny muted" style="margin-top:14px">未提交改动已存入快照（可随时取回）：</p><div class="code">${esc(res.snapshotRef)}</div>` : ''}
      ${res.committed ? `<p class="tiny muted" style="margin-top:12px">已生成提交：<span class="mono">${esc(res.committed)}</span></p>` : ''}
      ${warn}
      <p class="tiny muted" style="margin-top:14px">回滚指令</p>
      <div class="code">${esc(res.rollbackHint || `git switch ${res.from}`)}</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-act="undo">撤销这次切换</button>
      <button class="btn btn-primary" data-act="done">完成</button>
    </div>
  </div>`);

  const o = $('#overlay');
  o.querySelector('[data-act="done"]').addEventListener('click', async () => {
    closeOverlay();
    await ctx.refresh();
    toast(`已切换到 ${res.to}`, 'ok');
  });
  o.querySelector('[data-act="undo"]').addEventListener('click', async () => {
    try {
      const r = await api.undo(ctx.state.repo.id);
      closeOverlay();
      await ctx.refresh();
      toast(`已撤销，回到 ${r.to}${r.restoredSnapshot ? '，改动已恢复' : ''}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  dispose = escClose(closeOverlay);
}

/* ============================================================
   仓库管理
   ============================================================ */

export function openRepoModal(ctx) {
  const repos = ctx.state.repos || [];
  const list = repos.length
    ? repos
        .map(
          (r) => `<div class="repo-item${r.exists ? '' : ' offline'}">
            <span class="branch-glyph">◇</span>
            <span style="min-width:0;flex:1">
              <span class="repo-item-title" style="display:block">${esc(r.name || r.path.split(/[\\/]/).pop())}</span>
              <span class="repo-item-path" style="display:block">${esc(r.path)}${r.exists ? '' : ' · 目录已不存在'}</span>
            </span>
            <button class="btn btn-sm" data-open="${esc(r.id)}" ${r.exists ? '' : 'disabled'}>打开</button>
            <button class="btn btn-sm btn-ghost" data-del="${esc(r.id)}">移除</button>
          </div>`,
        )
        .join('')
    : '<p class="muted tiny">还没有接入过仓库</p>';

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">仓库</h3>
      <p class="modal-sub">接入、切换或移除本地仓库（移除只是从列表去掉，不会动磁盘）</p>
    </div>
    <div class="modal-body">
      <div class="row" style="gap:8px;margin-bottom:12px">
        <button class="btn btn-primary" data-act="pick" style="flex:0 0 auto"><span class="btn-ico">▣</span> 选择文件夹…</button>
        <button class="btn" data-act="scan" style="flex:0 0 auto"><span class="btn-ico">⌕</span> 扫描磁盘</button>
      </div>
      <div class="row" style="gap:8px;margin-bottom:16px">
        <input class="input" id="m-repo-path" placeholder="或直接粘贴仓库绝对路径，例如 D:/code/my-project" autocomplete="off" spellcheck="false">
        <button class="btn" id="m-open" style="flex:0 0 auto">接入</button>
      </div>
      <p class="section-title" style="margin:0 0 8px">已接入 · ${repos.length}</p>
      ${list}
    </div>
    <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
  </div>`);

  const o = $('#overlay');
  const input = o.querySelector('#m-repo-path');

  const doOpen = async () => {
    const p = input.value.trim();
    if (!p) { toast('请填写仓库路径'); return; }
    const btn = o.querySelector('#m-open');
    btn.disabled = true;
    try {
      const { repo } = await api.openRepo(p);
      closeOverlay();
      await ctx.loadRepos();
      await ctx.selectRepo(repo.id);
      toast(`已接入 ${repo.name}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  };

  o.querySelector('#m-open').addEventListener('click', doOpen);
  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  o.querySelector('[data-act="pick"]').addEventListener('click', () => pickAndOpen(ctx));
  o.querySelector('[data-act="scan"]').addEventListener('click', () => openScanModal(ctx));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOpen(); });

  o.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', async () => {
      closeOverlay();
      await ctx.selectRepo(el.dataset.open);
    }),
  );
  o.querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        await api.removeRepo(el.dataset.del);
        await ctx.loadRepos();
        openRepoModal(ctx);
      } catch (e) {
        toast(e.message, 'err');
      }
    }),
  );

  dispose = escClose(closeOverlay);
  setTimeout(() => input.focus(), 30);
}

/* ============================================================
   原生文件夹选择器 → 智能识别 → 接入
   ============================================================ */

export async function pickAndOpen(ctx) {
  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">正在等待系统文件夹选择器</h3>
      <p class="modal-sub">请在弹出窗口中选择一个目录</p>
    </div>
    <div class="modal-body">
      <div class="loading"><span class="spinner"></span><span>已打开 Windows 文件夹选择器</span></div>
      <div class="note" style="margin-top:2px">如果没看到弹窗，请检查是否被浏览器窗口挡住了（任务栏可能正在闪烁）。</div>
    </div>
    <div class="modal-foot"><button class="btn" data-act="cancel">取消等待</button></div>
  </div>`);
  $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  dispose = escClose(closeOverlay);

  let res;
  try {
    res = await api.pickFolder({ title: '选择一个目录（会自动识别是否为 Git 仓库）' });
  } catch (e) {
    closeOverlay();
    toast(e.message, 'err');
    return;
  }

  if (!res || res.unsupported) {
    closeOverlay();
    toast(res?.message || '当前系统不支持原生选择器，请手动输入路径', 'err');
    return;
  }
  if (res.cancelled) {
    closeOverlay();
    return;
  }
  await probePickedPath(ctx, res.path);
}

async function probePickedPath(ctx, p) {
  mount(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title">正在识别…</h3><p class="modal-sub mono">${esc(p)}</p></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>检查是否已初始化 Git</span></div></div>
  </div>`);
  dispose = escClose(closeOverlay);

  let info;
  try {
    info = await api.probe(p);
  } catch (e) {
    closeOverlay();
    toast(e.message, 'err');
    return;
  }
  renderProbeResult(ctx, info);
}

async function openRepoAndClose(ctx, p) {
  try {
    const { repo } = await api.openRepo(p);
    closeOverlay();
    await ctx.loadRepos();
    await ctx.selectRepo(repo.id);
    toast(`已接入 ${repo.name}`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderProbeResult(ctx, info) {
  const p = info.path;

  // ① 本身就是仓库 → 直接接入
  if (info.isRepo) {
    openRepoAndClose(ctx, p);
    return;
  }

  // ② 在某个仓库内部 → 提示接入仓库根
  if (info.isInsideRepo) {
    mount(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">这个目录在仓库内部</h3><p class="modal-sub mono">${esc(p)}</p></div>
      <div class="modal-body">
        <div class="note">它本身不是 Git 仓库，但位于仓库 <span class="mono">${esc(info.repoRoot)}</span> 之内。</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="root">接入仓库根目录</button>
      </div>
    </div>`);
    const o = $('#overlay');
    o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    o.querySelector('[data-act="root"]').addEventListener('click', () => openRepoAndClose(ctx, info.repoRoot));
    dispose = escClose(closeOverlay);
    return;
  }

  // ③ 找到子仓库 → 列表选择
  if (info.childRepos && info.childRepos.length) {
    const rows = info.childRepos
      .slice(0, 60)
      .map(
        (r) => `<div class="list-row">
          <span class="branch-glyph">◇</span>
          <div style="min-width:0;flex:1">
            <div class="repo-item-title">${esc(r.name)}</div>
            <div class="repo-item-path">${esc(r.path)}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-add="${esc(r.path)}">接入</button>
        </div>`,
      )
      .join('');
    mount(`<div class="modal">
      <div class="modal-head">
        <h3 class="modal-title">这个目录不是仓库，但找到了 ${info.childRepos.length} 个子仓库</h3>
        <p class="modal-sub mono">${esc(p)}</p>
      </div>
      <div class="modal-body">
        <div class="note-ok note" style="margin-bottom:12px">已扫描 ${info.scannedDirs || 0} 个目录，以下是其中的 Git 仓库。</div>
        <div style="max-height:320px;overflow-y:auto">${rows}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="deep">扫描更深…</button>
        <button class="btn" data-act="cancel">关闭</button>
      </div>
    </div>`);
    const o = $('#overlay');
    o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    o.querySelector('[data-act="deep"]').addEventListener('click', () => openScanModal(ctx, { root: p }));
    o.querySelectorAll('[data-add]').forEach((el) =>
      el.addEventListener('click', () => openRepoAndClose(ctx, el.dataset.add)),
    );
    dispose = escClose(closeOverlay);
    return;
  }

  // ④ 什么都没有
  mount(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title">没找到 Git 仓库</h3><p class="modal-sub mono">${esc(p)}</p></div>
    <div class="modal-body">
      <div class="note">这个目录还没有初始化 Git，其下也没有发现已初始化的子仓库。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">关闭</button>
      <button class="btn btn-primary" data-act="deep">扫描更深…</button>
    </div>
  </div>`);
  const o = $('#overlay');
  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  o.querySelector('[data-act="deep"]').addEventListener('click', () => openScanModal(ctx, { root: p }));
  dispose = escClose(closeOverlay);
}

/* ============================================================
   磁盘扫描
   ============================================================ */

export async function openScanModal(ctx, preset = {}) {
  let poll = null;
  let drives = [];
  let root = preset.root || '';
  let depth = preset.depth || 4;
  let job = null;
  let running = false;

  const stopPoll = () => { if (poll) { clearTimeout(poll); poll = null; } };

  const renderShell = () => {
    const chips = drives
      .map((d) => `<button class="chip${d.path === root ? ' chip-on' : ''}" data-root="${esc(d.path)}">${esc(d.label)}</button>`)
      .join('');
    const depths = [2, 3, 4, 5, 6]
      .map((n) => `<button class="seg-item${n === depth ? ' on' : ''}" data-depth="${n}">${n}</button>`)
      .join('');
    return `<div class="modal">
      <div class="modal-head">
        <h3 class="modal-title">扫描磁盘找仓库</h3>
        <p class="modal-sub">只读遍历目录结构，只判断 <span class="mono">.git</span> 是否存在 —— 不读文件内容、不写入任何东西</p>
      </div>
      <div class="modal-body">
        <p class="section-title" style="margin:0 0 8px">扫描位置</p>
        <div class="row" style="flex-wrap:wrap;gap:6px" id="scan-roots">
          ${chips}
          <button class="chip" data-act="custom"><span class="btn-ico">▣</span> 选择其它目录…</button>
        </div>
        <p class="mono tiny muted" style="margin:8px 0 0;word-break:break-all" id="scan-root-show">${root ? esc(root) : '（未选择）'}</p>

        <p class="section-title" style="margin:18px 0 8px">扫描深度</p>
        <div class="seg" id="scan-depth">${depths}</div>
        <p class="tiny muted" style="margin:8px 0 0">深度越大越慢。默认 4 层，已自动跳过 node_modules、AppData、Windows 等目录。</p>

        <div id="scan-run" class="hidden" style="margin-top:18px">
          <div class="progress"><div class="progress-bar"></div></div>
          <p class="tiny muted" id="scan-status" style="margin:8px 0 0"></p>
        </div>

        <div id="scan-results" style="margin-top:16px"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">关闭</button>
        <button class="btn btn-primary" data-act="start" ${root ? '' : 'disabled'}>开始扫描</button>
      </div>
    </div>`;
  };

  const bindShell = () => {
    const o = $('#overlay');
    o.querySelector('[data-act="cancel"]').addEventListener('click', () => { stopPoll(); closeOverlay(); });
    o.querySelector('[data-act="start"]').addEventListener('click', start);
    o.querySelector('[data-act="custom"]').addEventListener('click', async () => {
      stopPoll();
      const r = await api.pickFolder({ title: '选择要扫描的目录' }).catch(() => null);
      if (r && r.ok && !r.cancelled) {
        root = r.path;
        redraw();
      } else if (r && r.unsupported) {
        toast(r.message, 'err');
      }
    });
    o.querySelectorAll('[data-root]').forEach((el) =>
      el.addEventListener('click', () => { root = el.dataset.root; redraw(); }),
    );
    o.querySelectorAll('[data-depth]').forEach((el) =>
      el.addEventListener('click', () => {
        depth = Number(el.dataset.depth);
        o.querySelectorAll('[data-depth]').forEach((x) => x.classList.toggle('on', x === el));
      }),
    );
  };

  const redraw = () => {
    mount(renderShell());
    bindShell();
    if (job) paintJob(job);
  };

  const paintJob = (j) => {
    const bar = $('#scan-run');
    const st = $('#scan-status');
    const rl = $('#scan-results');
    if (!bar) return;
    bar.classList.remove('hidden');
    const secs = (j.elapsedMs / 1000).toFixed(1);
    st.innerHTML = `已扫描 <b>${j.scannedDirs}</b> 个目录 · 找到 <b>${j.foundCount}</b> 个仓库 · ${secs}s`
      + (j.status === 'running' ? ` · 待处理 ${j.queueLen}` : ` · ${STATUS_TEXT[j.status] || j.status}`);

    if (j.status !== 'running') {
      bar.querySelector('.progress-bar')?.classList.add('progress-done');
      const startBtn = $('#overlay')?.querySelector('[data-act="start"]');
      if (startBtn) { startBtn.textContent = '重新扫描'; startBtn.disabled = false; }
    }

    rl.innerHTML = j.found.length
      ? `<p class="section-title" style="margin:0 0 8px">找到 ${j.foundCount} 个仓库</p>
         <div style="max-height:300px;overflow-y:auto">
         ${j.found
           .map(
             (f) => `<div class="list-row">
               <span class="branch-glyph">◇</span>
               <div style="min-width:0;flex:1">
                 <div class="repo-item-title">${esc(f.name)}</div>
                 <div class="repo-item-path">${esc(f.path)}</div>
               </div>
               <button class="btn btn-sm btn-primary" data-add="${esc(f.path)}">接入</button>
             </div>`,
           )
           .join('')}
         </div>`
      : j.status === 'running'
        ? ''
        : '<div class="note">这个范围内没有找到 Git 仓库。可以试试把深度调大，或换一个位置。</div>';

    rl.querySelectorAll('[data-add]').forEach((el) =>
      el.addEventListener('click', () => { stopPoll(); openRepoAndClose(ctx, el.dataset.add); }),
    );
  };

  const STATUS_TEXT = { done: '已完成', cancelled: '已取消', timeout: '已达时间上限', limit: '已达目录数量上限', error: '出错了' };

  const start = async () => {
    const startBtn = $('#overlay').querySelector('[data-act="start"]');
    startBtn.disabled = true;
    startBtn.innerHTML = '<span class="spinner"></span> 扫描中';
    job = null;
    try {
      job = await api.scanStart(root, depth);
    } catch (e) {
      toast(e.message, 'err');
      startBtn.disabled = false;
      startBtn.textContent = '开始扫描';
      return;
    }
    paintJob(job);

    const tick = async () => {
      if (!job || job.status !== 'running') return;
      try {
        job = await api.scanGet(job.id);
      } catch {
        return;
      }
      paintJob(job);
      if (job.status === 'running') poll = setTimeout(tick, 400);
    };
    tick();
  };

  mount(renderShell());
  bindShell();
  dispose = () => { stopPoll(); escClose(closeOverlay)(); };

  try {
    const res = await api.drives();
    drives = res.drives || [];
    if (!root && drives.length) root = drives[0].path;
    redraw();
  } catch {
    /* 拿不到盘符也不阻塞，用户可以用「选择其它目录」 */
  }
}

