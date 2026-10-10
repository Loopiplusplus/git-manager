/**
 * 唯一的传输边界。
 *
 * Web 版：走 HTTP（fetch + 本机令牌）。
 * 桌面端：把 request() 换成 Tauri 的 invoke() 或 Electron 的 IPC 即可，
 *         上游所有视图代码一行都不用改。
 */
const cfg = window.__GM__ || { token: '', apiBase: '/api' };

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

export const api = {
  health: () => request('/health'),
  listRepos: () => request('/repos'),
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

  // 文件系统（只读探测 / 原生对话框 / 扫描）
  drives: () => request('/fs/drives'),
  pickFolder: (opts = {}) => request('/fs/pick', { method: 'POST', body: opts }),
  probe: (path) => request('/fs/probe', { method: 'POST', body: { path } }),
  scanStart: (root, maxDepth) => request('/scan', { method: 'POST', body: { root, maxDepth } }).then((r) => r.job),
  scanGet: (id) => request(`/scan/${enc(id)}`).then((r) => r.job),
  scanCancel: (id) => request(`/scan/${enc(id)}/cancel`, { method: 'POST' }).then((r) => r.job),
};

export const transportName = cfg.transport || 'http';
