import { esc, relTime, fmtDay, pct, ring, GRADE, branchBadges, heatmap } from './util.js';

function metricCard(label, value, sub = '') {
  return `<div class="metric">
    <p class="metric-label">${esc(label)}</p>
    <p class="metric-value">${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ''}</p>
  </div>`;
}

export function renderLoading(text = '正在读取仓库…') {
  return `<div class="loading"><span class="spinner"></span><span>${esc(text)}</span></div>`;
}

/* ---------------- 空状态 / 仓库接入 ---------------- */

export function renderEmpty(state) {
  const repos = state.repos || [];
  const list = repos.length
    ? repos
        .map(
          (r) => `<button class="repo-item${r.exists ? '' : ' offline'}" data-action="select-repo" data-id="${esc(r.id)}" ${r.exists ? '' : 'disabled'}>
            <span class="branch-glyph">◇</span>
            <span style="min-width:0;flex:1">
              <span class="repo-item-title" style="display:block">${esc(r.name || r.path.split(/[\\/]/).pop())}</span>
              <span class="repo-item-path" style="display:block">${esc(r.path)}${r.exists ? '' : ' · 目录已不存在'}</span>
            </span>
            <span class="badge b-gray">打开</span>
          </button>`,
        )
        .join('')
    : '<p class="muted tiny" style="text-align:center;padding:14px 0">还没有接入过仓库</p>';

  return `<div class="empty">
    <h2>接入一个本地 Git 仓库</h2>
    <p>零侵入接入：只读取 <span class="mono">.git</span>，不重建历史、不改动工作区。</p>

    <div class="empty-actions">
      <button class="btn btn-primary btn-lg" data-action="pick-folder">
        <span class="btn-ico">▣</span> 选择文件夹…
      </button>
      <button class="btn btn-lg" data-action="open-scan">
        <span class="btn-ico">⌕</span> 扫描磁盘找仓库
      </button>
    </div>

    <p class="tiny muted" style="margin:14px 0 0">
      <button class="link" data-action="toggle-manual">手动输入路径</button>
    </p>
    <div id="manual-box" class="hidden" style="margin-top:12px">
      <div class="row" style="gap:8px">
        <input class="input" id="repo-path" placeholder="例如 D:/code/my-project" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-action="open-repo" style="flex:0 0 auto">接入</button>
      </div>
    </div>

    <div class="safe-note">
      <span class="safe-dot"></span>
      选择与扫描都是<b>只读</b>操作：只检查目录里有没有 <span class="mono">.git</span>，不读文件内容、不写入任何东西。
    </div>

    <p class="tiny muted" style="margin:20px 0 8px;text-align:left">最近接入</p>
    <div style="text-align:left">${list}</div>
  </div>`;
}

/* ---------------- 概览 ---------------- */

