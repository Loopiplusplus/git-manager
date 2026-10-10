/**
 * 网络连通性探测：确认 GitHub 的各个域名是否可达，
 * 并比对 curl（走代理）与 Node fetch（undici，默认无视代理环境变量）的差异。
 */
import { execFile } from 'node:child_process';

const HOSTS = [
  'https://api.github.com/rate_limit',
  'https://github.com/',
  'https://github.com/login/device/code',
  'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack',
  'https://codeload.github.com/',
];

function curl(url, timeoutSec = 12) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '-m', String(timeoutSec), '-o', '/dev/null', '-w', '%{http_code}|%{time_total}', url],
      { timeout: (timeoutSec + 6) * 1000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? `ERR:${err.message.slice(0, 40)}` : String(stdout).trim()),
    );
  });
}

async function nodeFetch(url, timeoutMs = 12000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return `${res.status}|${((Date.now() - t0) / 1000).toFixed(2)}`;
  } catch (e) {
    return `ERR:${(e.cause?.code || e.name || 'fail')}`;
  }
}

console.log('代理环境变量:');
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  if (process.env[k]) console.log(`  ${k} = ${process.env[k]}`);
}
console.log('');

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('URL', 56) + pad('curl(走代理)', 30) + 'Node fetch(undici)');
console.log('-'.repeat(112));

for (const u of HOSTS) {
  const [c, n] = await Promise.all([curl(u), nodeFetch(u)]);
  const short = u.length > 54 ? u.slice(0, 53) + '…' : u;
  console.log(pad(short, 56) + pad(c, 30) + n);
}

console.log('');
console.log('注：Node 的 fetch 基于 undici，默认**不读取** HTTP_PROXY/HTTPS_PROXY 环境变量，');
console.log('    需要显式配置 ProxyAgent 才会走代理。若此处 curl 通而 Node 不通，即为该原因。');
