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

/* ---------------- AI 协作痕迹 ---------------- */

export const AI_LEVEL_LABEL = {
  high: '高置信',
  likely: '疑似',
  weak: '弱痕迹',
  none: '未发现',
};

/** 服务端没给免责声明时的兜底文案 —— 措辞必须保守，不能把推断说成事实 */
export const DEFAULT_AI_DISCLAIMER =
  '这是基于本地 git 元数据的痕迹推断，不是事实判定。没检出痕迹不代表没有 AI 参与。';

const AI_LEVEL_NOTE = {
  high: '发现 AI 署名或生成标记等显式证据。',
  likely: '提交形态与节奏符合 AI 习惯，但**没有显式证据** —— 严谨的人类开发者也可能写成这样，请结合依据自行判断。',
  weak: '只命中少量启发式信号，不足以定性，仅作提示。',
  none: '没有检出可识别的痕迹。这不代表没有 AI 参与。',
};

const AI_BUCKETS = [
  ['high', '高置信', '#0A84FF'],
  ['likely', '疑似', 'rgba(10,132,255,.5)'],
  ['weak', '弱痕迹', 'rgba(142,142,147,.45)'],
  ['none', '未发现', 'rgba(142,142,147,.16)'],
];

/** 提交列表里的 AI 徽章 —— 区分「高置信」与「疑似」，不搞一刀切 */
export function aiBadge(c) {
  const lv = c?.aiLevel || (c?.isAI ? 'likely' : 'none');
  if (lv === 'high') return '<span class="badge b-blue" title="高置信：存在 AI 署名／生成标记等显式证据">AI</span>';
  if (lv === 'likely') return '<span class="badge b-blue-soft" title="疑似：提交形态与节奏符合 AI 习惯（无显式证据）">AI?</span>';
  if (lv === 'weak') return '<span class="badge b-dim" title="弱痕迹：只命中少量启发式信号">AI?</span>';
  return '';
}

/**
 * AI 协作痕迹面板：把「靠什么判的」摊开给用户，而不是甩一个百分比。
 * 用户曾反馈「全是我用 AI 写的却报 0%」—— 只给数字而不给依据，既不准也无法验证。
 */