export function renderOverview({ overview: o, health: h, activity: a, commits: cm }) {
  const metrics = [
    metricCard('提交总数', o.totalCommits),
    metricCard('本地分支', o.localBranches),
    metricCard('未提交改动', o.status.dirtyCount, o.status.dirtyCount ? '待处理' : ''),
    metricCard('未合并分支', h.metrics.unmergedBranches),
    metricCard('stash 堆积', o.stashCount),
    metricCard('AI 参与度', pct(o.ai.ratio), '估算'),
  ].join('');

  const issues = h.issues.length
    ? h.issues
        .map(
          (i) => `<div class="issue">
            <span class="issue-dot dot-${esc(i.level)}"></span>
            <div class="issue-body">
              <div class="issue-title">${esc(i.title)}</div>
              ${i.detail ? `<div class="issue-detail">${esc(i.detail)}</div>` : ''}
            </div>
          </div>`,
        )
        .join('')
    : '<div class="issue-ok"><span class="badge b-green">✓</span><span>没有发现需要处理的问题，仓库很干净</span></div>';

  const recent = cm
    .slice(0, 8)
    .map(
      (c) => `<div class="list-row">
        <span class="mono tiny muted" style="flex:0 0 58px">${esc(c.short)}</span>
        <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.subject)}">${esc(c.subject || '(无提交信息)')}</span>
        ${c.isAI ? '<span class="badge b-blue">AI</span>' : ''}
        <span class="tiny muted" style="flex:0 0 62px;text-align:right">${esc(relTime(c.date))}</span>
      </div>`,
    )
    .join('');

  return `
  <div class="section">
    <div class="hero">
      <div class="card ring-card">
        <div class="ring-wrap">
          ${ring(h.score)}
          <div class="ring-center">
            <span class="ring-score">${h.score}</span>
            <span class="ring-grade">${esc(GRADE[h.grade] || '')}</span>
          </div>
        </div>
        <div class="tiny muted">健康度评分</div>
      </div>
      <div class="grid g-3">${metrics}</div>
    </div>
  </div>

  <div class="section">
    <p class="section-title">提交活跃度 · 近 ${a.weeks} 周（${a.total} 次提交）</p>
    <div class="card heatmap-card">
      ${heatmap(a)}
      <div class="hm-legend"><span>少</span><span class="hm"></span><span class="hm hm-1"></span><span class="hm hm-2"></span><span class="hm hm-3"></span><span class="hm hm-4"></span><span>多</span></div>
    </div>
  </div>

  <div class="section">
    <p class="section-title">待处理问题 · ${h.issues.length}</p>
    <div class="card" style="padding:6px 16px">${issues}</div>
  </div>

  <div class="section">
    <p class="section-title">最近提交</p>
    <div class="card" style="padding:6px 16px">${recent || '<p class="muted tiny">暂无提交</p>'}</div>
  </div>`;
}

/* ---------------- 分支 ---------------- */

export function renderBranches({ branches: br, overview: o }) {
  const rows = br.local
    .map((b) => {
      const blocked = !!b.lockedBy || b.isCurrent;
      const btn = b.isCurrent
        ? '<span class="tiny muted" style="flex:0 0 auto">已检出</span>'
        : `<button class="btn btn-sm${blocked ? '' : ' btn-primary'}" data-action="switch" data-branch="${esc(b.name)}" ${blocked ? 'disabled title="' + esc(b.lockedBy ? '被工作树 ' + b.lockedBy + ' 占用' : '') + '"' : ''}>切换</button>`;
      return `<div class="list-row branch-row">
        <span class="branch-glyph">⑂</span>
        <div style="min-width:0;flex:1">
          <div class="branch-name">${esc(b.name)}</div>
          <div class="branch-sub">${esc(b.sha)} · ${esc(b.subject || '(无提交信息)')} · ${esc(relTime(b.date))}</div>
        </div>
        <div class="row" style="gap:8px;flex:0 0 auto">
          <div class="branch-badges" style="margin-left:0">${branchBadges(b)}</div>
          ${btn}
        </div>
      </div>`;
    })
    .join('');

  const stale = br.local.filter((b) => b.isStale).length;
  const unmerged = br.local.filter((b) => !b.isMerged && !b.isCurrent).length;

  return `
  <div class="section">
    <div class="spread" style="margin-bottom:10px">
      <p class="section-title" style="margin:0">本地分支 · ${br.local.length}</p>
      <div class="row" style="gap:6px">
        <span class="badge b-blue">当前 ${esc(br.current || '—')}</span>
        ${br.dirtyCount ? `<span class="badge b-orange">${br.dirtyCount} 处未提交</span>` : '<span class="badge b-green">工作区干净</span>'}
        ${stale ? `<span class="badge b-gray">${stale} 个 stale</span>` : ''}
        ${unmerged ? `<span class="badge b-plain">${unmerged} 个未合并</span>` : ''}
      </div>
    </div>
    <div class="card" style="padding:6px">${rows || '<p class="muted tiny" style="padding:10px">没有本地分支</p>'}</div>
    <p class="tiny muted" style="margin-top:10px">切换分支会先做安全检查；若工作区有未提交改动，会先自动快照再切换，可随时撤销。</p>
  </div>

  ${
    br.remotes.length
      ? `<div class="section">
          <p class="section-title">远端分支 · ${br.remotes.length}</p>
          <div class="card" style="padding:6px 16px">
            ${br.remotes
              .slice(0, 20)
              .map((r) => `<div class="list-row"><span class="mono tiny" style="flex:1">${esc(r.name)}</span><span class="tiny muted">${esc(relTime(r.date))}</span></div>`)
              .join('')}
          </div>
        </div>`
      : ''
  }`;
}

