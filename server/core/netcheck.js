import net from 'node:net';
import https from 'node:https';
import dns from 'node:dns/promises';

/**
 * 网络自检。
 *
 * 存在的理由：GitHub 的「API 域名」与「git 传输 / 授权域名」是**分开的**。
 * 只放行 api.github.com 的网络（常见于企业代理、CI 沙箱）可以正常读仓库、
 * 提交文件，却无法完成 OAuth 授权（走 github.com）和 git clone（走 github.com）。
 *
 * 与其让用户对着 10 秒超时干等，不如提前探测并把结论摆出来。
 *
 * ⚠️ 关键教训：**不能用 TCP 握手来判断可用性**。
 * 透明代理 / 中间拦截器常常先完成 TCP 三次握手、再黑洞掉后续数据，
 * 于是 net.connect 秒回成功，而真正的 HTTPS 请求却超时。
 * 因此这里以「真的发出 HTTPS 请求并拿到响应」为唯一判据，TCP 结果仅作诊断参考。
 *
 * 探测走直连（不套代理），因为本应用的内置 fetch 基于 undici，默认也不读代理环境变量，
 * 两者行为一致才能真正预测应用的表现。
 */

const TARGETS = [
  {
    key: 'api',
    host: 'api.github.com',
    path: '/rate_limit',
    label: 'GitHub API',
    enables: '读取仓库、分支、提交，以及直接提交文件',
  },
  {
    key: 'web',
    host: 'github.com',
    path: '/',
    label: 'GitHub 主站',
    enables: 'OAuth 设备码授权、git clone / fetch',
  },
  {
    key: 'codeload',
    host: 'codeload.github.com',
    path: '/',
    label: '归档下载',
    enables: '下载仓库压缩包',
  },
];

/** 真的发一个 HTTPS 请求，这才是可用性的可靠判据 */
function httpsCheck(host, reqPath, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (ok, extra = {}) => {
      if (settled) return;
      settled = true;
      resolve({ ok, ms: Date.now() - started, ...extra });
    };

    const req = https.request(
      {
        host,
        port: 443,
        path: reqPath,
        method: 'GET',
        timeout,
        // 直连，不套代理，与应用内 undici 行为对齐
        agent: new https.Agent({ keepAlive: false, maxSockets: 1 }),
        headers: { 'user-agent': 'git-manager-netcheck', accept: '*/*' },
      },
      (res) => {
        res.resume(); // 丢弃响应体，避免占用连接
        finish(true, { status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false, { reason: 'timeout' });
    });
    req.on('error', (e) => finish(false, { reason: e.code || e.message }));
    req.end();
  });
}

/** TCP 握手：只作为诊断信息，不作判据 */
function tcpConnect(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, extra = {}) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, ...extra });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, { reason: 'timeout' }));
    sock.once('error', (e) => finish(false, { reason: e.code || e.message }));
    try {
      sock.connect(port, host);
    } catch (e) {
      finish(false, { reason: e.code || e.message });
    }
  });
}

async function resolveHost(host) {
  const started = Date.now();
  try {
    const addrs = await dns.lookup(host, { all: true });
    return { ok: true, ms: Date.now() - started, addresses: addrs.map((a) => a.address).slice(0, 3) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, reason: e.code || e.message };
  }
}

/** 探测：DNS + 真实 HTTPS 请求（+ TCP 作诊断），约 5 秒内出结果 */
export async function probe({ timeout = 5000 } = {}) {
  const results = await Promise.all(
    TARGETS.map(async (t) => {
      const dnsRes = await resolveHost(t.host);
      if (!dnsRes.ok) {
        return {
          key: t.key,
          host: t.host,
          label: t.label,
          enables: t.enables,
          dns: dnsRes,
          https: { ok: false, ms: 0, reason: 'dns-failed' },
          tcp: { ok: false, ms: 0, reason: 'dns-failed' },
          reachable: false,
          /** TCP 握手成功但 HTTPS 失败 → 典型的透明代理拦截 */
          suspicious: false,
        };
      }
      const [httpsRes, tcpRes] = await Promise.all([httpsCheck(t.host, t.path, timeout), tcpConnect(t.host, 443, timeout)]);
      return {
        key: t.key,
        host: t.host,
        label: t.label,
        enables: t.enables,
        dns: dnsRes,
        https: { ok: httpsRes.ok, ms: httpsRes.ms, status: httpsRes.status ?? null, reason: httpsRes.reason || null },
        tcp: { ok: tcpRes.ok, ms: tcpRes.ms, reason: tcpRes.reason || null },
        reachable: httpsRes.ok,
        suspicious: tcpRes.ok && !httpsRes.ok,
      };
    }),
  );

  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  const apiOk = by.api?.reachable;
  const webOk = by.web?.reachable;
  const suspicious = results.filter((r) => r.suspicious).map((r) => r.host);

  let verdict = 'ok';
  let summary = '网络正常，GitHub 全部功能可用。';
  if (!apiOk && !webOk) {
    verdict = 'offline';
    summary = '连不上任何 GitHub 域名，请检查网络或代理设置。';
  } else if (!webOk && apiOk) {
    verdict = 'partial';
    summary =
      '只能连通 GitHub API，连不上 github.com。' +
      '因此「读取仓库 / 提交文件」可用，但「OAuth 授权」与「git 克隆」不可用。';
  } else if (!apiOk && webOk) {
    verdict = 'partial';
    summary = '只能连通 github.com，连不上 API 域名，读取与提交功能会不可用。';
  }

  return {
    verdict,
    summary,
    checkedAt: new Date().toISOString(),
    targets: results,
    suspicious,
    proxy: proxyInfo(),
  };
}

function proxyInfo() {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const out = {};
  for (const k of keys) if (process.env[k]) out[k] = String(process.env[k]).replace(/\/\/[^@]*@/, '//***@');
  return {
    vars: out,
    // Node 的 fetch 基于 undici，默认不读这些环境变量 —— 这是非常容易踩的坑
    note: Object.keys(out).length
      ? '检测到代理环境变量。注意：Node 内置 fetch（undici）默认不读取它们，需显式配置 ProxyAgent 才会走代理。'
      : '未检测到代理环境变量，将直连。',
  };
}
