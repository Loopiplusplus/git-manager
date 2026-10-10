import path from 'node:path';
import { git, gitOk } from './git.js';
import { daysSince, humanSize, lines, looksLikeAI, clamp } from './util.js';

const SEP = '|~|';
const US = '\x1f';
const RS = '\x1e';

/** 解析 git status --porcelain=v2 --branch */
export function parseStatus(raw) {
  const out = { head: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, entries: [] };
  for (const line of lines(raw)) {
    if (line.startsWith('# branch.head ')) out.head = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(' ')[1] || '..';
      if (xy[0] !== '.') out.staged += 1;
      if (xy[1] !== '.') out.unstaged += 1;
      out.entries.push({ kind: line[0] === '2' ? 'rename' : 'change', xy, path: line.split(' ').slice(8).join(' ') });
    } else if (line.startsWith('u ')) {
      out.conflicts += 1;
      out.entries.push({ kind: 'conflict', xy: 'UU', path: line.split(' ').slice(10).join(' ') });
    } else if (line.startsWith('? ')) {
      out.untracked += 1;
    }
  }
  if (out.conflicts > 0) out.unstaged += out.conflicts;
  out.dirtyCount = out.staged + out.unstaged + out.untracked;
  return out;
}

export async function status(repoPath) {
  const r = await gitOk(repoPath, ['status', '--porcelain=v2', '--branch']);
  return parseStatus(r.ok ? r.out : '');
}

async function refList(repoPath, prefix, limit = 300) {
  const fmt = `%(refname:short)${SEP}%(upstream:short)${SEP}%(committerdate:iso-strict)${SEP}%(objectname:short)${SEP}%(HEAD)${SEP}%(subject)`;
  const r = await gitOk(repoPath, ['for-each-ref', `--format=${fmt}`, `--count=${limit}`, prefix]);
  if (!r.ok) return [];
  return lines(r.out).map((l) => {
    const [name, upstream, date, sha, head, subject] = l.split(SEP);
    return { name, upstream: upstream || '', date: date || null, sha, current: head === '*', subject: subject || '' };
  });
}

async function worktreeMap(repoPath) {
  const r = await gitOk(repoPath, ['worktree', 'list', '--porcelain']);
  const map = new Map();
  if (!r.ok) return map;
  for (const block of r.out.split('\n\n')) {
    const wt = block.match(/^worktree (.+)$/m);
    const br = block.match(/^branch refs\/heads\/(.+)$/m);
    if (wt && br) map.set(br[1].trim(), wt[1].trim());
  }
  return map;
}