/* ---------------- 提交记录 ---------------- */

export function renderCommits({ commits: cm }) {
  const rows = cm
    .map(
      (c) => `<div class="list-row">
        <span class="mono tiny muted" style="flex:0 0 58px">${esc(c.short)}</span>
        <div style="min-width:0;flex:1">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.subject)}">${esc(c.subject || '(无提交信息)')}</div>
          <div class="tiny muted">${esc(c.author)} · ${esc(fmtDay(c.date))}</div>
        </div>
        ${c.refs.map((r) => `<span class="badge b-plain">${esc(r)}</span>`).join('')}
        ${c.isAI ? '<span class="badge b-blue">AI</span>' : ''}
      </div>`,
    )
    .join('');
  return `<div class="section">
    <p class="section-title">最近 ${cm.length} 次提交</p>
    <div class="card" style="padding:6px 16px">${rows || '<p class="muted tiny">暂无提交</p>'}</div>
    <p class="tiny muted" style="margin-top:10px">带 <span class="badge b-blue">AI</span> 标记的提交，是在提交信息或署名中发现 AI 痕迹（启发性估算）。</p>
  </div>`;
}

/* ---------------- 操作日志 ---------------- */

export function renderLog({ logs }) {
  const hasUndoable = logs.some((l) => l.op === 'switch' && !l.undone);
  const rows = logs
    .map(
      (l) => `<tr>
        <td class="mono tiny muted" style="white-space:nowrap">${esc(fmtDay(l.ts))}</td>
        <td><span class="badge ${l.op === 'switch' ? 'b-blue' : l.op === 'undo' ? 'b-plain' : 'b-gray'}">${esc(l.op === 'switch' ? '切换分支' : l.op === 'undo' ? '撤销' : l.op)}</span></td>
        <td class="mono tiny">${esc(l.from || '—')} <span class="muted">→</span> ${esc(l.to || '—')}</td>
        <td class="tiny muted">${esc(l.strategy || '')}</td>
        <td class="tiny ${l.result === 'ok' ? 'muted' : ''}">${l.undone ? '<span class="badge b-gray">已撤销</span>' : esc(l.result === 'ok' ? '成功' : l.result || '')}</td>
        <td>${l.snapshotRef ? `<span class="badge b-orange" title="${esc(l.rollbackHint || '')}">有快照</span>` : ''}</td>
      </tr>`,
    )
    .join('');

  return `<div class="section">
    <div class="spread" style="margin-bottom:10px">
      <p class="section-title" style="margin:0">操作日志 · ${logs.length}</p>
      ${hasUndoable ? '<button class="btn btn-sm" data-action="undo">撤销上一次切换</button>' : ''}
    </div>
    <div class="card" style="padding:14px 16px">
      ${
        logs.length
          ? `<table class="table"><thead><tr><th>时间</th><th>操作</th><th>分支变化</th><th>策略</th><th>结果</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="muted tiny">还没有任何写操作。系统默认只读，只有你主动切换分支时才会计入这里。</p>'
      }
    </div>
    <p class="tiny muted" style="margin-top:10px">所有写操作都会记录在此，并且可以一键撤销。快照存放在 <span class="mono">refs/gm/snapshots/*</span>，不会污染你的 stash 列表。</p>
  </div>`;
}