export function renderAiPanel(ai) {
  if (!ai || !ai.sampled) {
    return `<div class="card" style="margin-top:12px">
      <p class="section-title" style="margin:0 0 6px">AI 协作痕迹</p>
      <p class="tiny muted" style="margin:0">样本不足，暂不判断。</p>
    </div>`;
  }

  const level = ai.level || 'none';
  const sampled = Number(ai.sampled) || 0;
  const flagged = Number(ai.flagged ?? 0) || 0;
  const untraced = Number.isFinite(Number(ai.untraced)) ? Number(ai.untraced) : Math.max(0, sampled - flagged);
  const counts = { high: 0, likely: 0, weak: 0, none: 0, ...(ai.counts || {}) };

  const bar = AI_BUCKETS.filter(([k]) => (counts[k] || 0) > 0)
    .map(([k, , color]) => `<span style="flex:${counts[k]};background:${color}" title="${esc(AI_LEVEL_LABEL[k])} ${counts[k]} 次"></span>`)
    .join('');

  const legend = AI_BUCKETS.filter(([k]) => (counts[k] || 0) > 0)
    .map(
      ([k, label, color]) =>
        `<span class="ai-leg"><i style="background:${color}"></i>${esc(label)} <b>${counts[k]}</b></span>`,
    )
    .join('');

  const signals = (ai.signals || []).length
    ? ai.signals
        .map(
          (s) => `<div class="ai-sig">
            <span class="ai-sig-w">+${s.weight}</span>
            <span class="ai-sig-l">${esc(s.label)}</span>
            <span class="tiny muted">命中 ${s.hits} 次</span>
          </div>`,
        )
        .join('')
    : '<p class="tiny muted" style="margin:6px 0 0">没有任何信号命中。</p>';

  const tools = (ai.agentFiles || []).length
    ? ai.agentFiles
        .map((a) => `<span class="badge" title="${esc(a.files.join('\n'))}">${esc(a.tool)}</span>`)
        .join(' ')
    : '';

  const evid = tools
    ? `<div class="note" style="margin-top:12px">
         <div>本仓库检出 <b>AI 工具痕迹文件</b>：${tools}</div>
         <div class="tiny muted" style="margin-top:4px">
           说明这个项目上确实有 AI 代理在工作过。<span class="mono">.gitignore</span> 里未跟踪的痕迹文件不会被计入。
         </div>
       </div>`
    : '';

  const under = ai.likelyUnderestimated
    ? `<div class="note note-warn" style="margin-top:10px">
         有 <b>${untraced}</b> 个提交没留下任何可检出的痕迹，实际 AI 参与度<b>很可能高于</b>上面的估算。
         「未检出」只是说提交信息里没有线索，不等于没有 AI 参与。
       </div>`
    : '';

  return `<div class="card" style="margin-top:12px">
    <div class="spread" style="margin-bottom:4px">
      <p class="section-title" style="margin:0">AI 协作痕迹</p>
      <span class="badge b-blue-soft">推断 · 非事实判定</span>
    </div>

    <div class="row" style="gap:14px;align-items:baseline;margin-top:6px">
      <span style="font-size:26px;font-weight:600;letter-spacing:-.02em">${pct(Number(ai.ratio) || 0)}</span>
      <span class="tiny muted">明确留下痕迹的提交占比（疑似及以上）</span>
      <span style="flex:1"></span>
      <span class="badge ${level === 'high' ? 'b-blue' : 'b-dim'}">整体：${esc(AI_LEVEL_LABEL[level] || level)}</span>
    </div>

    <p class="tiny muted" style="margin:6px 0 12px">
      样本：最近 <b>${sampled}</b> 次提交 · 有痕迹 <b>${flagged}</b> 次
    </p>

    <div class="ai-bar">${bar}</div>
    <div class="ai-legs">${legend}</div>

    <p class="tiny" style="margin:12px 0 4px;color:var(--t3)">判定依据（按命中次数排序）</p>
    <div class="ai-sigs">${signals}</div>

    ${evid}
    ${under}

    <p class="tiny muted" style="margin:12px 0 0;line-height:1.6">
      ${esc(ai.disclaimer || DEFAULT_AI_DISCLAIMER)}
      <br>检测只读 git 元数据（提交信息、作者、时间、改动行数）与<span class="mono">文件路径名</span>，
      <b>不读取文件内容、不联网、不上传任何数据</b>。
    </p>
    <p class="tiny muted" style="margin:6px 0 0">${esc(AI_LEVEL_NOTE[level] || '')}</p>
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
    metricCard('AI 协作痕迹', o.ai.sampled ? `${o.ai.flagged ?? 0}/${o.ai.sampled}` : '—', '有痕迹的提交'),
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
        ${aiBadge(c)}
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
    ${renderAiPanel(o.ai)}
    ${renderPublishCard(o)}
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

/* ---------------- 提交与推送 ---------------- */

/**
 * 「提交并推送」入口卡片。
 * 之前的提交入口埋在「GitHub → 某仓库 → 内置文件树 → 某文件」里，用户根本找不到。
 * 这张卡片直接把入口摆在概览页上，就是为了解决「找不到哪里可以提交文件」。
 * 真正的状态以 publish-status 接口为准，这里只用概览里已有的数据做提示。
 */
export function renderPublishCard(o = {}) {
  const dirty = Number(o?.status?.dirtyCount) || 0;
  const branch = o?.head || o?.branch || '';
  return `<div class="section">
    <p class="section-title">提交与推送</p>
    <div class="card publish-card">
      <div class="publish-main">
        <div class="publish-title">把本地改动提交并推送到 GitHub</div>
        <div class="tiny muted">
          ${dirty ? `当前有 <b>${dirty}</b> 项未提交改动，可以在同一步里一并提交。` : '工作区是干净的，可以直接推送已有提交。'}
          ${branch ? `当前分支 <span class="mono">${esc(branch)}</span>。` : ''}
        </div>
      </div>
      <button class="btn btn-primary" data-action="publish-wizard">提交并推送…</button>
    </div>
    <p class="tiny muted" style="margin-top:8px">
      只想改 GitHub 上的单个文件？在 <b>GitHub → 我的仓库 → 点进仓库</b> 后，每个文件行右侧有「编辑」，
      右上角还有「上传本地文件」与「新建文件」。
    </p>
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
        ${aiBadge(c)}
      </div>`,
    )
    .join('');
  return `<div class="section">
    <p class="section-title">最近 ${cm.length} 次提交</p>
    <div class="card" style="padding:6px 16px">${rows || '<p class="muted tiny">暂无提交</p>'}</div>
    <p class="tiny muted" style="margin-top:10px">
      徽章含义：<span class="badge b-blue">AI</span> 高置信（有 AI 署名／生成标记等显式证据）·
      <span class="badge b-blue-soft">AI?</span> 疑似（提交形态与节奏符合 AI 习惯，但无显式证据）·
      <span class="badge b-dim">AI?</span> 弱痕迹。
      全部为本地启发式推断，<b>未标记不等于没有 AI 参与</b>；依据可在「概览」页的 AI 协作痕迹卡片中查看。
    </p>
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

/* ============================================================
   GitHub
   ============================================================ */

export function humanSize(kb) {
  const n = Number(kb) || 0;
  if (n < 1024) return `${n} KB`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024).toFixed(2)} GB`;
}

/** 网络自检横幅：只在异常时出现，避免正常时也占屏 */
export function netBanner(net) {
  if (!net || net.verdict === 'ok') return '';
  const tone = net.verdict === 'offline' ? 'err' : 'warn';
  const rows = (net.targets || [])
    .map(
      (t) => `<div class="net-row">
        <span class="net-dot ${t.reachable ? 'on' : 'off'}"></span>
        <span class="mono tiny" style="flex:1">${esc(t.host)}</span>
        <span class="tiny muted">${t.reachable ? `可用 ${t.https.ms}ms` : `不可用（${esc(t.https.reason || '?')}）`}</span>
      </div>`,
    )
    .join('');
  return `<div class="note note-${tone}" style="margin-bottom:16px">
    <div style="font-weight:500">${esc(net.summary)}</div>
    <div style="margin-top:8px">${rows}</div>
    <div class="tiny muted" style="margin-top:8px">
      GitHub 的 API 域名与 git 传输域名是分开的，部分网络（企业代理、CI 沙箱）只放行前者。
      ${net.suspicious?.length ? `检测到 ${net.suspicious.map(esc).join('、')} 出现「TCP 通但 HTTPS 不通」，这是透明代理拦截的典型特征。` : ''}
    </div>
  </div>`;
}

export function renderGithub({ auth, net, repos, error, filter = {}, logs = [] } = {}) {
  if (error) {
    return `<div class="section">${netBanner(net)}<div class="note note-err">${esc(error)}</div></div>`;
  }

  /* ---------- 未连接：授权引导 ---------- */
  if (!auth?.connected) {
    const vault = auth?.vault || {};
    const stale = auth?.stale ? `<div class="note note-err" style="margin-bottom:14px">保存的凭据已失效：${esc(auth.error || '')}</div>` : '';
    return `<div class="section">
      ${netBanner(net)}
      ${stale}
      <div class="gh-hero">
        <div class="gh-mark">⌂</div>
        <h2 style="margin:0 0 6px">连接 GitHub</h2>
        <p class="muted" style="margin:0 0 18px;max-width:600px">
          使用 <b>OAuth 设备码授权</b>（GitHub 官方为桌面／命令行应用设计的流程）。
          它<b>不需要 client_secret</b>，因此本地应用可以安全使用——这正是它和普通网页 OAuth 的关键区别。
        </p>

        <div class="gh-steps">
          <div class="gh-step">
            <span class="gh-step-n">1</span>
            <div>
              <div>注册一个 OAuth App</div>
              <div class="tiny muted">打开
                <a class="link" href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">GitHub → Settings → Developer settings → New OAuth App</a>
              </div>
              <div class="tiny muted" style="margin-top:4px">
                Application name 随意；Homepage URL 与 <b>Authorization callback URL 都填</b>
                <span class="mono">http://127.0.0.1:4599</span>。
              </div>
              <div class="note" style="margin-top:6px;padding:7px 9px">
                回调地址<b>必填</b>，留空会报 “Callback URL can't be blank”。
                但设备码流程<b>根本不会用到它</b>，照上面填本地地址即可 —— GitHub 明确允许
                <span class="mono">http://127.0.0.1</span> 这类环回地址。
              </div>
            </div>
          </div>
          <div class="gh-step">
            <span class="gh-step-n">2</span>
            <div>
              <div>在该 OAuth App 设置里勾选 <b>Enable Device Flow</b></div>
              <div class="tiny muted">最容易漏的一步。不勾选，授权会直接失败。</div>
            </div>
          </div>
          <div class="gh-step">
            <span class="gh-step-n">3</span>
            <div>
              <div>复制 <b>Client ID</b> 填到下面</div>
              <div class="tiny muted">Client ID 是公开值，<b>不是密钥</b>；旁边的 Client Secret 用不到，不要填进来。</div>
            </div>
          </div>
        </div>

        <div class="row" style="gap:8px;margin:18px 0 10px">
          <input class="input mono" id="gh-client-id" placeholder="粘贴 Client ID，例如 Iv1a2b3c4d5e6f7g8" autocomplete="off" spellcheck="false" style="flex:1">
          <button class="btn" data-action="gh-save-client-id" style="flex:0 0 auto">保存</button>
        </div>

        <div class="row" style="gap:10px;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap">
          <div class="seg" id="gh-scope">
            <button class="seg-item" data-action="gh-scope" data-scope="readonly">只读授权</button>
            <button class="seg-item active" data-action="gh-scope" data-scope="write">读写授权</button>
          </div>
          <div class="tiny muted" id="gh-scope-hint" style="padding-top:6px;flex:1;min-width:180px">
            读写需要 <span class="mono">repo</span> 权限（可读写你所有私有仓库），提交功能必需。
          </div>
        </div>

        <button class="btn btn-primary btn-lg" data-action="gh-authorize">开始授权</button>

        <p class="tiny" style="margin:16px 0 0">
          <button class="link" data-action="gh-toggle-pat">改用细粒度 PAT（权限可精确到单个仓库）</button>
        </p>
        <div id="gh-pat-box" class="hidden" style="margin-top:10px">
          <div class="note" style="margin:0">
            <div class="tiny">
              OAuth 的 <span class="mono">repo</span> 权限是「全有或全无」——能读写你<b>所有</b>私有仓库。
              如果只想授权给某几个仓库，<b>fine-grained PAT 反而更安全</b>：
              可在 GitHub 上把权限精确限制到「指定仓库 + Contents 读写」。
            </div>
            <div class="row" style="gap:8px;margin-top:10px">
              <input class="input mono" id="gh-pat" type="password" placeholder="github_pat_… 或 ghp_…" autocomplete="off">
              <button class="btn" data-action="gh-save-pat" style="flex:0 0 auto">验证并保存</button>
            </div>
            <div class="tiny muted" style="margin-top:6px">
              获取入口：<a class="link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Fine-grained tokens</a>
            </div>
          </div>
        </div>

        <div class="safe-note" style="margin-top:18px">
          <span class="safe-dot"></span>
          凭据安全等级：<b>${vault.mode === 'dpapi' ? 'DPAPI 加密（绑定当前 Windows 账户）' : '本地文件（0600 权限）'}</b>
          ${vault.mode === 'dpapi' ? '——即使文件被拷走或进了网盘同步，换台机器也解不开。' : '——当前环境不支持 DPAPI，已降级为权限保护。'}
          <br>token 明文永不返回前端，也不写入任何日志。
        </div>
      </div>
    </div>`;
  }

  /* ---------- 已连接：仓库列表 ---------- */
  const v = auth.viewer || {};
  const scopes = (v.scopes || []).join(', ') || '（未返回 scope 头）';
  const canWrite = (v.scopes || []).some((s) => s === 'repo' || s === 'public_repo') || auth.method === 'pat';

  /**
   * 头像有两个坑：
   *   1. 页面 CSP 是 `img-src 'self' data:`，外域头像会被直接拦掉；
   *   2. 就算放开 CSP，浏览器直连 avatars.githubusercontent.com 在国内也常年失败。
   * 所以优先用服务端随状态一起返回的 **data: URL**（不需要额外请求，与令牌/网络全无关），
   * 退而求其次才是同源代理，最后才直连原地址。
   * 注意 CSP 是 `script-src 'self'`，内联 onerror 会被拦，错误处理在 main.js 里挂。
   */
  const avatarSrc = v.avatarDataUrl || v.proxyAvatar || v.avatar;
  const avatar = avatarSrc
    ? `<span class="gh-avatar-slot"><img class="gh-avatar" src="${esc(avatarSrc)}" alt="" referrerpolicy="no-referrer"><span class="gh-avatar gh-avatar-fallback" hidden>◍</span></span>`
    : '<span class="gh-avatar-slot"><span class="gh-avatar gh-avatar-fallback">◍</span></span>';

  const list = repos?.length
    ? repos
        .map(
          (r) => `<button class="gh-repo" data-action="gh-open-repo" data-owner="${esc(r.owner)}" data-name="${esc(r.name)}">
            <span class="gh-repo-top">
              <span class="gh-repo-name">${esc(r.name)}</span>
              ${r.private ? '<span class="badge b-orange">私有</span>' : '<span class="badge b-gray">公开</span>'}
              ${r.archived ? '<span class="badge b-gray">已归档</span>' : ''}
              ${r.fork ? '<span class="badge b-plain">fork</span>' : ''}
            </span>
            <span class="gh-repo-desc">${esc(r.description || '（无描述）')}</span>
            <span class="gh-repo-meta">
              ${r.language ? `<span>● ${esc(r.language)}</span>` : ''}
              <span>★ ${r.stars}</span>
              <span>⑂ ${r.forks}</span>
              <span>${humanSize(r.sizeKb)}</span>
              <span>${esc(relTime(r.pushedAt))}</span>
            </span>
          </button>`,
        )
        .join('')
    : `<p class="muted tiny" style="padding:20px;text-align:center">
        ${filter.q ? `没有匹配「${esc(filter.q)}」的仓库` : '没有读取到仓库（可能授权范围不含任何仓库）'}
      </p>`;

  return `<div class="section">
    ${netBanner(net)}
    <div class="gh-idbar card">
      ${avatar}
      <div style="min-width:0;flex:1">
        <div style="font-weight:500">${esc(v.name || v.login || '')}</div>
        <div class="tiny muted">
          <span class="mono">@${esc(v.login || '')}</span> ·
          ${auth.method === 'pat' ? '细粒度 PAT' : auth.method === 'env' ? '环境变量 token' : 'OAuth 设备码'} ·
          <span class="mono">${esc(scopes)}</span>
        </div>
      </div>
      <div class="row" style="gap:6px;flex:0 0 auto">
        ${canWrite ? '<span class="badge b-green">可提交</span>' : '<span class="badge b-orange">只读</span>'}
        <button class="btn btn-sm" data-action="gh-clone-wizard">克隆仓库…</button>
        <button class="btn btn-sm" data-action="gh-logout">退出</button>
      </div>
    </div>

    <div class="spread" style="margin-bottom:10px">
      <p class="section-title" style="margin:0">我的仓库 · ${repos?.length || 0}</p>
      <div class="row" style="gap:8px">
        <input class="input" id="gh-q" placeholder="搜索仓库…" style="width:170px" value="${esc(filter.q || '')}" autocomplete="off">
        <div class="seg" id="gh-vis">
          <button class="seg-item${(filter.visibility || 'all') === 'all' ? ' active' : ''}" data-action="gh-vis" data-vis="all">全部</button>
          <button class="seg-item${filter.visibility === 'public' ? ' active' : ''}" data-action="gh-vis" data-vis="public">公开</button>
          <button class="seg-item${filter.visibility === 'private' ? ' active' : ''}" data-action="gh-vis" data-vis="private">私有</button>
        </div>
        <button class="btn btn-sm" data-action="gh-refresh">刷新</button>
      </div>
    </div>

    <p class="tiny muted" style="margin:-2px 0 10px">
      要改文件或提交：<b>点进任意仓库</b> → 文件行右侧「编辑」，或右上角「上传本地文件… / 新建文件…」。
      要把<b>本地整个仓库</b>推上来：回左侧选一个本地仓库，用顶栏的「提交并推送」（或概览页的按钮）。
    </p>

    <div class="gh-repos">${list}</div>
  </div>

  ${renderGhLog(logs)}`;
}

/** 远端写操作的审计日志：本地仓库那套快照回滚管不着远端，所以要能查 */
function renderGhLog(logs) {
  if (!logs?.length) {
    return `<div class="section">
      <p class="section-title">远端写操作记录</p>
      <div class="card" style="padding:14px 16px">
        <p class="muted tiny" style="margin:0">还没有通过本系统向 GitHub 写入过任何东西。读取操作不会记在这里。</p>
      </div>
    </div>`;
  }
  const label = { 'gh-commit': '提交文件', 'gh-delete': '删除文件', 'gh-clone': '克隆到本地', 'gh-noop': '无变化（已拦截）', 'publish-push': '本地推送', 'gh-create-repo': '新建仓库' };
  const badge = { 'gh-commit': 'b-blue', 'gh-delete': 'b-red', 'gh-clone': 'b-gray', 'gh-noop': 'b-plain', 'publish-push': 'b-green', 'gh-create-repo': 'b-gray' };
  const rows = logs
    .map(
      (l) => `<tr>
        <td class="mono tiny muted" style="white-space:nowrap">${esc(fmtDay(l.ts))}</td>
        <td><span class="badge ${badge[l.op] || 'b-gray'}">${esc(label[l.op] || l.op)}</span></td>
        <td class="mono tiny">${esc(l.target || '')}${l.path ? `<span class="muted"> · </span>${esc(l.path)}` : ''}</td>
        <td class="tiny muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.message || '')}">${esc(l.message || '')}</td>
        <td class="mono tiny">${l.commitShort ? esc(l.commitShort) : l.to ? esc(l.to) : ''}</td>
      </tr>`,
    )
    .join('');
  return `<div class="section">
    <p class="section-title">远端写操作记录 · ${logs.length}</p>
    <div class="card" style="padding:14px 16px">
      <table class="table"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>说明</th><th>提交 / 路径</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <p class="tiny muted" style="margin-top:10px">
      远端提交与本地提交不同：它直接改 GitHub 上的仓库，<b>无法用本地快照回滚</b>。
      如需撤销，请在 GitHub 上对该提交执行 revert。
    </p>
  </div>`;
}