/** 仓库总览 */
export async function overview(repo) {
  const p = repo.path;
  const st = await status(p);

  const totalRaw = await gitOk(p, ['rev-list', '--count', 'HEAD']);
  const totalCommits = totalRaw.ok ? Number(totalRaw.out.trim()) || 0 : 0;

  const local = await refList(p, 'refs/heads');
  const remote = await refList(p, 'refs/remotes', 200);
  const tags = await refList(p, 'refs/tags', 200);

  const firstRaw = await gitOk(p, ['log', '--max-parents=0', '--format=%cI', '-n', '1']);
  const lastRaw = await gitOk(p, ['log', '-n', '1', '--format=%cI']);
  const firstCommit = firstRaw.ok ? lines(firstRaw.out).pop() || null : null;
  const lastCommit = lastRaw.ok ? lines(lastRaw.out)[0] || null : null;

  const sizeRaw = await gitOk(p, ['count-objects', '-v']);
  let sizeKib = 0;
  let objects = 0;
  if (sizeRaw.ok) {
    const loose = sizeRaw.out.match(/size:\s*(\d+)/);
    const pack = sizeRaw.out.match(/size-pack:\s*(\d+)/);
    const c = sizeRaw.out.match(/count:\s*(\d+)/);
    const inPack = sizeRaw.out.match(/in-pack:\s*(\d+)/);
    sizeKib = (loose ? Number(loose[1]) : 0) + (pack ? Number(pack[1]) : 0);
    objects = (c ? Number(c[1]) : 0) + (inPack ? Number(inPack[1]) : 0);
  }

  const stashRaw = await gitOk(p, ['stash', 'list']);
  const stashCount = stashRaw.ok ? lines(stashRaw.out).length : 0;

  const contribRaw = await gitOk(p, ['shortlog', '-sne', 'HEAD']);
  const contributors = contribRaw.ok
    ? lines(contribRaw.out)
        .map((l) => {
          const m = l.match(/^\s*(\d+)\s+(.*?)\s*<(.+)>$/);
          return m ? { count: Number(m[1]), name: m[2].trim(), email: m[3].trim() } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
    : [];

  const ai = await aiStats(p);

  return {
    id: repo.id,
    name: repo.name,
    path: p,
    isWorktree: !!repo.isWorktree,
    head: st.head || repo.head,
    sha: local.find((b) => b.current)?.sha || null,
    totalCommits,
    localBranches: local.length,
    remoteBranches: remote.length,
    tags: tags.length,
    firstCommit,
    lastCommit,
    ageDays: daysSince(firstCommit),
    lastCommitDays: daysSince(lastCommit),
    size: humanSize(sizeKib),
    sizeKib,
    objects,
    stashCount,
    status: st,
    contributors,
    ai,
    generatedAt: new Date().toISOString(),
  };
}

/** AI 参与度（启发式，UI 需标注“估算”） */
async function aiStats(repoPath, sample = 300) {
  const r = await gitOk(repoPath, ['log', `-n`, String(sample), `--format=%H${US}%an${US}%s${US}%b${RS}`], { timeout: 30000 });
  if (!r.ok) return { sampled: 0, aiCommits: 0, ratio: 0, isEstimate: true };
  const records = r.out.split(RS).map((s) => s.replace(/^\n/, '')).filter((s) => s.trim());
  let aiCommits = 0;
  for (const rec of records) {
    const [hash, author, subject, body] = rec.split(US);
    if (!hash) continue;
    if (looksLikeAI({ subject: subject || '', body: body || '', author: author || '' })) aiCommits += 1;
  }
  const sampled = records.length;
  return {
    sampled,
    aiCommits,
    ratio: sampled ? Number((aiCommits / sampled).toFixed(4)) : 0,
    isEstimate: true,
  };
}

/** 分支列表（含风险信息） */
export async function branches(repo) {
  const p = repo.path;
  const [local, remoteRefs, st, wts] = await Promise.all([
    refList(p, 'refs/heads'),
    refList(p, 'refs/remotes', 200),
    status(p),
    worktreeMap(p),
  ]);

  const mergedRaw = await gitOk(p, ['branch', '--format=%(refname:short)', '--merged']);
  const mergedSet = new Set(mergedRaw.ok ? lines(mergedRaw.out) : []);

  const withAb = [];
  let budget = 30;
  for (const b of local) {
    let ahead = null;
    let behind = null;
    if (b.upstream && budget > 0) {
      budget -= 1;
      const ab = await gitOk(p, ['rev-list', '--left-right', '--count', `${b.upstream}...${b.name}`]);
      if (ab.ok) {
        const [a, c] = ab.out.trim().split(/\s+/).map(Number);
        behind = a;
        ahead = c;
      }
    }
    const staleDays = daysSince(b.date);
    const lockedBy = wts.get(b.name);
    withAb.push({
      name: b.name,
      sha: b.sha,
      date: b.date,
      subject: b.subject,
      upstream: b.upstream,
      ahead,
      behind,
      isCurrent: b.current,
      isMerged: mergedSet.has(b.name),
      staleDays,
      isStale: staleDays != null && staleDays >= 90,
      lockedBy: lockedBy && path.resolve(lockedBy) !== path.resolve(p) ? lockedBy : null,
      dirty: b.current ? st.dirtyCount : 0,
    });
  }

  // 只保留需要清理的远端分支引用（origin/HEAD 之类过滤掉）
  const remotes = remoteRefs
    .filter((r) => !/\/HEAD$/.test(r.name))
    .map((r) => ({ name: r.name, date: r.date, sha: r.sha, staleDays: daysSince(r.date) }));

  return {
    current: st.head || repo.head,
    dirtyCount: st.dirtyCount,
    local: withAb.sort((a, b) => (b.isCurrent - a.isCurrent) || String(b.date).localeCompare(String(a.date))),
    remotes,
  };
}

/** 最近提交 */
export async function commits(repo, limit = 40) {
  const n = clamp(Number(limit) || 40, 1, 300);
  const fmt = `%H${US}%h${US}%an${US}%aI${US}%s${US}%D${US}%b${RS}`;
  const r = await gitOk(repo.path, ['log', '-n', String(n), `--format=${fmt}`]);
  if (!r.ok) return [];
  return r.out
    .split(RS)
    .map((s) => s.replace(/^\n/, ''))
    .filter((s) => s.trim())
    .map((rec) => {
      const [hash, short, author, date, subject, refs, body] = rec.split(US);
      return {
        hash,
        short,
        author,
        date,
        subject: subject || '',
        refs: refs ? refs.split(',').map((x) => x.trim()).filter(Boolean) : [],
        isAI: looksLikeAI({ subject: subject || '', body: body || '', author: author || '' }),
      };
    });
}

/** 提交活动热力图（近 N 周） */
export async function activity(repo, weeks = 12) {
  const w = clamp(Number(weeks) || 12, 4, 52);
  const r = await gitOk(repo.path, ['log', `--since=${w} weeks ago`, '--date=format:%Y-%m-%d', '--format=%ad']);
  const counts = new Map();
  if (r.ok) {
    for (const d of lines(r.out)) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 让最后一列正好是本周（周日→周六），总天数严格等于 weeks*7
  const end = new Date(today.getTime() + (6 - today.getDay()) * 86400000);
  const start = new Date(end.getTime() - (w * 7 - 1) * 86400000);
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: key, count: counts.get(key) || 0, future: d.getTime() > today.getTime() });
  }
  const max = days.reduce((a, b) => Math.max(a, b.count), 0);
  return { weeks: w, days, max, total: days.reduce((a, b) => a + b.count, 0) };
}

