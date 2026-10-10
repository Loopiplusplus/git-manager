import { api } from './api.js';
import { $, esc, toast, branchBadges, relTime, fmtDay } from './util.js';
import { humanSize, netBanner } from './views.js';

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
   分支的增与删
   ============================================================ */

/**
 * 新建分支。
 *
 * 只是多一个指针，不覆盖任何文件，所以不需要 preflight —— 但仍要把
 * 「从哪个提交开始」讲清楚，否则用户以为切过去了却没切。
 */
export async function openCreateBranch(ctx) {
  const repo = ctx.state.repo;
  if (!repo) { toast('请先接入一个仓库'); return; }

  // 拉一次分支列表用于「起点」下拉，省得用户手打起点名（打错就直接报错了）
  let br = null;
  try {
    br = await api.branches(repo.id);
  } catch {
    /* 拿不到列表不阻塞创建，起点留空即用当前 HEAD */
  }

  const options =
    '<option value="" selected>（当前 HEAD）</option>' +
    (br?.local || [])
      .map((b) => `<option value="${esc(b.name)}">${esc(b.name)}${b.isCurrent ? '（当前）' : ''}</option>`)
      .join('');

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">新建分支</h3>
      <p class="modal-sub">在新分支上继续干活，当前分支不受影响</p>
    </div>
    <div class="modal-body">
      <p class="section-title" style="margin:0 0 6px">分支名</p>
      <input class="input" id="br-name" placeholder="例如 feature/ai-signals" autocomplete="off" spellcheck="false">
      <div class="tiny muted" style="margin-top:6px">只能用字母、数字与 <span class="mono">. _ / @ -</span>；不能以 <span class="mono">- . /</span> 开头，不能含空格与 <span class="mono">~ ^ : ? * [ \\</span>。</div>

      <p class="section-title" style="margin:18px 0 6px">起点</p>
      <select class="input" id="br-from">${options}</select>
      <div class="tiny muted" style="margin-top:6px">新分支将从这里指向的提交开始。</div>

      <div class="note" style="margin-top:14px">新建分支只是多一个指针，<b>不会改任何文件</b>，也不会动你当前的工作区。随时可以用「删除分支」撤销。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="go">创建分支</button>
    </div>
  </div>`);

  const o = $('#overlay');
  const nameEl = o.querySelector('#br-name');
  const fromEl = o.querySelector('#br-from');
  const goBtn = o.querySelector('[data-act="go"]');
  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  dispose = escClose(closeOverlay);
  setTimeout(() => nameEl.focus(), 30);

  const submit = async () => {
    const name = nameEl.value.trim();
    if (!name) {
      toast('请填写分支名', 'err');
      nameEl.focus();
      return;
    }
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span> 创建中';
    try {
      const r = await api.createBranch(repo.id, { name, from: fromEl.value || undefined });
      closeOverlay();
      await ctx.refresh();
      toast(`已创建分支 ${r.name}`, 'ok');
    } catch (e) {
      goBtn.disabled = false;
      goBtn.textContent = '创建分支';
      toast(e.message, 'err');
    }
  };

  goBtn.addEventListener('click', submit);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

/**
 * 删除分支 —— 先做只读评估，把事实摆出来，再让用户决定。
 * 不给「确定吗？」这种把判断权推回给用户的做法。
 */
export async function openDeleteBranch(ctx, name) {
  const repo = ctx.state.repo;
  if (!repo) return;

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">删除分支 · ${esc(name)}</h3>
      <p class="modal-sub">正在评估影响…</p>
    </div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>检查中</span></div></div>
  </div>`);
  dispose = escClose(closeOverlay);

  let pre;
  try {
    pre = await api.branchRemoval(repo.id, name);
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

  renderDeletePrecheck(ctx, pre);
}

function renderDeletePrecheck(ctx, pre) {
  const blocked = !pre.ok;
  const unmerged = Number(pre.unmerged) || 0;
  const needsForce = !!pre.needsForce;

  const blockers = blocked
    ? `<div class="note note-err" style="margin-bottom:12px">无法删除：<br>${pre.blockers.map((b) => '· ' + esc(b.label)).join('<br>')}</div>`
    : '';

  const facts = [
    ['分支', pre.name],
    ['尖端提交', pre.sha ? `${pre.sha} · ${pre.subject || '(无提交信息)'}` : '—'],
    ['最后提交时间', pre.date ? fmtDay(pre.date) : '—'],
    ['仓库本地分支数', String(pre.branchCount)],
    ['远端同名分支', pre.remoteSameName ? '有（删除的只是本地副本）' : '没有'],
  ];

  // 「有未合并提交」不是阻塞项 —— git 的 -d 会拒绝它，这是第二道防线。
  // 我们要做的只是把这件事讲明白，并把强制删除这条路指出来。
  const mergedNote =
    unmerged > 0
      ? `<div class="note note-err" style="margin-top:12px">
           这个分支有 <b>${unmerged}</b> 个提交没有合并进当前分支，普通删除会被 git 拒绝。<br>
           仍要删除的话需要「强制删除」—— 删除前的尖端会先存入回滚点，随时可以恢复。
         </div>`
      : `<div class="note note-ok" style="margin-top:12px">这个分支的提交都已合并进当前分支，删除不会丢任何提交。</div>`;

  const confirmBox = needsForce
    ? `<div style="margin-top:14px">
        <p class="section-title" style="margin:0 0 6px">二次确认</p>
        <p class="tiny muted" style="margin:0 0 8px">请把分支名 <span class="mono">${esc(pre.name)}</span> 原样输入，才能强制删除。</p>
        <input class="input" id="confirm-name" placeholder="${esc(pre.name)}" autocomplete="off" spellcheck="false">
      </div>`
    : '';

  mount(`<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">删除分支 · ${esc(pre.name)}</h3>
      <p class="modal-sub">删除前会先把分支尖端存入 <span class="mono">refs/gm/deleted/*</span> 作为回滚点</p>
    </div>
    <div class="modal-body">
      ${blockers}
      <p class="section-title" style="margin:0 0 6px">影响范围</p>
      ${facts
        .map(
          ([k, v]) =>
            `<div class="list-row" style="padding:7px 0"><span class="tiny muted" style="flex:0 0 110px">${esc(k)}</span><span class="tiny mono" style="flex:1;min-width:0">${esc(v)}</span></div>`,
        )
        .join('')}
      ${mergedNote}
      ${confirmBox}
      ${blocked ? '' : `<div class="note" style="margin-top:14px">删除后如果后悔，可在「分支与引用」页的「可恢复的删除点」里一键恢复，不会丢任何提交。</div>`}
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn ${needsForce ? 'btn-danger' : 'btn-primary'}" data-act="go" ${blocked ? 'disabled' : ''}>${needsForce ? '强制删除' : '删除分支'}</button>
    </div>
  </div>`);

  const o = $('#overlay');
  const goBtn = o.querySelector('[data-act="go"]');
  const confirmEl = o.querySelector('#confirm-name');
  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  dispose = escClose(closeOverlay);
  if (confirmEl) setTimeout(() => confirmEl.focus(), 30);

  goBtn.addEventListener('click', async () => {
    const confirm = confirmEl ? confirmEl.value.trim() : pre.name;
    if (needsForce && confirm !== pre.name) {
      toast('二次确认不匹配：请输入完整分支名', 'err');
      return;
    }
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span> 删除中';
    try {
      const r = await api.deleteBranch(ctx.state.repo.id, { name: pre.name, force: needsForce, confirm });
      closeOverlay();
      await ctx.refresh();
      toast(`已删除分支 ${r.name}${r.forced ? '（强制）' : ''}，可随时恢复`, 'ok');
    } catch (e) {
      goBtn.disabled = false;
      goBtn.textContent = needsForce ? '强制删除' : '删除分支';
      // 普通删除被 git 以「未合并」拒绝 → 直接把用户引到强制删除那条路，而不是让他自己去猜
      if (e.data?.code === 'NOT_MERGED') {
        renderDeletePrecheck(ctx, { ...pre, needsForce: true });
        toast('该分支有未合并的提交，请改用「强制删除」', 'err');
        return;
      }
      toast(e.message, 'err');
    }
  });
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


/* ============================================================
   GitHub · 授权（OAuth 设备码流程）
   ============================================================ */

let ghTimer = null;
let ghSession = null;

function stopGhPoll() {
  if (ghTimer) { clearTimeout(ghTimer); ghTimer = null; }
  const id = ghSession;
  ghSession = null;
  if (id) api.ghDeviceCancel(id).catch(() => {});
}

function ghStepList() {
  return [
    ['1', '打开验证页面', '在浏览器里打开 GitHub 的授权页'],
    ['2', '输入下面的设备码', '设备码会把这次授权绑定到本机'],
    ['3', '确认授权', '回来后这里会自动完成'],
  ];
}

export async function openGithubAuthorize(ctx) {
  stopGhPoll();
  const scopeMode = ctx.state.ghScope || 'write';

  mount(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title">正在向 GitHub 申请设备码…</h3></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>连接 github.com</span></div></div>
  </div>`);

  let s;
  try {
    s = await api.ghDeviceStart(scopeMode);
  } catch (e) {
    mount(`<div class="modal">
      <div class="modal-head">
        <h3 class="modal-title">无法开始授权</h3>
        <p class="modal-sub">${esc(e.message)}</p>
      </div>
      <div class="modal-body">
        <div class="note note-err">${esc(e.message)}</div>
        ${e.data?.code === 'NETWORK' || /连不上|无法连接/.test(e.message)
          ? '<p class="tiny muted">这一般是网络问题：设备码授权需要访问 <span class="mono">github.com</span>，而读取仓库走的是 <span class="mono">api.github.com</span>，两者可能被区别对待。</p>'
          : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
    </div>`);
    $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    return;
  }

  ghSession = s.id;

  const paint = (st) => {
    const done = st.status === 'ok';
    const dead = st.status === 'denied' || st.status === 'expired' || st.status === 'error';
    const steps = ghStepList()
      .map(
        ([n, title, sub], i) => {
          const active = !done && !dead && i === (st.status === 'pending' ? currentStep : 2);
          return `<div class="gh-step${active ? ' on' : ''}">
            <span class="gh-step-n">${done ? '✓' : n}</span>
            <div><div>${esc(title)}</div><div class="tiny muted">${esc(sub)}</div></div>
          </div>`;
        },
      )
      .join('');

    return `<div class="modal">
      <div class="modal-head">
        <h3 class="modal-title">${done ? '授权成功' : '在 GitHub 上完成授权'}</h3>
        <p class="modal-sub">
          ${done
            ? `已连接为 @${esc(st.viewer?.login || '')}`
            : dead
              ? '本次授权没有完成'
              : '本页面会自动检测，你不需要手动刷新'}
        </p>
      </div>
      <div class="modal-body">
        ${done
          ? `<div class="note note-ok">
               <div>授权完成，token 已加密保存到本机。</div>
               <div class="tiny muted" style="margin-top:6px">
                 授权范围：<span class="mono">${esc((st.viewer?.scopes || []).join(', ') || st.scopes)}</span>
               </div>
             </div>`
          : dead
            ? `<div class="note note-err">${esc(st.error || '授权未完成')}</div>`
            : `<div class="gh-code" id="gh-code">${esc(st.userCode)}</div>
               <div class="row" style="gap:8px;justify-content:center;margin:10px 0 18px">
                 <button class="btn" data-act="copy">复制设备码</button>
                 <button class="btn btn-primary" data-act="open">打开验证页面</button>
               </div>
               <div class="gh-steps">${steps}</div>
               <p class="tiny muted" style="margin-top:14px;text-align:center">
                 剩余有效时间 ${Math.floor((st.expiresIn || 0) / 60)} 分 ${(st.expiresIn || 0) % 60} 秒 ·
                 授权范围 <span class="mono">${esc(st.scopes)}</span>
               </p>`}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">${done ? '完成' : '取消'}</button>
      </div>
    </div>`;
  };

  let currentStep = 0;
  let pollFailures = 0;

  /**
   * 重绘到已挂载的遮罩层上。
   *
   * ⚠️ 这里必须绕开 mount()。mount() 会先调用「上一个面板」的 dispose，
   * 而本面板的 dispose 正是 stopGhPoll() —— 于是第一次轮询重绘就会把自己
   * 清掉（清掉定时器、清空 ghSession、还会顺带取消服务端会话）。
   * 症状：设备码界面上用户明明完成了授权，页面却永远停在等待态。
   */
  const repaint = (html) => {
    const o = $('#overlay');
    o.innerHTML = html;
    o.hidden = false;
    return o;
  };

  const tick = async () => {
    if (!ghSession) return;
    let st;
    try {
      st = await api.ghDevicePoll(ghSession);
      pollFailures = 0;
    } catch (e) {
      // 会话真的没了（服务重启过 / 已被取消）→ 只能重新发起
      if (e.status === 404) {
        ghSession = null;
        repaint(`<div class="modal">
          <div class="modal-head"><h3 class="modal-title">授权会话已失效</h3>
            <p class="modal-sub">本地服务可能重启过，请重新发起授权</p></div>
          <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
          <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
        </div>`).querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
        return;
      }
      // 网络抖动（本机开代理时很常见）→ 容忍几次。
      // 否则一次闪断就把整个授权流程毁掉，用户只看到「授权中断」而不知所以。
      pollFailures += 1;
      if (pollFailures < 5) {
        ghTimer = setTimeout(tick, 3000);
        return;
      }
      ghSession = null;
      repaint(`<div class="modal">
        <div class="modal-head"><h3 class="modal-title">授权中断</h3>
          <p class="modal-sub">连续 ${pollFailures} 次无法连接本地服务</p></div>
        <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
        <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
      </div>`).querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
      return;
    }
    if (!ghSession) return;

    currentStep = st.status === 'pending' ? Math.min(currentStep + 1, 2) : currentStep;
    const o = repaint(paint(st));
    o.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      if (st.status === 'ok') { stopGhPoll(); closeOverlay(); ctx.refresh?.(); return; }
      const id = ghSession;
      stopGhPoll();
      closeOverlay();
      if (id) api.ghDeviceCancel(id).catch(() => {});
    });
    const copyBtn = o.querySelector('[data-act="copy"]');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(st.userCode); toast('设备码已复制', 'ok'); }
      catch { toast('复制失败，请手动选中', 'err'); }
    });
    const openBtn = o.querySelector('[data-act="open"]');
    if (openBtn) openBtn.addEventListener('click', () => window.open(st.verificationUri, '_blank', 'noopener'));

    if (st.status === 'ok') {
      ghSession = null;
      if (ghTimer) { clearTimeout(ghTimer); ghTimer = null; }
      toast(`已连接 GitHub：@${st.viewer?.login || ''}`, 'ok');
      ctx.refresh?.();
      return;
    }
    if (st.status === 'denied' || st.status === 'expired' || st.status === 'error') {
      ghSession = null;
      return;
    }
    ghTimer = setTimeout(tick, Math.max(1, st.interval || 5) * 1000);
  };

  const first = mount(paint(s));
  first.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    stopGhPoll();
    closeOverlay();
  });
  first.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(s.userCode); toast('设备码已复制', 'ok'); }
    catch { toast('复制失败，请手动选中', 'err'); }
  });
  first.querySelector('[data-act="open"]')?.addEventListener('click', () => window.open(s.verificationUri, '_blank', 'noopener'));

  // 首次轮询也要等一个 interval（服务端已做闸门，这里只是对齐节奏）
  ghTimer = setTimeout(tick, Math.max(1, s.interval || 5) * 1000);
  dispose = () => stopGhPoll();
}

/* ============================================================
   GitHub · 仓库详情
   ============================================================ */

export async function openGithubRepo(ctx, owner, name) {
  let cwd = ''; // 当前浏览的目录
  let branch = null;
  let detail = null;

  mount(`<div class="modal modal-lg"><div class="modal-head"><h3 class="modal-title">${esc(owner)}/${esc(name)}</h3></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>读取仓库信息</span></div></div></div>`);

  try {
    detail = await api.ghRepo(owner, name);
    branch = detail.repo.defaultBranch;
  } catch (e) {
    mount(`<div class="modal"><div class="modal-head"><h3 class="modal-title">读取失败</h3></div>
      <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
      <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div></div>`);
    $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    return;
  }

  let listing = null;

  const paint = () => {
    const r = detail.repo;
    const commits = detail.commits
      .map((c) => `<div class="list-row">
        <span class="mono tiny muted" style="flex:0 0 56px">${esc(c.short)}</span>
        <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.subject)}">${esc(c.subject)}</span>
        <span class="tiny muted" style="flex:0 0 auto">${esc(c.author)}</span>
        <span class="tiny muted" style="flex:0 0 70px;text-align:right">${esc(relTime(c.date))}</span>
      </div>`)
      .join('');

    const branches = detail.branches
      .map(
        (b) => `<button class="badge ${b.name === branch ? 'b-blue' : 'b-plain'}" data-branch="${esc(b.name)}">
          ${esc(b.name)}${b.protected ? ' 🔒' : ''}
        </button>`,
      )
      .join(' ');

    let files = '<div class="loading"><span class="spinner"></span></div>';
    if (listing) {
      const crumbs = ['<button class="crumb" data-path="">根目录</button>']
        .concat(
          cwd
            .split('/')
            .filter(Boolean)
            .map((seg, i, arr) => {
              const p = arr.slice(0, i + 1).join('/');
              return `<span class="crumb-sep">/</span><button class="crumb" data-path="${esc(p)}">${esc(seg)}</button>`;
            }),
        )
        .join('');
      const rows = listing.entries.length
        ? listing.entries
            .map(
              (e) => `<div class="file-row">
                <button class="file-main" data-act="${e.type === 'dir' ? 'enter' : 'open'}" data-path="${esc(e.path)}" data-sha="${esc(e.sha || '')}">
                  <span class="file-ico">${e.type === 'dir' ? '▸' : e.type === 'symlink' ? '⤳' : '·'}</span>
                  <span class="mono" style="flex:1;text-align:left">${esc(e.name)}</span>
                  <span class="tiny muted">${e.type === 'dir' ? '' : humanSize(e.size / 1024)}</span>
                </button>
                ${e.type === 'file' ? `<button class="btn btn-sm file-edit" data-act="edit" data-path="${esc(e.path)}" title="编辑并提交这个文件">编辑</button>` : ''}
              </div>`,
            )
            .join('')
        : '<p class="muted tiny" style="padding:10px">空目录</p>';
      files = `<div class="crumbs">${crumbs}</div><div class="file-list">${rows}</div>`;
    }

    return `<div class="modal modal-lg">
      <div class="modal-head">
        <h3 class="modal-title">${esc(r.owner)}/${esc(r.name)}</h3>
        <p class="modal-sub">${esc(r.description || '（无描述）')}</p>
      </div>
      <div class="modal-body">
        <div class="grid g-4" style="margin-bottom:14px">
          <div class="metric"><p class="metric-label">可见性</p><p class="metric-value" style="font-size:15px">${r.private ? '私有' : '公开'}</p></div>
          <div class="metric"><p class="metric-label">Star / Fork</p><p class="metric-value" style="font-size:15px">${r.stars} / ${r.forks}</p></div>
          <div class="metric"><p class="metric-label">体积</p><p class="metric-value" style="font-size:15px">${esc(humanSize(r.sizeKb))}</p></div>
          <div class="metric"><p class="metric-label">最后推送</p><p class="metric-value" style="font-size:15px">${esc(relTime(r.pushedAt))}</p></div>
        </div>

        <div class="spread" style="margin-bottom:8px">
          <p class="section-title" style="margin:0">默认分支 · ${esc(r.defaultBranch)}</p>
          <div class="row" style="gap:6px">
            <button class="btn btn-sm" data-act="clone-this">克隆到本地</button>
            <button class="btn btn-sm" data-act="upload-file">上传本地文件…</button>
            <button class="btn btn-sm btn-primary" data-act="new-file">新建文件…</button>
          </div>
        </div>
        <div class="branch-chips" style="margin-bottom:14px">${branches}</div>

        <p class="section-title">文件 · <span class="mono">${esc(branch)}</span></p>
        <div class="card" style="padding:8px 10px;margin-bottom:14px">${files}</div>

        <p class="section-title">最近提交</p>
        <div class="card" style="padding:4px 14px">${commits || '<p class="muted tiny">暂无</p>'}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">关闭</button>
      </div>
    </div>`;
  };

  const loadDir = async (p) => {
    cwd = p;
    listing = null;
    bind();
    try {
      const res = await api.ghContents(owner, name, p, branch);
      listing = res.kind === 'dir' ? res : { entries: [] };
    } catch (e) {
      listing = { entries: [] };
      toast(e.message, 'err');
    }
    bind();
  };

  const bind = () => {
    const o = mount(paint());
    o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    o.querySelector('[data-act="clone-this"]').addEventListener('click', () => openCloneWizard(ctx, `${owner}/${name}`));
    o.querySelector('[data-act="new-file"]').addEventListener('click', () => openGithubEditor(ctx, { owner, name, branch, file: null }));
    o.querySelector('[data-act="upload-file"]').addEventListener('click', () =>
      openGithubUpload(ctx, { owner, name, branch, dir: cwd }),
    );
    o.querySelectorAll('[data-branch]').forEach((el) =>
      el.addEventListener('click', () => {
        branch = el.dataset.branch;
        list(() => loadDir(''));
      }),
    );
    o.querySelectorAll('.crumb').forEach((el) => el.addEventListener('click', () => list(() => loadDir(el.dataset.path))));
    o.querySelectorAll('.file-row [data-act]').forEach((el) =>
      el.addEventListener('click', () => {
        const act = el.dataset.act;
        if (act === 'enter') return list(() => loadDir(el.dataset.path));
        if (act === 'open') return openGithubFile(ctx, owner, name, el.dataset.path, branch);
        if (act === 'edit') return openGithubEditorByPath(ctx, owner, name, el.dataset.path, branch);
      }),
    );
  };

  const list = (fn) => {
    // 目录切换时先给个 loading 再触发
    fn();
  };

  bind();
  await loadDir('');
}

/* ============================================================
   GitHub · 文件查看 + 编辑提交
   ============================================================ */

export async function openGithubFile(ctx, owner, name, path, branch) {
  mount(`<div class="modal modal-lg"><div class="modal-head"><h3 class="modal-title mono" style="font-size:13px">${esc(path)}</h3></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>读取文件</span></div></div></div>`);
  let file;
  try {
    file = await api.ghContents(owner, name, path, branch);
  } catch (e) {
    mount(`<div class="modal"><div class="modal-head"><h3 class="modal-title">读取失败</h3></div>
      <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
      <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div></div>`);
    $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    return;
  }

  if (file.kind !== 'file') {
    toast('这是一个目录', 'err');
    return openGithubRepo(ctx, owner, name);
  }

  const tooBig = file.size > 1024 * 1024;
  const o = mount(`<div class="modal modal-lg">
    <div class="modal-head">
      <h3 class="modal-title mono" style="font-size:13px">${esc(file.path)}</h3>
      <p class="modal-sub">
        ${esc(humanSize((file.size || 0) / 1024))} · <span class="mono">${esc(file.sha?.slice(0, 7) || '')}</span>
        ${file.binary ? ' · 二进制文件' : ''}
      </p>
    </div>
    <div class="modal-body">
      ${file.binary || tooBig
        ? `<div class="note">${file.binary ? '二进制文件不支持在线编辑。' : `文件超过 1MB（${esc(humanSize(file.size / 1024))}），不支持在线编辑。`}
             <div style="margin-top:8px"><a class="link" href="${esc(file.htmlUrl || '#')}" target="_blank" rel="noreferrer">在 GitHub 上查看 →</a></div>
           </div>`
        : `<div class="code-view"><pre class="mono">${esc(file.content || '')}</pre></div>`}
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">关闭</button>
      ${!file.binary && !tooBig ? '<button class="btn btn-primary" data-act="edit">编辑并提交</button>' : ''}
    </div>
  </div>`);

  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  o.querySelector('[data-act="edit"]')?.addEventListener('click', () =>
    openGithubEditor(ctx, { owner, name, branch, file }),
  );
}

/** 从文件列表里直接进编辑器：现取一次内容，避免用列表里的陈旧 sha */
export async function openGithubEditorByPath(ctx, owner, name, path, branch) {
  mount(`<div class="modal modal-lg"><div class="modal-head"><h3 class="modal-title mono" style="font-size:13px">${esc(path)}</h3></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>读取文件</span></div></div></div>`);
  let file;
  try {
    file = await api.ghContents(owner, name, path, branch);
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (file.kind !== 'file') return toast('这是一个目录', 'err');
  if (file.binary) return toast('二进制文件不支持在线编辑', 'err');
  if (file.size > 1024 * 1024) return toast(`文件超过 1MB（${humanSize(file.size / 1024)}），不支持在线编辑`, 'err');
  openGithubEditor(ctx, { owner, name, branch, file });
}

/**
 * 上传本地文件到远端仓库。
 * 之前的「新增」只有手打路径 + 手敲内容这一条路，太不实用；
 * 这里允许直接挑一个本地文件，内容由服务端在选中那一刻读回，
 * 之后仍走同一套「预览 → 二次确认 → 乐观锁」提交流程。
 */
export async function openGithubUpload(ctx, { owner, name, branch, dir = '' }) {
  let picked;
  try {
    picked = await api.pickFile({ title: '选择要上传到 GitHub 的文件', withContent: true });
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!picked?.ok) return toast(picked?.message || '无法打开文件选择器', 'err');
  if (picked.cancelled) return;
  if (picked.readError) return toast(picked.readError, 'err');
  if (picked.binary) return toast('这是二进制文件，暂不支持通过本系统上传', 'err');
  if (picked.tooBig) return toast(`文件超过 1MB（${humanSize(picked.size / 1024)}），暂不支持上传`, 'err');

  const targetPath = dir ? `${dir.replace(/\/$/, '')}/${picked.name}` : picked.name;
  openGithubEditor(ctx, { owner, name, branch, file: null, presetPath: targetPath, presetContent: picked.content ?? '' });
}

/**
 * 提交编辑器 —— 写操作的最后一道人工确认。
 * 流程：编辑内容 → 预览变更 → 填提交信息 → 输入仓库名二次确认 → 提交
 */
export async function openGithubEditor(ctx, { owner, name, branch, file, presetPath = '', presetContent = '' }) {
  const isNew = !file;
  const initialPath = file?.path || presetPath || '';
  const initialContent = file?.content ?? presetContent ?? '';
  const sha = file?.sha || null;

  const paint = () => `<div class="modal modal-lg">
    <div class="modal-head">
      <h3 class="modal-title">${isNew ? '在远端新建文件' : '编辑并提交到 GitHub'}</h3>
      <p class="modal-sub">${esc(owner)}/${esc(name)} · 分支 <span class="mono">${esc(branch)}</span></p>
    </div>
    <div class="modal-body">
      ${isNew
        ? `<label class="field-label">文件路径</label>
           <input class="input mono" id="ed-path" value="${esc(initialPath)}" placeholder="例如 docs/notes.md" autocomplete="off" spellcheck="false">
           <div style="height:12px"></div>`
        : `<div class="tiny muted" style="margin-bottom:8px">文件：<span class="mono">${esc(initialPath)}</span></div>`}
      <label class="field-label">内容</label>
      <textarea class="input mono" id="ed-content" spellcheck="false" rows="14">${esc(initialContent)}</textarea>

      <div style="height:14px"></div>
      <label class="field-label">提交信息（必填）</label>
      <input class="input" id="ed-msg" placeholder="例如：修正文档中的拼写错误" autocomplete="off">
      <div class="tiny muted" style="margin-top:6px" id="ed-stat"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn" data-act="preview">预览变更</button>
      <button class="btn btn-primary" data-act="next">下一步：确认提交</button>
    </div>
  </div>`;

  const bindMain = () => {
    const o = mount(paint());
    const content$ = o.querySelector('#ed-content');
    const stat$ = o.querySelector('#ed-stat');
    const upd = () => {
      const now = content$.value;
      const before = initialContent;
      if (now === before) { stat$.textContent = isNew ? `将新建 ${now.split('\n').length} 行` : '内容未修改'; return; }
      const a = before.split('\n').length;
      const b = now.split('\n').length;
      stat$.textContent = `行数 ${a} → ${b}，字符 ${before.length} → ${now.length}`;
    };
    content$.addEventListener('input', upd);
    upd();

    o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    o.querySelector('[data-act="preview"]').addEventListener('click', () => {
      const path = isNew ? o.querySelector('#ed-path').value.trim() : initialPath;
      if (!path) return toast('请先填写文件路径', 'err');
      confirmStep({ path, content: content$.value, message: o.querySelector('#ed-msg').value, dry: true });
    });
    o.querySelector('[data-act="next"]').addEventListener('click', () => {
      const path = isNew ? o.querySelector('#ed-path').value.trim() : initialPath;
      const content = content$.value;
      const message = o.querySelector('#ed-msg').value.trim();
      if (!path) return toast('请先填写文件路径', 'err');
      if (!message || message.length < 3) return toast('提交信息不能为空且不少于 3 个字符', 'err');
      if (content === initialContent && !isNew) return toast('内容没有变化，无需提交', 'err');
      confirmStep({ path, content, message, dry: false });
    });
  };

  /** 第二步：真正的二次确认 */
  const confirmStep = async ({ path, content, message, dry }) => {
    const o = mount(`<div class="modal modal-lg">
      <div class="modal-head">
        <h3 class="modal-title">确认这次远端提交</h3>
        <p class="modal-sub">这会<b>直接在 GitHub 上产生一个提交</b>，不会经过本地仓库。</p>
      </div>
      <div class="modal-body">
        <div class="loading"><span class="spinner"></span><span>正在核对远端当前版本</span></div>
      </div>
    </div>`);

    let pre;
    try {
      pre = await api.ghPreview({ owner, name, path, branch });
    } catch (e) {
      mount(`<div class="modal"><div class="modal-head"><h3 class="modal-title">无法核对远端</h3></div>
        <div class="modal-body"><div class="note note-err">${esc(e.message)}</div></div>
        <div class="modal-foot"><button class="btn" data-act="back">返回编辑</button><button class="btn" data-act="cancel">关闭</button></div></div>`);
      const oo = $('#overlay');
      oo.querySelector('[data-act="back"]').addEventListener('click', bindMain);
      oo.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
      return;
    }

    // 乐观锁核对：我们手上的 sha 必须仍是远端当前版本
    const remoteSha = pre.current?.sha || null;
    let conflict = null;
    if (isNew && remoteSha) conflict = `远端已存在同名文件（${remoteSha.slice(0, 7)}），继续提交会覆盖它。`;
    if (!isNew && !remoteSha) conflict = '远端该文件已不存在（可能已被删除）。';
    if (!isNew && remoteSha && sha && remoteSha !== sha && !dry) {
      conflict = `文件已被改动：你打开时是 ${sha.slice(0, 7)}，现在是 ${remoteSha.slice(0, 7)}。`;
    }

    const before = pre.current?.content ?? null;
    const diff = summarizeDiff(before, content);

    const o2 = mount(`<div class="modal modal-lg">
      <div class="modal-head">
        <h3 class="modal-title">${dry ? '变更预览' : '确认这次远端提交'}</h3>
        <p class="modal-sub">${esc(owner)}/${esc(name)} · <span class="mono">${esc(branch)}</span></p>
      </div>
      <div class="modal-body">
        ${conflict ? `<div class="note note-warn" style="margin-bottom:14px"><b>版本冲突：</b>${esc(conflict)}<br><span class="tiny">建议关闭本窗口，重新打开该文件后再编辑。</span></div>` : ''}
        <div class="kv"><span>文件</span><b class="mono">${esc(path)}</b></div>
        <div class="kv"><span>动作</span><b>${pre.exists ? '更新' : '新建'}</b></div>
        <div class="kv"><span>远端当前版本</span><b class="mono">${esc(remoteSha?.slice(0, 7) || '（不存在）')}</b></div>
        <div class="kv"><span>体积变化</span><b>${pre.current ? humanSize(pre.current.size / 1024) : '—'} → ${esc(humanSize(new Blob([content]).size / 1024))}</b></div>
        <div class="kv"><span>提交信息</span><b>${esc(message)}</b></div>
        <div class="kv"><span>行变化</span><b>+${diff.added} / −${diff.removed}</b></div>

        <p class="section-title" style="margin-top:16px">变更内容</p>
        <div class="diff">${diff.html}</div>

        ${dry ? '' : `<div style="height:14px"></div>
        <label class="field-label">为避免误触，请再次输入仓库名 <span class="mono">${esc(name)}</span></label>
        <input class="input mono" id="ed-confirm" placeholder="${esc(name)}" autocomplete="off" spellcheck="false">`}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="back">返回编辑</button>
        ${dry
          ? '<button class="btn btn-primary" data-act="cancel2">知道了</button>'
          : `<button class="btn btn-primary" data-act="submit" disabled>${conflict ? '仍要提交' : '提交到 GitHub'}</button>`}
      </div>
    </div>`);

    const backBtn = o2.querySelector('[data-act="back"]');
    backBtn?.addEventListener('click', bindMain);
    o2.querySelector('[data-act="cancel2"]')?.addEventListener('click', closeOverlay);

    const submitBtn = o2.querySelector('[data-act="submit"]');
    if (submitBtn) {
      const input = o2.querySelector('#ed-confirm');
      input.addEventListener('input', () => { submitBtn.disabled = input.value.trim() !== name; });
      submitBtn.addEventListener('click', async () => {
        submitBtn.disabled = true;
        submitBtn.textContent = '提交中…';
        try {
          const r = await api.ghCommit({
            owner, name, path, content, message, sha: remoteSha, branch, confirm: name,
          });
          if (r.noop) {
            mount(`<div class="modal"><div class="modal-head"><h3 class="modal-title">没有产生提交</h3></div>
              <div class="modal-body"><div class="note">${esc(r.reason || '内容与远端一致')}</div></div>
              <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div></div>`);
            $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
            return;
          }
          mount(`<div class="modal">
            <div class="modal-head"><h3 class="modal-title">已提交到 GitHub</h3>
              <p class="modal-sub">${esc(r.action === 'create' ? '新建' : '更新')} ${esc(r.path)}</p></div>
            <div class="modal-body">
              <div class="note note-ok">
                提交 <span class="mono">${esc(r.commitShort || '')}</span> 已创建。
                <div style="margin-top:8px">
                  <a class="link" href="${esc(r.commitUrl || '#')}" target="_blank" rel="noreferrer">在 GitHub 上查看这次提交 →</a>
                </div>
              </div>
              <p class="tiny muted" style="margin-top:12px">
                远端提交无法用本地快照回滚，如需撤销请在 GitHub 上 revert 该提交。
                本次操作已记入审计日志。
              </p>
            </div>
            <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
          </div>`);
          $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', () => {
            closeOverlay();
            ctx.refresh?.();
          });
        } catch (e) {
          submitBtn.disabled = false;
          submitBtn.textContent = '重试提交';
          toast(e.message, 'err');
        }
      });
    }
  };

  bindMain();
}

/** 生成一份简单的行级差异（新增/删除行），足够让人看清改了什么 */
export function summarizeDiff(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const n = Math.max(a.length, b.length);
  const rows = [];
  let added = 0;
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) {
      if (x !== undefined) rows.push(['same', ` ${x}`]);
      continue;
    }
    if (x !== undefined) { rows.push(['del', `-${x}`]); removed++; }
    if (y !== undefined) { rows.push(['add', `+${y}`]); added++; }
  }
  if (!before) return { added: b.length, removed: 0, html: `<pre>${b.map((l) => esc('+' + l)).join('\n')}</pre>` };
  if (rows.length > 400) rows.length = 400;
  const html = `<pre>${rows.map(([k, t]) => `<span class="d-${k}">${esc(t)}</span>`).join('\n')}</pre>`;
  return { added, removed, html };
}

/* ============================================================
   GitHub · 克隆向导
   ============================================================ */

export async function openCloneWizard(ctx, presetUrl = '') {
  let parsed = null;
  let parentDir = '';

  const paint = () => `<div class="modal">
    <div class="modal-head">
      <h3 class="modal-title">从 GitHub 克隆到本地</h3>
      <p class="modal-sub">克隆是<b>只读远端</b>的：不会修改 GitHub 上的任何东西。</p>
    </div>
    <div class="modal-body">
      <label class="field-label">仓库地址</label>
      <input class="input mono" id="cl-url" placeholder="owner/name 或 https://github.com/owner/name" value="${esc(presetUrl)}" autocomplete="off" spellcheck="false">

      <div style="height:12px"></div>
      <label class="field-label">克隆到</label>
      <div class="row" style="gap:8px">
        <input class="input mono" id="cl-dir" placeholder="选择一个父目录，仓库会建在它下面" value="${esc(parentDir)}" autocomplete="off" spellcheck="false">
        <button class="btn" data-act="pick" style="flex:0 0 auto">选择…</button>
      </div>

      <div style="height:12px"></div>
      <label class="field-label">目录名（可选）</label>
      <input class="input mono" id="cl-name" placeholder="留空则使用仓库名" autocomplete="off" spellcheck="false">

      <div id="cl-info" style="margin-top:14px"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="go">开始克隆</button>
    </div>
  </div>`;

  const o = mount(paint());
  const url$ = o.querySelector('#cl-url');
  const dir$ = o.querySelector('#cl-dir');
  const name$ = o.querySelector('#cl-name');
  const info$ = o.querySelector('#cl-info');

  const refreshInfo = async () => {
    const raw = url$.value.trim();
    if (!raw) { info$.innerHTML = ''; return; }
    try {
      const p = await api.ghParse(raw);
      parsed = p;
      const dest = dir$.value.trim() ? `${dir$.value.trim().replace(/[\\/]$/, '')}\\${name$.value.trim() || p.name}` : '';
      info$.innerHTML = `<div class="note">
        <div><b>${esc(p.owner)}/${esc(p.name)}</b></div>
        <div class="tiny muted mono" style="margin-top:4px">${esc(p.httpsUrl)}</div>
        ${dest ? `<div class="tiny" style="margin-top:8px">将创建到 <span class="mono">${esc(dest)}</span></div>` : ''}
      </div>`;
    } catch (e) {
      parsed = null;
      info$.innerHTML = `<div class="note note-err">${esc(e.message)}</div>`;
    }
  };
  url$.addEventListener('input', refreshInfo);
  dir$.addEventListener('input', refreshInfo);
  name$.addEventListener('input', refreshInfo);
  if (presetUrl) refreshInfo();

  o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
  o.querySelector('[data-act="pick"]').addEventListener('click', async () => {
    try {
      const r = await api.pickFolder({ title: '选择克隆到哪个目录', defaultPath: parentDir || undefined });
      if (r?.canceled) return;
      if (r?.path) { parentDir = r.path; dir$.value = r.path; refreshInfo(); }
    } catch (e) { toast(e.message, 'err'); }
  });

  o.querySelector('[data-act="go"]').addEventListener('click', async () => {
    const raw = url$.value.trim();
    const dir = dir$.value.trim();
    if (!raw) return toast('请填写仓库地址', 'err');
    if (!dir) return toast('请选择要克隆到哪个目录', 'err');

    const o2 = mount(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">正在克隆…</h3><p class="modal-sub">${esc(raw)}</p></div>
      <div class="modal-body"><div class="loading"><span class="spinner"></span><span>从 github.com 拉取，请稍候</span></div>
        <p class="tiny muted" style="margin-top:12px">克隆一个中等大小的仓库通常需要几秒到几十秒。若网络受限可能失败，届时会给出具体原因。</p>
      </div>
    </div>`);

    try {
      const r = await api.ghClone({ url: raw, parentDir: dir, dirName: name$.value.trim() || undefined });
      o2.innerHTML = `<div class="modal">
        <div class="modal-head"><h3 class="modal-title">克隆完成</h3>
          <p class="modal-sub">${esc(r.owner)}/${esc(r.name)} · ${(r.tookMs / 1000).toFixed(1)}s</p></div>
        <div class="modal-body">
          <div class="note note-ok">
            已克隆到 <span class="mono">${esc(r.target)}</span>
            ${r.usedAuth ? '<div class="tiny" style="margin-top:4px">使用了当前 GitHub 授权完成鉴权。</div>' : ''}
          </div>
          ${r.repo ? '<p class="tiny muted" style="margin-top:10px">已自动接入本系统，可以直接查看它的体检结果。</p>' : `<div class="note note-warn" style="margin-top:10px">克隆成功但自动接入失败：${esc(r.openError || '')}</div>`}
        </div>
        <div class="modal-foot"><button class="btn btn-primary" data-act="open">查看这个仓库</button><button class="btn" data-act="cancel">关闭</button></div>
      </div>`;
      o2.querySelector('[data-act="cancel"]').addEventListener('click', () => { closeOverlay(); ctx.refresh?.(); });
      o2.querySelector('[data-act="open"]').addEventListener('click', async () => {
        closeOverlay();
        if (r.repo) await ctx.selectRepo?.(r.repo.id);
        else await ctx.refresh?.();
      });
    } catch (e) {
      o2.innerHTML = `<div class="modal">
        <div class="modal-head"><h3 class="modal-title">克隆失败</h3></div>
        <div class="modal-body"><div class="note note-err" style="white-space:pre-wrap">${esc(e.message)}</div></div>
        <div class="modal-foot"><button class="btn" data-act="cancel">关闭</button></div>
      </div>`;
      o2.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    }
  });
}

