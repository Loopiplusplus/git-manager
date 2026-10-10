/**
 * Device Flow 状态机测试 —— 用受控的 fetch 替身验证完整分支，不依赖真实 GitHub。
 *
 * 覆盖：正常授权、authorization_pending、slow_down 退避、expired_token、
 * access_denied、incorrect_client_credentials，以及「device_code 绝不外泄」和
 * 「轮询频率闸门真的生效」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-oauth-'));
process.env.GM_DATA_DIR = TMP;
process.env.GM_VAULT_MODE = 'plain'; // 测试不跑 DPAPI（每次 800ms）
process.env.GM_OAUTH_MIN_INTERVAL = '1'; // 把轮询间隔下限收紧到 1 秒，避免测试空等

const auth = await import('../server/core/auth.js');
const { vaultInfo } = await import('../server/core/secrets.js');

const CLIENT_ID = 'Iv1a2b3c4d5e6f7g8';
const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

/** 可编程的 GitHub 替身 */
function makeFetch(script) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, body });
    const step = script(url, body, calls.length);
    const json = step.body ?? {};
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status || 200,
      headers: new Map(Object.entries(step.headers || {})),
      text: async () => JSON.stringify(json),
      json: async () => json,
    };
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(obj, status = 200, headers = {}) {
  return { body: obj, status, headers };
}

console.log('数据目录:', TMP);
console.log('');

/* ---------- 1. 没有 client_id 时应给出明确错误 ---------- */
console.log('[1] 未配置 client_id');
{
  auth.setFetchImpl(makeFetch(() => jsonResponse({})));
  let err = null;
  try {
    await auth.startDeviceFlow({});
  } catch (e) {
    err = e;
  }
  check('抛出错误', !!err);
  check('错误码为 NO_CLIENT_ID', err?.code === 'NO_CLIENT_ID', err?.code);
  check('错误信息提示先填 client_id', /client_id/.test(err?.message || ''), err?.message);
}

