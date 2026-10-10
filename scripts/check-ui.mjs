/**
 * 前端渲染冒烟测试。
 *
 * 截图在这个沙箱里不可用，但视图层是纯函数 —— 可以用真实数据直接调用，
 * 检查产出的 HTML 结构是否正确、有没有 undefined / NaN 泄漏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.GM_PORT || 4599;

// palette.js 会连带加载 api.js，而 api.js 在模块顶层读取 window.__GM__。
// 这里只需要一个最小桩，让模块能加载；本测试不会真的发出请求。
globalThis.window = globalThis.window || { __GM__: { token: '', apiBase: '/api' } };

// 视图模块只在函数被调用时才碰 document，因此这里不需要 DOM 桩
const views = await import(pathToFileURL(path.join(ROOT, 'web/js/views.js')).href);
const palette = await import(pathToFileURL(path.join(ROOT, 'web/js/palette.js')).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

/** 检查 HTML 里有没有不该出现的脏值 */
function dirty(html, label) {
  const bad = [];
  if (/\bundefined\b/.test(html)) bad.push('undefined');
  if (/\bNaN\b/.test(html)) bad.push('NaN');
  if (/\[object Object\]/.test(html)) bad.push('[object Object]');
  check(`${label} 无脏值（undefined/NaN/object）`, bad.length === 0, bad.join(','));
  return bad.length === 0;
}

console.log('[1] view 层：网络自检横幅');
{
  const ok = views.netBanner({ verdict: 'ok', summary: '', targets: [] });
  check('verdict=ok 时不渲染横幅', ok === '');

  const partial = views.netBanner({
    verdict: 'partial',
    summary: '只能连通 GitHub API，连不上 github.com。',
    targets: [
      { host: 'api.github.com', reachable: true, https: { ms: 230 } },
      { host: 'github.com', reachable: false, https: { reason: 'timeout' } },
    ],
    suspicious: ['github.com'],
  });
  check('verdict=partial 时渲染横幅', partial.includes('github.com') && partial.length > 100);
  check('  └ 标注了可疑的假握手', partial.includes('透明代理'));
  dirty(partial, '网络横幅');
}

console.log('\n[2] view 层：GitHub 未连接态（授权引导）');
{
  const html = views.renderGithub({
    auth: { connected: false, vault: { mode: 'dpapi', dpapiAvailable: true, encrypted: true }, clientId: null },
    net: { verdict: 'ok', targets: [] },
    repos: [],
    filter: {},
  });
  check('渲染出连接引导', html.includes('连接 GitHub'));
  check('  └ 说明了设备码授权不需要 client_secret', html.includes('client_secret'));
  check('  └ 明确提示要勾选 Enable Device Flow', html.includes('Enable Device Flow'));
  check('  └ 强调 Client ID 不是密钥', html.includes('不是密钥'));
  check('  └ 有 client_id 输入框', html.includes('id="gh-client-id"'));
  check('  └ 有开始授权按钮', html.includes('data-action="gh-authorize"'));
  check('  └ 提供 PAT 备选入口', html.includes('data-action="gh-toggle-pat"'));
  check('  └ 展示了凭据安全等级', html.includes('DPAPI'));
  dirty(html, '未连接态');
}