/* ============================================================
   GitHub · 本地仓库「提交并推送」
   ============================================================ */

/**
 * 这是本系统里唯一会改变本地提交历史的路径，所以做成三步：
 *   状态检查 → 目标与提交信息 → 输入仓库名二次确认 → 执行
 * 之前根本没有这个入口，用户只能跑命令行；文件级的入口又埋得很深，
 * 因此这里同时承担「把入口摆到明面上」的职责。
 */
export async function openPublishWizard(ctx) {
  const repo = ctx.state.repo;
  if (!repo) { toast('请先接入一个本地仓库'); return; }

  mount(`<div class="modal modal-lg">
    <div class="modal-head"><h3 class="modal-title">提交并推送</h3>
      <p class="modal-sub">${esc(repo.name)}</p></div>
    <div class="modal-body"><div class="loading"><span class="spinner"></span><span>正在检查仓库状态</span></div></div>
  </div>`);
  dispose = escClose(closeOverlay);

  let st;
  let gh;
  try {
    [st, gh] = await Promise.all([api.publishStatus(repo.id), api.ghStatus()]);
  } catch (e) {
    return showError('读取仓库状态失败', e);
  }

  /* ---- 未连接 GitHub：给一条去连接的路，而不是一句空报错 ---- */
  if (!gh.connected) {
    mount(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">还没有连接 GitHub</h3></div>
      <div class="modal-body">
        <div class="note">推送需要 GitHub 授权。当前尚未连接，无法确定要推给谁。</div>
        <p class="tiny muted" style="margin-top:10px">仓库状态已经读取完毕，连接后可以直接回来继续。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">关闭</button>
        <button class="btn btn-primary" data-act="go-gh">去连接 GitHub</button>
      </div>
    </div>`);
    $('#overlay').querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    $('#overlay').querySelector('[data-act="go-gh"]').addEventListener('click', async () => {
      closeOverlay();
      ctx.state.view = 'github';
      await ctx.refresh?.();
    });
    return;
  }

  /* ---- 工作区与提交历史的状态提示 ---- */
  const ch = st.changes || { total: 0, files: [] };
  const hasGitIdentity = !!st.identity?.configured;
  const match = st.githubMatch || null;

  /* ---- 表单 ---- */
  const state = {
    // 本地已经绑了 GitHub 远端，或者账号里存在同名仓库 → 默认「推送到已有仓库」
    mode: st.remote.isGithub || match ? 'existing' : 'create',
    repoName: repo.name || '',
    isPrivate: true,
    description: '',
    owner: st.remote.owner || match?.owner || gh.viewer?.login || '',
    name: st.remote.name || match?.name || '',
    branch: st.branch,
    includeChanges: ch.total > 0,
    message: '',
    repos: null,
    repoLoading: false,
  };

  const changeList = () => {
    if (!ch.total) {
      return '<div class="note" style="margin:0">工作区干净，没有需要提交的改动。</div>';
    }
    const shown = ch.files.slice(0, 12);
    const rows = shown
      .map((f) => `<div class="pub-file"><span class="badge ${f.untracked ? 'b-gray' : 'b-blue-soft'}">${esc(f.label)}</span><span class="mono" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</span></div>`)
      .join('');
    const more = ch.total > shown.length ? `<div class="tiny muted" style="margin-top:6px">还有 ${ch.total - shown.length} 项未列出…</div>` : '';
    return `<div class="pub-files">${rows}</div>${more}`;
  };

  const repoOptions = () => {
    if (state.repoLoading) return '<option>正在读取你的仓库…</option>';
    const list = state.repos || [];
    if (!list.length) return '<option value="">（没有读取到仓库，可直接填 owner/name）</option>';
    return ['<option value="">— 选择我的仓库 —</option>']
      .concat(list.map((r) => `<option value="${esc(r.fullName)}"${state.owner && state.name && r.fullName === `${state.owner}/${state.name}` ? ' selected' : ''}>${esc(r.fullName)}${r.private ? ' （私有）' : ''}</option>`))
      .join('');
  };

  const paint = () => `<div class="modal modal-lg">
    <div class="modal-head">
      <h3 class="modal-title">提交并推送</h3>
      <p class="modal-sub">${esc(repo.name)} · 分支 <span class="mono">${esc(state.branch)}</span>
        ${st.headShort ? `· 当前 <span class="mono">${esc(st.headShort)}</span>` : '· 尚无提交'}</p>
    </div>
    <div class="modal-body">
      ${st.reasons.length ? `<div class="note note-err" style="margin-bottom:14px">${st.reasons.map((r) => esc(r)).join('<br>')}</div>` : ''}
      ${match && !st.remote.isGithub ? `<div class="note note-warn" style="margin-bottom:14px">
        <b>这个本地仓库在 GitHub 上疑似已有对应：</b><span class="mono">${esc(match.fullName)}</span>
        ${match.private ? '<span class="badge b-orange">私有</span>' : '<span class="badge b-gray">公开</span>'}
        ${match.defaultBranch ? `· 默认分支 <span class="mono">${esc(match.defaultBranch)}</span>` : ''}
        <div class="tiny muted" style="margin-top:6px">
          判断依据是<b>本地目录名与账号内仓库同名</b>，不是凭据级的事实认定 —— 本地 <span class="mono">.git/config</span> 里并没有配 GitHub 远端。
          已替你预选它；若这不是你要推的地方，切到左边「新建 GitHub 仓库」。
        </div>
      </div>` : ''}
      ${!st.remote.isGithub && !match && st.remote.exists ? `<div class="note" style="margin-bottom:14px">
        当前 origin 指向 <span class="mono">${esc(st.remote.url)}</span>（不是 GitHub），且账号里没有同名仓库，因此默认按「新建仓库」处理。
      </div>` : ''}

      <p class="section-title" style="margin-top:0">1 · 推到哪个仓库</p>
      <div class="seg" id="pub-mode">
        <button class="seg-item${state.mode === 'create' ? ' active' : ''}" data-mode="create">新建 GitHub 仓库</button>
        <button class="seg-item${state.mode === 'existing' ? ' active' : ''}" data-mode="existing">推送到已有仓库</button>
      </div>

      <div id="pub-target" style="margin-top:12px">
        ${state.mode === 'create'
          ? `<label class="field-label">新仓库名</label>
             <input class="input mono" id="pub-name" value="${esc(state.repoName)}" placeholder="例如 my-vibe-project" autocomplete="off" spellcheck="false">
             <div class="row" style="gap:8px;margin-top:8px;align-items:center">
               <div class="seg" id="pub-vis">
                 <button class="seg-item${state.isPrivate ? ' active' : ''}" data-vis="private">私有</button>
                 <button class="seg-item${!state.isPrivate ? ' active' : ''}" data-vis="public">公开</button>
               </div>
               <input class="input" id="pub-desc" value="${esc(state.description)}" placeholder="描述（可选）" autocomplete="off" style="flex:1">
             </div>
             <p class="tiny muted" style="margin-top:6px">会创建一个<b>空仓库</b>（不自动生成 README），这样本地历史才能直接推上去。</p>`
          : `<label class="field-label">目标仓库</label>
             <select class="input" id="pub-select">${repoOptions()}</select>
             <div class="row" style="gap:8px;margin-top:8px">
               <input class="input mono" id="pub-owner" value="${esc(state.owner)}" placeholder="owner" autocomplete="off" spellcheck="false" style="flex:1">
               <span class="muted">/</span>
               <input class="input mono" id="pub-repo" value="${esc(state.name)}" placeholder="repo" autocomplete="off" spellcheck="false" style="flex:1">
             </div>
             ${st.remote.exists && !st.remote.isGithub ? `<p class="tiny muted" style="margin-top:6px">当前 origin 指向 ${esc(st.remote.url)}，本次会把它改指到 GitHub。</p>` : ''}`}
      </div>

      <p class="section-title">2 · 提交工作区改动</p>
      <label class="row pub-check">
        <input type="checkbox" id="pub-include" ${state.includeChanges ? 'checked' : ''}>
        <span>把工作区改动一并提交${ch.total ? `（${ch.total} 项）` : ''}</span>
      </label>
      <div style="margin-top:10px">${changeList()}</div>
      <div style="margin-top:10px">
        <label class="field-label">提交信息${state.includeChanges && ch.total ? '（必填）' : '（可选）'}</label>
        <input class="input" id="pub-msg" value="${esc(state.message)}" placeholder="例如：首次发布" autocomplete="off">
        ${!hasGitIdentity ? '<p class="tiny muted" style="margin-top:6px">这个仓库没配 git 提交身份，本次会用你已连接的 GitHub 账号代为署名（仅写入环境变量，不改任何配置文件）。</p>' : ''}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="next">下一步：确认</button>
    </div>
  </div>`;

  const loadRepos = async () => {
    if (state.repos || state.repoLoading) return;
    state.repoLoading = true;
    bind();
    try {
      state.repos = await api.ghRepos({ perPage: 100 });
    } catch {
      state.repos = [];
    }
    state.repoLoading = false;
    bind();
  };

  const readForm = () => {
    const q = (id) => $('#overlay').querySelector(id);
    if (state.mode === 'create') {
      state.repoName = q('#pub-name')?.value.trim() || '';
    } else {
      state.owner = q('#pub-owner')?.value.trim() || '';
      state.name = q('#pub-repo')?.value.trim() || '';
    }
    state.message = q('#pub-msg')?.value ?? state.message;
    const desc = q('#pub-desc');
    if (desc) state.description = desc.value;
    const inc = q('#pub-include');
    state.includeChanges = inc ? inc.checked : state.includeChanges;
  };

  const bind = () => {
    const o = mount(paint());
    const q = (s) => o.querySelector(s);

    q('[data-act="cancel"]').addEventListener('click', closeOverlay);

    o.querySelectorAll('#pub-mode .seg-item').forEach((el) =>
      el.addEventListener('click', () => {
        readForm();
        state.mode = el.dataset.mode;
        if (state.mode === 'existing' && !state.repos) { bind(); loadRepos(); return; }
        bind();
      }),
    );
    o.querySelectorAll('#pub-vis .seg-item').forEach((el) =>
      el.addEventListener('click', () => {
        readForm();
        state.isPrivate = el.dataset.vis === 'private';
        bind();
      }),
    );
    q('#pub-select')?.addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      const [ow, nm] = v.split('/');
      state.owner = ow;
      state.name = nm;
      bind();
    });
    q('#pub-include')?.addEventListener('change', (e) => {
      readForm();
      state.includeChanges = e.target.checked;
      bind();
    });

    q('[data-act="next"]').addEventListener('click', () => {
      readForm();
      if (state.mode === 'create') {
        if (!state.repoName) return toast('请填写新仓库名', 'err');
        if (!/^[A-Za-z0-9._-]+$/.test(state.repoName)) return toast('仓库名只能包含字母、数字、. _ -', 'err');
      } else {
        if (!state.owner || !state.name) return toast('请填写目标仓库的 owner/name', 'err');
      }
      if (state.includeChanges && ch.total > 0 && state.message.trim().length < 3) {
        return toast('要提交改动就必须填写提交信息（不少于 3 个字符）', 'err');
      }
      if (!st.hasCommits && !(state.includeChanges && ch.total > 0)) {
        return toast('这个仓库还没有任何提交，请勾选「一并提交工作区改动」', 'err');
      }
      confirmStep();
    });
  };

  /* ---- 第二步：确认 ---- */
  const confirmStep = () => {
    const targetName = state.mode === 'create' ? state.repoName : state.name;
    const targetFull = state.mode === 'create' ? `${gh.viewer?.login || ''}/${state.repoName}` : `${state.owner}/${state.name}`;
    const willCommit = state.includeChanges && ch.total > 0;

    const o = mount(`<div class="modal modal-lg">
      <div class="modal-head">
        <h3 class="modal-title">确认这次操作</h3>
        <p class="modal-sub">这会<b>改动本地提交历史</b>，并把内容推到 GitHub 上。</p>
      </div>
      <div class="modal-body">
        <div class="kv"><span>目标仓库</span><b class="mono">${esc(targetFull)}</b></div>
        <div class="kv"><span>仓库动作</span><b>${state.mode === 'create' ? '新建空仓库' : '使用已有仓库'}</b></div>
        <div class="kv"><span>分支</span><b class="mono">${esc(state.branch)}</b></div>
        <div class="kv"><span>本地提交</span><b>${willCommit ? `会提交 ${ch.total} 项改动` : '不提交改动，只推送已有提交'}</b></div>
        ${willCommit ? `<div class="kv"><span>提交信息</span><b>${esc(state.message)}</b></div>` : ''}
        <div class="kv"><span>快照</span><b>提交前会自动记一个 <span class="mono">refs/gm/prepush/*</span>，可回退</b></div>

        ${willCommit ? `<p class="section-title" style="margin-top:16px">将提交的文件</p><div class="pub-files">${ch.files.slice(0, 20).map((f) => `<div class="pub-file"><span class="badge ${f.untracked ? 'b-gray' : 'b-blue-soft'}">${esc(f.label)}</span><span class="mono" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</span></div>`).join('')}${ch.total > 20 ? `<div class="tiny muted" style="margin-top:6px">还有 ${ch.total - 20} 项…</div>` : ''}</div>` : ''}

        <div style="height:14px"></div>
        <label class="field-label">为避免误触，请输入仓库名 <span class="mono">${esc(targetName)}</span></label>
        <input class="input mono" id="pub-confirm" placeholder="${esc(targetName)}" autocomplete="off" spellcheck="false">
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="back">返回修改</button>
        <button class="btn btn-primary" data-act="submit" disabled>执行</button>
      </div>
    </div>`);

    o.querySelector('[data-act="back"]').addEventListener('click', bind);

    const submit = o.querySelector('[data-act="submit"]');
    const input = o.querySelector('#pub-confirm');
    input.addEventListener('input', () => { submit.disabled = input.value.trim() !== targetName; });

    submit.addEventListener('click', async () => {
      submit.disabled = true;
      submit.textContent = '执行中…';
      o.querySelector('.modal-body').innerHTML =
        '<div class="loading"><span class="spinner"></span><span>正在提交并推送，请稍候</span></div>' +
        '<p class="tiny muted" style="margin-top:12px">首次推送会把本地全部历史传上去，仓库大的话会慢一些。</p>';
      try {
        const r = await api.publish(repo.id, {
          mode: state.mode,
          repoName: state.mode === 'create' ? state.repoName : undefined,
          private: state.isPrivate,
          description: state.description,
          owner: state.mode === 'existing' ? state.owner : undefined,
          name: state.mode === 'existing' ? state.name : undefined,
          message: state.message,
          includeChanges: state.includeChanges,
          branch: state.branch,
          confirm: targetName,
        });
        done(r);
      } catch (e) {
        showError('推送失败', e, bind);
      }
    });
  };

  const done = (r) => {
    mount(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">已推送</h3>
        <p class="modal-sub">${esc(r.owner)}/${esc(r.name)} · ${(r.tookMs / 1000).toFixed(1)}s</p></div>
      <div class="modal-body">
        <div class="note note-ok">
          ${r.created ? '远端仓库已创建，' : ''}分支 <span class="mono">${esc(r.branch)}</span> 已推送${r.committed ? `，本地提交 <span class="mono">${esc(r.commitShort || '')}</span> 已创建` : ''}。
          <div style="margin-top:8px"><a class="link" href="${esc(r.webUrl)}" target="_blank" rel="noreferrer">在 GitHub 上查看 →</a></div>
        </div>
        <div style="margin-top:14px">${r.steps.map((s) => `<div class="pub-step"><span class="badge ${s.ok ? 'b-green' : 'b-gray'}">${s.ok ? '✓' : '—'}</span><span class="tiny">${esc(s.detail)}</span></div>`).join('')}</div>
        ${r.snapshotRef ? `<p class="tiny muted" style="margin-top:12px">回退点：<span class="mono">${esc(r.snapshotRef)}</span>（如需撤销本次本地提交：<span class="mono">git reset --soft ${esc(r.snapshotRef)}</span>）</p>` : ''}
        ${r.skippedChanges ? `<p class="tiny muted" style="margin-top:8px">注意：按你的选择跳过了提交，工作区还有 ${r.skippedChanges} 项改动没有进去。</p>` : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-primary" data-act="close">完成</button></div>
    </div>`);
    $('#overlay').querySelector('[data-act="close"]').addEventListener('click', async () => {
      closeOverlay();
      await ctx.refresh?.();
    });
  };

  // 注意：这里必须是 function 声明而不是 const 箭头函数。
  // 上面读取状态失败时会「提前」调用 showError，此时后面的 const 还处于 TDZ。
  function showError(title, e, back) {
    const hint = e?.data?.hint || e?.hint;
    const stderr = e?.data?.stderr || '';
    mount(`<div class="modal modal-lg">
      <div class="modal-head"><h3 class="modal-title">${esc(title)}</h3>
        ${e?.data?.code ? `<p class="modal-sub mono">${esc(e.data.code)}</p>` : ''}</div>
      <div class="modal-body">
        <div class="note note-err" style="white-space:pre-wrap">${esc(e?.message || '未知错误')}</div>
        ${hint ? `<div class="note note-warn" style="margin-top:12px"><b>怎么办：</b>${esc(hint)}</div>` : ''}
        ${stderr ? `<details style="margin-top:12px"><summary class="tiny muted">原始 git 输出</summary><pre class="mono tiny note" style="white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:8px">${esc(stderr)}</pre></details>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">关闭</button>
        ${back ? '<button class="btn btn-primary" data-act="back">返回修改</button>' : ''}
      </div>
    </div>`);
    const o = $('#overlay');
    o.querySelector('[data-act="cancel"]').addEventListener('click', closeOverlay);
    // 只有「推送失败」这条路径才会带返回按钮，此时 bind 早已初始化
    const backBtn = o.querySelector('[data-act="back"]');
    if (backBtn && back) backBtn.addEventListener('click', back);
  }

  bind();
}