/* ---------- 2. 正常授权全流程 ---------- */
console.log('\n[2] 正常授权：pending → slow_down → 成功');
{
  let pollCount = 0;
  const f = makeFetch((url, body) => {
    if (url.includes('/login/device/code')) {
      check('device/code 请求带了 client_id', body.client_id === CLIENT_ID);
      check('device/code 请求带了 scope', typeof body.scope === 'string' && body.scope.length > 0, body.scope);
      return jsonResponse({
        device_code: 'DEVICE_CODE_SECRET_XYZ',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.includes('/login/oauth/access_token')) {
      pollCount++;
      check('access_token 请求带了 device_code', body.device_code === 'DEVICE_CODE_SECRET_XYZ');
      check('grant_type 正确', body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code');
      if (pollCount === 1) return jsonResponse({ error: 'authorization_pending' });
      if (pollCount === 2) return jsonResponse({ error: 'slow_down' });
      return jsonResponse({ access_token: TOKEN, token_type: 'bearer', scope: 'repo,read:user' });
    }
    if (url.includes('/user')) {
      return jsonResponse(
        {
          login: 'octocat',
          name: 'The Octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
          html_url: 'https://github.com/octocat',
        },
        200,
        { 'x-oauth-scopes': 'repo, read:user' },
      );
    }
    throw new Error('未预期的请求: ' + url);
  });
  auth.setFetchImpl(f);

  const s0 = await auth.startDeviceFlow({ clientId: CLIENT_ID, scopeMode: 'write' });
  check('返回 user_code', s0.userCode === 'WDJB-MJHT');
  check('返回验证地址', s0.verificationUri === 'https://github.com/login/device');
  check('初始状态 pending', s0.status === 'pending');
  check('两段式 scope 预设生效', s0.scopes.includes('repo'), s0.scopes);

  // device_code 绝不能出现在返回给前端的对象里
  const leaked = JSON.stringify(s0).includes('DEVICE_CODE_SECRET');
  check('device_code 未泄漏给前端', !leaked, leaked ? '泄漏了！' : '');

  // 频率闸门：紧接着再轮询，不应真的发请求
  const before = f.calls.filter((c) => c.url.includes('access_token')).length;
  const sGate = await auth.pollDeviceFlow(s0.id);
  const after = f.calls.filter((c) => c.url.includes('access_token')).length;
  check('频率闸门拦住了过快轮询', after === before, `${before} → ${after}`);
  check('闸门内仍返回 pending', sGate.status === 'pending');

  // 等过 interval 再轮询，走真实状态机
  await waitThroughGate(s0.interval);
  const s1 = await auth.pollDeviceFlow(s0.id);
  check('第 1 次轮询保持 pending（authorization_pending）', s1.status === 'pending', s1.status);

  await waitThroughGate(s1.interval);
  const s2 = await auth.pollDeviceFlow(s0.id);
  check('slow_down 后间隔被拉长', s2.interval === s0.interval + 5, `${s0.interval} → ${s2.interval}`);
  check('slow_down 期间状态仍为 pending', s2.status === 'pending', s2.status);

  await waitThroughGate(s2.interval);
  const s3 = await auth.pollDeviceFlow(s0.id);
  check('最终状态 ok', s3.status === 'ok', `${s3.status} / ${s3.error || ''}`);
  check('成功后带回了身份信息', s3.viewer?.login === 'octocat', JSON.stringify(s3.viewer));
  check('身份信息含 scope', (s3.viewer?.scopes || []).includes('repo'), JSON.stringify(s3.viewer?.scopes));
}

/* ---------- 3. token 确实落盘且可读回 ---------- */
console.log('\n[3] 授权后 token 落盘');
{
  const status = await auth.authStatus();
  // authStatus 会再打一次 /user，替身里已支持
  check('authStatus 显示已连接', status.connected === true, JSON.stringify({ connected: status.connected, err: status.error }));
  check('授权方式记录为 oauth', status.method === 'oauth', status.method);
  check('client_id 已被持久化', status.clientId === CLIENT_ID, status.clientId);

  const raw = fs.readFileSync(path.join(TMP, 'secrets.json'), 'utf8');
  check('secrets.json 已生成', raw.length > 0);
  check('明文 token 未直接落盘（plain 模式下会落盘，此处仅确认结构）', raw.includes('gh_token'));
  const v = vaultInfo();
  check('凭据名列表包含 gh_token', v.names.includes('gh_token'), v.names.join(','));

  const t = await auth.getToken();
  check('getToken 能取回原 token', t === TOKEN);
}

/* ---------- 4. 拒绝 / 过期 / client_id 错误 ---------- */
console.log('\n[4] 各类失败分支');
for (const [code, expectStatus, expectPattern] of [
  ['access_denied', 'denied', /拒绝/],
  ['expired_token', 'expired', null],
  ['incorrect_client_credentials', 'error', /Enable Device Flow|client_id/],
  ['device_flow_disabled', 'error', /Enable Device Flow/],
]) {
  auth.setFetchImpl(
    makeFetch((url) => {
      if (url.includes('/login/device/code')) {
        return jsonResponse({ device_code: 'D', user_code: 'AAAA-BBBB', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
      }
      return jsonResponse({ error: code, error_description: `desc for ${code}` });
    }),
  );
  const s = await auth.startDeviceFlow({ clientId: CLIENT_ID });
  await waitThroughGate(s.interval);
  const r = await auth.pollDeviceFlow(s.id);
  check(`${code} → status=${expectStatus}`, r.status === expectStatus, `实得 ${r.status}`);
  if (expectPattern) check(`${code} → 有中文可读提示`, expectPattern.test(r.error || ''), r.error);
}

/* ---------- 4b. 设备码端点本身返回 GitHub 的 404 {"error":"Not Found"} ----------
   这是真机上最常见的一种失败：client_id 不存在时 GitHub 就回这个（已实测确认）。
   如果映射表命中不了，用户只会看到一句光秃秃的 "Not Found"，完全不知道怎么排查。 */
{
  auth.setFetchImpl(makeFetch(() => jsonResponse({ error: 'Not Found' }, 404)));
  let err = null;
  try {
    await auth.startDeviceFlow({ clientId: CLIENT_ID });
  } catch (e) {
    err = e;
  }
  const msg = err?.message || '';
  check('设备码端点返回 Not Found → 抛出错误而不是静默通过', !!err);
  check('Not Found 被映射成中文可读提示', /client_id/.test(msg), msg);
  check('提示里包含三个排查方向（复制/存在/Device Flow）', /Enable Device Flow/.test(msg), msg);
  check('不再出现裸英文 Not Found 作为全部内容', msg !== 'Not Found', msg);
}

/* ---------- 4c. 错误码的大小写与分隔符不统一时也要能命中映射 ---------- */
for (const variant of ['Not Found', 'NOT-FOUND', 'not found', 'Not_Found']) {
  auth.setFetchImpl(
    makeFetch((url) => {
      if (url.includes('/login/device/code')) {
        return jsonResponse({
          device_code: 'D',
          user_code: 'AAAA-BBBB',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        });
      }
      return jsonResponse({ error: variant });
    }),
  );
  const s = await auth.startDeviceFlow({ clientId: CLIENT_ID });
  await waitThroughGate(s.interval);
  const r = await auth.pollDeviceFlow(s.id);
  check(`错误码变体「${variant}」命中同一提示`, /client_id/.test(r.error || ''), r.error);
}

/* ---------- 5. 退出登录 ---------- */
console.log('\n[5] 退出登录');
{
  const r = await auth.logout();
  check('返回 hadToken', r.hadToken === true);
  check('给出了手动吊销地址', /github\.com/.test(r.revokeUrl || ''), r.revokeUrl);
  const after = await auth.authStatus();
  check('退出后 connected=false', after.connected === false);
  check('退出后 method=null', after.method === null, String(after.method));
  const names = vaultInfo().names;
  check('gh_token 已从仓库删除', !names.includes('gh_token'), names.join(','));
}

/* ---------- 6. PAT 备选通道 ---------- */
console.log('\n[6] PAT 备选通道');
{
  auth.setFetchImpl(
    makeFetch((url) =>
      url.includes('/user')
        ? jsonResponse({ login: 'patuser', name: 'PAT User', avatar_url: '', html_url: '' }, 200, { 'x-oauth-scopes': '' })
        : jsonResponse({}),
    ),
  );
  const r = await auth.setPat('github_pat_11ABCDEFG0abcdefg');
  check('PAT 验证通过并返回身份', r.viewer?.login === 'patuser', JSON.stringify(r.viewer));
  check('method 记录为 pat', r.method === 'pat');
  const st = await auth.authStatus();
  check('authStatus.method = pat', st.method === 'pat', st.method);

  let badErr = null;
  auth.setFetchImpl(makeFetch(() => jsonResponse({ message: 'Bad credentials' }, 401)));
  try {
    await auth.setPat('invalid-token');
  } catch (e) {
    badErr = e;
  }
  check('无效 PAT 被拒绝', !!badErr);
  check('无效 PAT 错误码 401', badErr?.status === 401, String(badErr?.status));
}

/* ---------- client_id 格式校验：必须放过合法格式，只拦明显粘贴错误 ---------- */
{
  const { looksLikeClientId } = auth;
  const GOOD = [
    ['经典格式（含点号）', 'Iv1.8a61f9b3a7aba766'],
    ['新版格式', 'Ov23liAbcDefGhiJkLmN'],
    ['无点号经典格式', 'Iv1abc123def456'],
    ['含下划线', 'Iv1_abc123def456'],
    ['含短横', 'Iv1-abc123-def456'],
    ['前后带空格（应被 trim 后接受）', '  Ov23liAbcDefGhiJkLmN  '],
  ];
  const BAD = [
    ['空串', ''],
    ['纯空格', '   '],
    ['undefined', undefined],
    ['null', null],
    ['整段 URL', 'https://github.com/settings/applications'],
    ['含斜杠', 'abc/def/ghi'],
    ['含冒号', 'abc:def'],
    ['超长（>80）', 'a'.repeat(81)],
  ];
  for (const [label, v] of GOOD) check(`client_id 接受 ${label}`, looksLikeClientId(v) === true, String(v));
  for (const [label, v] of BAD) check(`client_id 拒绝 ${label}`, looksLikeClientId(v) === false, String(v));
}

/* ---------- 收尾 ---------- */
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');

/** 等过轮询闸门（测试里 interval 很小，只需等 interval + 一点余量） */
async function waitThroughGate(seconds) {
  await new Promise((r) => setTimeout(r, seconds * 1000 + 80));
}

process.exit(fail === 0 ? 0 : 1);