/** 健康度评分 + 问题清单 */
export async function health(repo) {
  const [ov, br] = await Promise.all([overview(repo), branches(repo)]);
  const p = repo.path;
  const issues = [];
  let score = 100;

  const stale = br.local.filter((b) => b.isStale && !b.isCurrent);
  if (stale.length) {
    score -= Math.min(stale.length, 5) * 8;
    issues.push({
      level: stale.length >= 3 ? 'high' : 'mid',
      title: `${stale.length} 个分支超过 90 天未动`,
      detail: stale.slice(0, 5).map((b) => b.name).join('、'),
      action: 'branch',
    });
  }

  const unmerged = br.local.filter((b) => !b.isMerged && !b.isCurrent);
  if (unmerged.length) {
    score -= Math.min(unmerged.length, 4) * 5;
    issues.push({
      level: unmerged.length >= 4 ? 'high' : 'mid',
      title: `${unmerged.length} 个分支尚未合并`,
      detail: unmerged.slice(0, 5).map((b) => b.name).join('、'),
      action: 'branch',
    });
  }

  if (ov.stashCount > 5) {
    score -= 5;
    issues.push({ level: 'mid', title: `stash 堆积 ${ov.stashCount} 条`, detail: '临时改动长期未处理', action: 'branch' });
  }

  if (ov.status.dirtyCount > 0) {
    score -= 6;
    issues.push({
      level: 'mid',
      title: `工作区有 ${ov.status.dirtyCount} 处未提交改动`,
      detail: `${ov.status.staged} 已暂存 · ${ov.status.unstaged} 未暂存 · ${ov.status.untracked} 未跟踪`,
      action: 'branches',
    });
  }

  const cm = await commits(repo, 200);
  const wip = cm.filter((c) => /^(wip|tmp|temp|fixup!|squash!|asdf|debug|test\b)/i.test(c.subject.trim()));
  const wipRatio = cm.length ? wip.length / cm.length : 0;
  if (wipRatio > 0.15) {
    score -= 6;
    issues.push({
      level: 'mid',
      title: `半成品提交占比 ${(wipRatio * 100).toFixed(0)}%`,
      detail: `近 ${cm.length} 次提交中有 ${wip.length} 条疑似 WIP`,
      action: 'commits',
    });
  }

  if (ov.status.conflicts > 0) {
    score -= 10;
    issues.push({ level: 'high', title: `存在 ${ov.status.conflicts} 处未解决冲突`, detail: '先解决冲突再继续', action: 'branches' });
  }

  score = clamp(Math.round(score), 0, 100);
  const grade = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'watch' : 'cleanup';

  return {
    score,
    grade,
    issues,
    metrics: {
      branches: ov.localBranches,
      staleBranches: stale.length,
      unmergedBranches: unmerged.length,
      stashCount: ov.stashCount,
      dirtyCount: ov.status.dirtyCount,
      wipRatio: Number(wipRatio.toFixed(4)),
      aiRatio: ov.ai.ratio,
      totalCommits: ov.totalCommits,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function headSha(repoPath) {
  const r = await gitOk(repoPath, ['rev-parse', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}