console.log('\n[3] view 层：GitHub 已连接态（仓库列表）');
{
  const repos = [
    { id: 1, owner: 'octocat', name: 'git-manager', fullName: 'octocat/git-manager', private: true, fork: false, archived: false, description: '本地 Git 体检与维护中枢', language: 'JavaScript', stars: 3, forks: 0, sizeKb: 2048, pushedAt: new Date(Date.now() - 3600e3).toISOString() },
    { id: 2, owner: 'octocat', name: 'hello', fullName: 'octocat/hello', private: false, fork: false, archived: true, description: '', language: '', stars: 0, forks: 0, sizeKb: 12, pushedAt: new Date(Date.now() - 86400e3 * 40).toISOString() },
  ];
  const html = views.renderGithub({
    auth: { connected: true, method: 'oauth', viewer: { login: 'octocat', name: 'The Octocat', avatar: 'https://x/y.png', scopes: ['repo', 'read:user'] } },
    net: { verdict: 'ok', targets: [] },
    repos,
    filter: {},
  });
  check('渲染身份条', html.includes('@octocat'));
  check('  └ 显示了授权方式', html.includes('OAuth 设备码'));
  check('  └ 显示了 scope', html.includes('repo, read:user'));
  check('  └ 标记为可提交', html.includes('可提交'));
  check('渲染仓库卡片 x2', (html.match(/gh-repo"/g) || []).length === 2 || (html.match(/class="gh-repo"/g) || []).length === 2, String((html.match(/gh-repo/g) || []).length));
  check('  └ 私有标记正确', html.includes('私有') && html.includes('公开'));
  check('  └ 归档标记正确', html.includes('已归档'));
  check('  └ 空描述有兜底', html.includes('（无描述）'));
  check('  └ 体积格式化正确（2048KB → 2.0 MB）', html.includes('2.0 MB'), html.match(/[\d.]+ (KB|MB|GB)/g)?.join(','));
  check('  └ 有克隆与退出入口', html.includes('gh-clone-wizard') && html.includes('gh-logout'));
  dirty(html, '已连接态');
}

console.log('\n[4] 只读授权时不显示「可提交」');
{
  const html = views.renderGithub({
    auth: { connected: true, method: 'oauth', viewer: { login: 'x', scopes: ['read:user'] } },
    net: { verdict: 'ok', targets: [] },
    repos: [],
    filter: {},
  });
  check('标记为只读', html.includes('只读') && !html.includes('可提交'));
}

console.log('\n[5] 差异摘要（提交前的变更预览）');
{
  const d = palette.summarizeDiff('a\nb\nc', 'a\nB\nc\nd');
  check('统计新增行数', d.added === 2, String(d.added));
  check('统计删除行数', d.removed === 1, String(d.removed));
  check('  └ 含新增标记', d.html.includes('d-add'));
  check('  └ 含删除标记', d.html.includes('d-del'));
  const fresh = palette.summarizeDiff(null, 'x\ny');
  check('新建文件时全部计为新增', fresh.added === 2 && fresh.removed === 0, `${fresh.added}/${fresh.removed}`);
  dirty(d.html, '差异 HTML');
}

console.log('\n[6] 用真实数据回归本地仓库各视图');
{
  const cfg = await fetch(`http://127.0.0.1:${PORT}/gm-config.js`).then((r) => r.text()).catch(() => '');
  const token = (cfg.match(/"token":"([^"]+)"/) || [])[1];
  if (!token) {
    console.log('  · 跳过：本地服务未运行或拿不到令牌');
  } else {
    const H = { 'x-gm-token': token };
    const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`, { headers: H }).then((r) => r.json());
    const mine = repos.repos.find((r) => r.exists);
    if (!mine) {
      console.log('  · 跳过：没有已接入的本地仓库');
    } else {
      const g = (p) => fetch(`http://127.0.0.1:${PORT}/api/repos/${mine.id}${p}`, { headers: H }).then((r) => r.json());
      const [o, h, a, cm, br, lg] = await Promise.all([
        g('/overview'), g('/health'), g('/activity?weeks=12'), g('/commits?limit=20'), g('/branches'), g('/log'),
      ]);
      const v1 = views.renderOverview({ overview: o, health: h, activity: a, commits: cm.commits });
      const v2 = views.renderBranches({ branches: br });
      const v3 = views.renderCommits({ commits: cm.commits });
      const v4 = views.renderLog({ logs: lg.logs });
      const v5 = views.renderEmpty({ repos: repos.repos });
      for (const [n, html] of [['概览', v1], ['分支', v2], ['提交', v3], ['日志', v4], ['空状态', v5]]) {
        check(`${n} 视图渲染成功`, typeof html === 'string' && html.length > 100, String(html?.length));
        dirty(html, `${n}视图`);
      }
      check('概览含健康度评分', v1.includes(String(h.score)));
      check('分支视图含分支名', v2.includes('main'));
    }
  }
}

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');
process.exit(fail === 0 ? 0 : 1);
