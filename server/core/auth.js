import crypto from 'node:crypto';
import { putSecret, getSecret, deleteSecret, hasSecret, vaultInfo } from './secrets.js';

/**
 * GitHub 授权 —— OAuth 2.0 Device Flow（设备码流程）。
 *
 * 为什么是 Device Flow，而不是常见的「回调式 OAuth」：
 * - 回调式（Authorization Code）换取 token 时必须带 client_secret。本地/桌面应用
 *   没法安全保存 secret（客户端里的一切都能被提取），只能硬编码 → 等于公开泄露。
 * - Device Flow 由 GitHub 官方为 CLI / 桌面应用设计，**只需要 client_id**（公开值），
 *   不需要 client_secret，也不需要回调地址与本地端口监听。
 *
 * 因此本模块的磁盘上只会出现两样东西：
 * - `gh_client_id`：OAuth App 的公开标识，非机密
 * - `gh_token`：访问令牌，加密落盘（见 secrets.js）
 *
 * token 明文永不返回前端、永不写日志。
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const VERIFY_PAGE = 'https://github.com/login/device';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const K_CLIENT_ID = 'gh_client_id';
const K_TOKEN = 'gh_token';
const K_PAT = 'gh_pat';

/**
 * scope 预设 —— 默认给最小够用的那档，而不是一上来就要最大权限 */
export const SCOPE_PRESETS = {
  readonly: 'read:user public_repo read:org',
  write: 'read:user repo read:org',
};

/**
 * client_id 的宽松格式校验。
 *
 * 只用来拦住明显的粘贴错误（空值、贴成 URL、贴成整段 JSON），
 * **绝不做严格格式假设** —— GitHub 的 client_id 形状并不统一：
 *   - 老版经典应用：`Iv1.8a61f9b3a7aba766`（**含点号**）
 *   - 新版应用：`Ov23liAbcDefGhiJkLmN`（纯字母数字）
 * 早先的正则 `^[A-Za-z0-9]{10,64}$` 会把含点号的经典格式直接拒掉，
 * 属于"自己把自己锁在门外"。宁可放过，不可误拦。
 */
export function looksLikeClientId(value) {
  const cid = String(value || '').trim();
  if (!cid) return false;
  return /^[A-Za-z0-9._-]{8,80}$/.test(cid);
}


/**
 * 轮询间隔下限。GitHub 实际会给 5 秒，这里夹一个下限防止我们过频打接口。
 * GM_OAUTH_MIN_INTERVAL 仅供测试收紧，生产不要设置。
 */
const MIN_INTERVAL = Math.max(1, Number(process.env.GM_OAUTH_MIN_INTERVAL) || 5);

export function scopesFor(mode) {
  return SCOPE_PRESETS[mode] || SCOPE_PRESETS.write;
}

// 便于测试替换；生产走全局 fetch
let fetchImpl = globalThis.fetch;
export function setFetchImpl(f) {
  fetchImpl = f || globalThis.fetch;
}

/* ---------------- 设备码会话 ---------------- */

const sessions = new Map();
const SESSION_TTL = 20 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
}

