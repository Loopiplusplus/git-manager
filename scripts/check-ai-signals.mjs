/**
 * AI 痕迹检测器测试。
 *
 * 这个指标曾被用户当场打脸：他自己仓库里 7 个提交全是 AI 写的，工具报 0%。
 * 原因是最早只扫「Generated with …」「Co-Authored-By: Claude」这类关键词，
 * 而绝大多数 AI 写作的提交根本不留署名。
 *
 * 所以本测试要守住两条线：
 *   ① 召回：显式证据必须被抓住，形态 + 过程证据累加后要能定性；
 *   ② 精确：不能看到 Conventional 前缀或长标题就喊 AI —— 那是人类的正常写法。
 * 以及一条不可动摇的诚实约束：
 *   ③ 仅靠形态证据**永远不给「高置信」**，只有显式证据才可以。
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const S = await import(pathToFileURL(path.join(ROOT, 'server/core/ai-signals.js')).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

/** 造一条提交记录 */
const rec = (o = {}) => ({
  hash: 'x'.repeat(40),
  short: 'abc1234',
  author: 'Dev',
  committer: 'Dev',
  at: '1700000000',
  subject: 'chore: 日常改动',
  body: '',
  added: 10,
  deleted: 1,
  ...o,
});

const ctxOf = (records) => S.buildContext(records);

