/**
 * 唯一的传输边界。
 *
 * Web 版：走 HTTP（fetch + 本机令牌）。
 * 桌面版：**同一个 HTTP 服务**，只是由 Electron 主进程以 sidecar 拉起，
 *         窗口直接加载 127.0.0.1 —— 所以下面所有请求一行都不用改。
 *
 * 唯一的例外是原生文件对话框：Web 版靠服务端 spawn PowerShell 弹出，
 * 在桌面端会闪出一个多余的 powershell 窗口，且与窗口不在同一模态里。
 * 因此桌面端把它换成 Electron 的原生 dialog（走 preload 暴露的 IPC）。
 * 这正是 docs/03 里说的「迁移时只改 api.js 这一个文件」。
 */
const cfg = window.__GM__ || { token: '', apiBase: '/api' };

/** 桌面端由 preload.cjs 注入；浏览器里为 undefined，于是自动回落到 HTTP */
const desktop = window.gmDesktop && window.gmDesktop.isDesktop ? window.gmDesktop : null;

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(cfg.apiBase + path, {
    method,
    headers: {
      'x-gm-token': cfg.token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

export const api = {
  health: () => request('/health'),
  listRepos: () => request('/repos'),
  ghSetActiveRepo: (id) => request('/repos/active', { method: 'POST', body: { id } }),
  openRepo: (path) => request('/repos/open', { method: 'POST', body: { path } }),
  removeRepo: (id) => request(`/repos/${enc(id)}`, { method: 'DELETE' }),
  overview: (id) => request(`/repos/${enc(id)}/overview`),
  branches: (id) => request(`/repos/${enc(id)}/branches`),
  commits: (id, limit = 40) => request(`/repos/${enc(id)}/commits?limit=${limit}`).then((r) => r.commits || []),
  activity: (id, weeks = 12) => request(`/repos/${enc(id)}/activity?weeks=${weeks}`),
  healthReport: (id) => request(`/repos/${enc(id)}/health`),
  logs: (id) => request(`/repos/${enc(id)}/log`).then((r) => r.logs || []),
  preflight: (id, target) => request(`/repos/${enc(id)}/preflight`, { method: 'POST', body: { target } }),
  switchBranch: (id, payload) => request(`/repos/${enc(id)}/switch`, { method: 'POST', body: payload }),
  undo: (id) => request(`/repos/${enc(id)}/undo`, { method: 'POST' }),

  // 本地仓库 → GitHub 的提交与推送
  publishStatus: (id) => request(`/repos/${enc(id)}/publish-status`),
  publish: (id, payload) => request(`/repos/${enc(id)}/publish`, { method: 'POST', body: payload }),

  // 文件系统（只读探测 / 原生对话框 / 扫描）
  drives: () => request('/fs/drives'),
  // 桌面端走 Electron 原生对话框；两者返回结构完全一致（{ok, cancelled, path}），
  // 所以调用方不需要知道自己在哪个宿主里。
  pickFolder: (opts = {}) => (desktop ? desktop.pickFolder(opts) : request('/fs/pick', { method: 'POST', body: opts })),
  pickFile: (opts = {}) => (desktop ? desktop.pickFile(opts) : request('/fs/pick-file', { method: 'POST', body: opts })),
  probe: (path) => request('/fs/probe', { method: 'POST', body: { path } }),
  scanStart: (root, maxDepth) => request('/scan', { method: 'POST', body: { root, maxDepth } }).then((r) => r.job),
  scanGet: (id) => request(`/scan/${enc(id)}`).then((r) => r.job),
  scanCancel: (id) => request(`/scan/${enc(id)}/cancel`, { method: 'POST' }).then((r) => r.job),

  /* ---------------- GitHub ---------------- */
  ghStatus: () => request('/gh/status'),
  ghSetClientId: (clientId) => request('/gh/client-id', { method: 'POST', body: { clientId } }),
  ghClearClientId: () => request('/gh/client-id', { method: 'DELETE' }),
  ghDeviceStart: (scopeMode) => request('/gh/device/start', { method: 'POST', body: { scopeMode } }).then((r) => r.session),
  ghDevicePoll: (id) => request(`/gh/device/${enc(id)}`).then((r) => r.session),
  ghDeviceCancel: (id) => request(`/gh/device/${enc(id)}/cancel`, { method: 'POST' }),
  ghSetPat: (token) => request('/gh/pat', { method: 'POST', body: { token } }),
  ghLogout: () => request('/gh/logout', { method: 'POST' }),
  ghRate: () => request('/gh/rate'),
  ghRepos: (opts = {}) => request(`/gh/repos?${qs(opts)}`).then((r) => r.repos || []),
  ghRepo: (owner, name) => request(`/gh/repo?${qs({ owner, name })}`),
  ghContents: (owner, name, path = '', ref) => request(`/gh/contents?${qs({ owner, name, path, ref })}`),
  ghPreview: (payload) => request('/gh/preview', { method: 'POST', body: payload }),
  ghCommit: (payload) => request('/gh/commit', { method: 'POST', body: payload }),
  ghDelete: (payload) => request('/gh/delete', { method: 'POST', body: payload }),
  ghLog: () => request('/gh/log').then((r) => r.logs || []),
  ghParse: (url) => request('/gh/parse', { method: 'POST', body: { url } }),
  ghClone: (payload) => request('/gh/clone', { method: 'POST', body: payload }),
  ghCreateRepo: (payload) => request('/gh/create-repo', { method: 'POST', body: payload }),

  // 头像代理地址：<img> 不能带请求头，所以令牌走查询串（仅此路由允许）
  ghAvatarUrl: ({ login, url, size } = {}) =>
    `${cfg.apiBase}/gh/avatar?${qs({ login, u: url, size, t: cfg.token })}`,

  // 运行环境自检：GitHub 的 API 域名与 git 传输域名是分开的，
  // 有些网络只放行前者，需要能提前告知用户，而不是让他在超时里干等。
  netProbe: () => request('/net/probe'),
};


/**
 * 运行宿主。视图层可以据此调整文案（例如桌面端不需要提示「手动输入路径」）。
 * `desktopApp` 为桌面端专属能力，浏览器里是 null。
 */
export const transportName = desktop ? 'electron-ipc' : cfg.transport || 'http';
export const desktopApp = desktop;