function post(url, body) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GitHub 返回了非 JSON 响应（HTTP ${res.status}）`);
  }
}

/**
 * 第一步：申请设备码。
 * 返回给前端的只有 user_code 与验证地址，device_code 留在服务端。
 */
export async function startDeviceFlow({ clientId, scopeMode = 'write' } = {}) {
  sweep();
  const cid = String(clientId || (await getSecret(K_CLIENT_ID)) || process.env.GM_GH_CLIENT_ID || '').trim();
  if (!cid) {
    const e = new Error('还没有配置 OAuth App 的 client_id，请先填写后再授权');
    e.status = 400;
    e.code = 'NO_CLIENT_ID';
    throw e;
  }

  const scopes = scopesFor(scopeMode);
  let payload;
  try {
    const res = await post(DEVICE_CODE_URL, { client_id: cid, scope: scopes });
    payload = await readJson(res);
  } catch (e) {
    const err = new Error(`无法连接 GitHub（${e.message}）。请检查网络或代理。`);
    err.status = 502;
    err.code = 'NETWORK';
    throw err;
  }

  if (payload.error) {
    const e = new Error(deviceErrorText(payload.error, payload.error_description));
    e.status = 400;
    e.code = payload.error;
    throw e;
  }

  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, {
    id,
    createdAt: Date.now(),
    clientId: cid,
    scopes,
    scopeMode,
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri || VERIFY_PAGE,
    interval: Math.max(MIN_INTERVAL, Number(payload.interval) || 5),
    expiresAt: Date.now() + (Number(payload.expires_in) || 900) * 1000,
    // 关键：初始就置为「刚刚」，让首次轮询也受 interval 闸门约束。
    // 置 0 会让第一次轮询绕过闸门（RFC 8628 要求在首次轮询前同样等待 interval）。
    lastPollAt: Date.now(),
    status: 'pending', // pending | slow_down | ok | expired | denied | error
    error: null,
  });

  return publicSession(sessions.get(id));
}

/** 第二步：轮询。由前端按 interval 驱动，服务端做频率闸门。 */
export async function pollDeviceFlow(id) {
  const s = sessions.get(id);
  if (!s) {
    const e = new Error('授权会话不存在或已过期，请重新发起');
    e.status = 404;
    throw e;
  }
  if (s.status === 'ok' || s.status === 'denied' || s.status === 'error') return publicSession(s);
  if (Date.now() > s.expiresAt) {
    s.status = 'expired';
    return publicSession(s);
  }

  // 频率闸门：快于 GitHub 给的下限就直接返回当前状态，不真的打请求
  const wait = s.interval * 1000;
  if (Date.now() - s.lastPollAt < wait) return publicSession(s);
  s.lastPollAt = Date.now();

  const res = await post(ACCESS_TOKEN_URL, {
    client_id: s.clientId,
    device_code: s.deviceCode,
    grant_type: GRANT_TYPE,
  });
  const payload = await readJson(res);

  if (payload.access_token) {
    // 确认身份后再落盘，避免存下一个无效 token
    const who = await verifyToken(payload.access_token).catch(() => null);
    if (!who) {
      s.status = 'error';
      s.error = '拿到 token 但无法验证身份，可能是 token 权限不足或已被撤销';
      return publicSession(s);
    }
    await putSecret(K_CLIENT_ID, s.clientId);
    await putSecret(K_TOKEN, payload.access_token);
    deleteSecret(K_PAT);
    s.status = 'ok';
    s.viewer = who;
    return publicSession(s);
  }

  const err = payload.error;
  if (err === 'authorization_pending') {
    s.status = 'pending';
  } else if (err === 'slow_down') {
    s.interval += 5; // 按 GitHub 要求退避
    s.status = 'pending';
  } else if (err === 'expired_token') {
    s.status = 'expired';
  } else if (err === 'access_denied') {
    s.status = 'denied';
    s.error = '你在 GitHub 上拒绝了本次授权';
  } else {
    s.status = 'error';
    s.error = deviceErrorText(err, payload.error_description);
  }
  return publicSession(s);
}

export function cancelDeviceFlow(id) {
  sessions.delete(id);
  return { ok: true };
}

function publicSession(s) {
  return {
    id: s.id,
    status: s.status,
    userCode: s.userCode,
    verificationUri: s.verificationUri,
    interval: s.interval,
    expiresIn: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
    scopes: s.scopes,
    scopeMode: s.scopeMode,
    error: s.error,
    viewer: s.viewer || null,
  };
}

function deviceErrorText(code, desc) {
  const map = {
    incorrect_client_credentials:
      'client_id 无效：请确认这个 OAuth App 存在，且已在设置里勾选 Enable Device Flow',
    device_flow_disabled: '这个 OAuth App 没有启用 Device Flow，请到 App 设置里勾选 Enable Device Flow',
    unsupported_grant_type: '授权类型不被支持（通常是 client_id 类型不对）',
    access_denied: '授权被拒绝',
    expired_token: '设备码已过期，请重新发起授权',
    not_found:
      'GitHub 不认识这个 client_id（返回 404 Not Found）。请逐项检查：' +
      '① Client ID 是否复制完整、有没有多余空格；② 这个 OAuth App 是否真的存在（有没有被删）；' +
      '③ 是否在 App 设置里勾选了 Enable Device Flow',
  };
  // GitHub 的错误码大小写与分隔符并不统一（例如 "Not Found" vs "device_flow_disabled"），
  // 所以先归一化再查表，否则映射永远命中不了。
  const key = String(code || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return map[key] || `${code || '授权失败'}${desc ? `：${desc}` : ''}`;
}

/* ---------------- token 生命周期 ---------------- */

/** 当前生效的 token（服务端内部使用，绝不外传） */
export async function getToken() {
  if (hasSecret(K_TOKEN)) {
    const t = await getSecret(K_TOKEN);
    if (t) return t;
  }
  if (hasSecret(K_PAT)) {
    const t = await getSecret(K_PAT);
    if (t) return t;
  }
  return process.env.GM_GH_TOKEN || null;
}

export async function getClientId() {
  return (await getSecret(K_CLIENT_ID)) || process.env.GM_GH_CLIENT_ID || null;
}

/** 直接存 PAT（进阶用法：细粒度 PAT 的权限比 OAuth 的 repo scope 更精确） */
export async function setPat(token, { verify } = {}) {
  const t = String(token || '').trim();
  if (!t) {
    const e = new Error('token 不能为空');
    e.status = 400;
    throw e;
  }
  const who = await (verify || verifyToken)(t);
  await putSecret(K_PAT, t);
  deleteSecret(K_TOKEN);
  return { viewer: who, method: 'pat' };
}

/**
 * 用 token 换身份信息。刻意不走 github.js，避免模块循环依赖。
 * 顺带拿 scopes —— 前端要如实展示"这次授权到底给了多大权限"。
 */
export async function verifyToken(token) {
  const res = await fetchImpl('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'git-manager',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'token 无效或已过期' : `验证失败（HTTP ${res.status}）`);
    e.status = res.status === 401 ? 401 : 502;
    throw e;
  }
  const u = await res.json();
  const scopes = String(res.headers.get('x-oauth-scopes') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    login: u.login,
    name: u.name || u.login,
    avatar: u.avatar_url,
    url: u.html_url,
    scopes,
  };
}

/**
 * 退出登录。
 * 诚实说明：Device Flow 没有 client_secret，因此无法调用 GitHub 的吊销接口
 * （那个接口要求 client_id + client_secret 做 Basic 认证）。
 * 所以我们只能删掉本地副本，"在 GitHub 侧撤销"必须由用户自己去设置页点一下。
 */
export async function logout() {
  const had = hasSecret(K_TOKEN) || hasSecret(K_PAT);
  deleteSecret(K_TOKEN);
  deleteSecret(K_PAT);
  return { ok: true, hadToken: had, revokeUrl: 'https://github.com/settings/applications' };
}

export async function authStatus() {
  const token = await getToken().catch(() => null);
  const vault = vaultInfo();
  const base = {
    connected: false,
    method: hasSecret(K_PAT) ? 'pat' : hasSecret(K_TOKEN) ? 'oauth' : process.env.GM_GH_TOKEN ? 'env' : null,
    clientId: await getClientId().catch(() => null),
    clientIdSource: hasSecret('gh_client_id') ? 'saved' : process.env.GM_GH_CLIENT_ID ? 'env' : null,
    vault,
  };
  if (!token) return { ...base, connected: false };

  try {
    const viewer = await verifyToken(token);
    return { ...base, connected: true, viewer };
  } catch (e) {
    return { ...base, connected: false, stale: true, error: e.message };
  }
}