console.log('[1] 显式证据：单条即可定性');
{
  const ctx = ctxOf([rec()]);
  const cases = [
    ['Co-Authored-By: Claude', rec({ body: 'Co-Authored-By: Claude <noreply@anthropic.com>' })],
    ['Co-Authored-By: Copilot', rec({ body: 'co-authored-by: GitHub Copilot <x@github.com>' })],
    ['Generated with Claude Code', rec({ body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' })],
    ['AI 生成标记', rec({ body: 'This file is AI-generated.' })],
    ['机器人作者 [bot]', rec({ author: 'dependabot[bot]' })],
    ['机器人提交者', rec({ committer: 'github-actions[bot]' })],
    ['作者名是 AI 工具', rec({ author: 'claude' })],
  ];
  for (const [label, r] of cases) {
    const a = S.analyzeCommit(r, ctx);
    check(`显式信号「${label}」→ 高置信`, a.level === 'high' && a.basis === 'explicit', `${a.level}/${a.basis}/${a.score}分`);
  }
}

console.log('\n[2] 形态 + 过程证据：累加后判为「疑似」（不能到高置信）');
{
  const body = [
    '修复分页错位：',
    '',
    '1) 记录偏移量改由服务端下发，前端不再自行推断页码，避免两边算法漂移；',
    '2) 修正了在数据量不足一页时越界读取的问题（这个只有在结果集恰好为空或恰好整页时才复现）；',
    '3) 补了一条边界用例，覆盖空结果集与恰好整页两种情况；',
    '4) 顺带把分页参数的解析抽成了独立函数，便于后续复用与单测。',
    '',
    '顺带做了这些：',
    '- 清理了两处已经没人调用的死代码',
    '- 统一了错误提示文案，之前同一种失败在三个地方有三种说法',
    '- 把散落在各个组件里的常量提到统一位置',
    '',
    '验证方式：本地跑通了分页相关的全部用例，并手工回归了列表页的翻页、搜索与筛选。',
    '需要注意的是，这次改动会影响到导出接口的调用方，已在对应位置补了注释说明。',
    '另外这里有个取舍：为了保证一致性，我们放弃了前端本地缓存页码的能力，',
    '代价是每次翻页多一次请求，但考虑到这个列表页的访问频率，这个代价是可以接受的。',
  ].join('\n');
  const records = [
    rec({ subject: 'fix(pager): 修复分页错位并补齐边界用例，顺带清理死代码', body, at: '1700000000', added: 400 }),
    rec({ subject: 'feat(api): 新增导出接口的相关改动与说明，供外部系统对接使用', body, at: '1700000300', added: 400 }),
    rec({ subject: 'chore: 杂项', body: '', at: '1700000600', added: 400 }),
  ];
  const ctx = ctxOf(records);
  const a = S.analyzeCommit(records[0], ctx);
  check('结构化长正文被识别', a.signals.some((s) => s.id === 'structured-body'));
  check('长正文被识别', a.signals.some((s) => s.id === 'long-body'));
  check('规范前缀被识别', a.signals.some((s) => s.id === 'conventional'));
  check('极短间隔被识别', a.signals.some((s) => s.id === 'burst'));
  check('★ 仅形态证据判为「疑似」而非「高置信」', a.level === 'likely' && a.basis === 'heuristic', `${a.level}/${a.basis}/${a.score}分`);
  check('★ 形态证据的 basis 标记为 heuristic', a.basis === 'heuristic');
}

console.log('\n[3] 精确性：人类的正常写法不能被误判');
{
  const ctx = ctxOf([rec(), rec(), rec()]);
  const human = [
    ['简短规范提交', rec({ subject: 'fix: 修正空指针' })],
    ['仅有 Conventional 前缀', rec({ subject: 'feat: 增加一个字段' })],
    ['仅有长标题', rec({ subject: 'fix: 修正了一个在特定条件下才会触发的空指针异常问题需要仔细看' })],
    ['空白提交信息', rec({ subject: '', body: '' })],
    ['普通中文一段话', rec({ subject: '改了点东西', body: '把之前的逻辑调整了一下。' })],
  ];
  for (const [label, r] of human) {
    const a = S.analyzeCommit(r, ctx);
    check(`人类写法「${label}」不判为 AI`, a.level === 'none' || a.level === 'weak', `${a.level} ${a.score}分 [${a.signals.map((s) => s.id).join('+')}]`);
  }
}

console.log('\n[4] 基线保护：样本太少时不做过程证据推断');
{
  const one = [rec({ at: '1700000000', added: 100000 })];
  const ctx = ctxOf(one);
  check('样本 <3 时基线标记为不可靠', ctx.reliable === false);
  const a = S.analyzeCommit(one[0], ctx);
  check('样本不足时不报 burst', !a.signals.some((s) => s.id === 'burst'));
  check('样本不足时不报 huge-diff', !a.signals.some((s) => s.id === 'huge-diff'));
}

console.log('\n[5] 改动量信号：需要真的远超常态');
{
  const records = [rec({ added: 20 }), rec({ added: 30 }), rec({ added: 25 }), rec({ added: 5000, subject: 'chore: 大改动' })];
  const ctx = ctxOf(records);
  const big = S.analyzeCommit(records[3], ctx);
  const small = S.analyzeCommit(records[0], ctx);
  check('超大改动被识别', big.signals.some((s) => s.id === 'huge-diff'));
  check('普通改动不被误判', !small.signals.some((s) => s.id === 'huge-diff'));
}

console.log('\n[6] AI 工具痕迹文件识别（只看文件名）');
{
  const hits = S.detectAgentFiles([
    'CLAUDE.md',
    'src/index.js',
    '.cursor/rules/style.mdc',
    '.github/copilot-instructions.md',
    '.workbuddy/memory/2026-10-10.md',
    '.aider.conf.yml',
    'README.md',
  ]);
  const tools = hits.map((h) => h.tool);
  check('识别出 Claude Code', tools.includes('Claude Code'));
  check('识别出 Cursor', tools.includes('Cursor'));
  check('识别出 GitHub Copilot', tools.includes('GitHub Copilot'));
  check('识别出 WorkBuddy', tools.includes('WorkBuddy'));
  check('识别出 Aider', tools.includes('Aider'));
  check('不把普通文件当痕迹', hits.every((h) => !h.files.some((f) => f === 'src/index.js' || f === 'README.md')));
  check('没有痕迹文件时返回空', S.detectAgentFiles(['src/a.js', 'package.json']).length === 0);
}

console.log('\n[7] 汇总结构与诚实性字段');
{
  const records = [
    rec({ body: 'Co-Authored-By: Claude <noreply@anthropic.com>' }),
    rec({ subject: 'fix: 改一下' }),
    rec({ subject: 'chore: 再说' }),
  ];
  const ctx = ctxOf(records);
  const sum = S.summarize(records.map((r) => S.analyzeCommit(r, ctx)), [{ tool: 'WorkBuddy', files: ['.workbuddy/'] }]);
  check('计数正确', sum.counts.high === 1 && sum.counts.none === 2, JSON.stringify(sum.counts));
  check('主指标只统计疑似及以上', sum.flagged === 1 && sum.ratio === Number((1 / 3).toFixed(4)), `${sum.flagged}/${sum.ratio}`);
  check('标记 hasExplicit', sum.hasExplicit === true);
  check('汇总等级为 high', sum.level === 'high');
  check('信号命中数被聚合', sum.signals.some((s) => s.id === 'coauthor' && s.hits === 1));
  check('带 isEstimate 标记', sum.isEstimate === true);
  check('带免责声明', typeof sum.disclaimer === 'string' && sum.disclaimer.includes('不代表没有 AI 参与'));
  check('★ 检出工具痕迹却几乎没检出提交痕迹时提示可能被低估', sum.likelyUnderestimated === true);
  check('空样本返回完整结构', S.emptySummary().sampled === 0 && Array.isArray(S.emptySummary().signals));
}

console.log('\n[8] git log 解析：RS 放行首，shortstat 不能污染正文');
{
  const US = S.US;
  const RS = S.RS;
  const raw =
    `${RS}aaa111${US}aaa${US}Alice${US}Alice${US}1700000000${US}fix: 修好${US}正文第一行\n正文第二行\n\n 3 files changed, 120 insertions(+), 4 deletions(-)\n` +
    `${RS}bbb222${US}bbb${US}Bob${US}Bob${US}1700000900${US}chore: 杂项${US}\n\n 1 file changed, 2 insertions(+)\n`;
  const out = S.parseLogWithShortstat(raw);
  check('解析出 2 条', out.length === 2, String(out.length));
  check('正文没有被 shortstat 污染', out[0].body === '正文第一行\n正文第二行', JSON.stringify(out[0].body));
  check('新增行数解析正确', out[0].added === 120, String(out[0].added));
  check('删除行数解析正确', out[0].deleted === 4, String(out[0].deleted));
  check('作者解析正确', out[0].author === 'Alice' && out[1].author === 'Bob');
  check('单行 shortstat 也能解析', out[1].added === 2 && out[1].deleted === 0, JSON.stringify(out[1]));
}

console.log('\n[9] 真实仓库端到端（用本仓库自身当样本）');
{
  const git = (args) =>
    new Promise((res) =>
      execFile('git', args, { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8' }, (e, o) => res(o || '')),
    );

  const raw = await git(['log', '-n', '300', `--format=${S.LOG_FORMAT}`, '--shortstat']);
  const files = (await git(['ls-files'])).split('\n').filter(Boolean);
  const records = S.parseLogWithShortstat(raw);
  const ctx = S.buildContext(records);
  const analyzed = records.map((r) => S.analyzeCommit(r, ctx));
  const sum = S.summarize(analyzed, S.detectAgentFiles(files));

  console.log(`     样本 ${sum.sampled} 条 · 判定 ${sum.flagged} 条 · 占比 ${(sum.ratio * 100).toFixed(1)}%`);
  for (const s of sum.signals) console.log(`       · ${s.label}（${s.hits} 次，权重 ${s.weight}）`);

  check('解析到本仓库的提交', records.length >= 5, String(records.length));
  check('★ 不再把「全是 AI 写的仓库」报成 0%', sum.flagged > 0, `flagged=${sum.flagged}`);
  // 本仓库已把 .workbuddy/ 移出跟踪（它记录的是本机路径，只对本机有效、不进仓库），
  // 所以这里不能再断言「检出 .workbuddy」。改成正向有用的那条：**仓库卫生守卫** ——
  // 一旦有人把 .workbuddy / CLAUDE.md / .cursorrules 这类本机专属文件又提交进来，这里会红。
  check(
    '仓库里没有混入本机专属的 AI 痕迹文件（.workbuddy / CLAUDE.md / .cursorrules 等）',
    sum.agentFiles.length === 0,
    JSON.stringify(sum.agentFiles),
  );
  check('工具痕迹检测本身有效（用合成输入验）', S.detectAgentFiles(['.workbuddy/memory/x.md', 'CLAUDE.md', 'src/a.js']).length === 2);
  check('信号明细非空（能解释是靠什么判的）', sum.signals.length > 0);
  check('每条判定都带可读依据', analyzed.some((a) => a.signals.every((s) => s.detail && s.detail.length > 0)));
  check('未被显式证据污染的样本不会冒充高置信', analyzed.every((a) => a.level !== 'high' || a.basis === 'explicit'));
  check('空正文的提交不会误报高置信', records.filter((r) => !r.body).every((r) => S.analyzeCommit(r, ctx).level !== 'high'));
}

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');
process.exit(fail === 0 ? 0 : 1);
