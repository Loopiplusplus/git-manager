/**
 * GitHub 授权面板的轮询循环测试。
 *
 * 为什么单独有这个脚本：
 * check-oauth 测的是**服务端**状态机（fetch 替身），check-ui 测的是 render 纯函数，
 * 两边都不碰 palette.js 里那段由定时器驱动的轮询。结果就是 —— 一个让整个 OAuth
 * 流程完全失效的 bug（见下）在 200+ 项测试全绿的情况下溜了过去。
 *
 * 曾经的真 bug：
 *   tick() 里用 mount() 重绘。而 mount() 会先调用「上一个面板」的 dispose，
 *   本面板的 dispose 恰恰是 stopGhPoll() —— 于是**第一次轮询就把自己清掉了**
 *   （清定时器 + 清 ghSession + 取消服务端会话）。
 *   症状：用户在 GitHub 上明明授权成功，界面永远停在等待设备码那一步。
 *
 * 本脚本用最小 DOM 桩 + 手动定时器队列，把这条链路真正跑起来。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    hidden: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
}

const overlay = makeEl();

globalThis.window = globalThis.window || { __GM__: { token: 'test-token', apiBase: '/api' } };
globalThis.window.open = () => null;

// Node 22 里 globalThis.navigator 是只读 getter，只能 defineProperty
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

globalThis.document = {
  // 只认 #overlay；#toasts 返回 null 让 toast() 自然短路
  querySelector: (sel) => (sel === '#overlay' ? overlay : null),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: (t) => makeEl(t),
};

/* ---------- 手动定时器队列（让轮询瞬间可驱动，不用真的等） ---------- */
const timers = [];
let timerSeq = 0;
globalThis.setTimeout = (fn, ms) => {
  const id = ++timerSeq;
  timers.push({ id, fn, ms });
  return id;
};
globalThis.clearTimeout = (id) => {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
};

/** 执行队列里最早的一个定时器回调（tick 是 async，这里会等它内部全部跑完） */
async function step() {
  if (!timers.length) return false;
  const t = timers.shift();
  await t.fn();
  return true;
}

/* ---------- 加载被测模块，并替换掉 api 层 ---------- */
const apiMod = await import(pathToFileURL(path.join(ROOT, 'web/js/api.js')).href);
const palette = await import(pathToFileURL(path.join(ROOT, 'web/js/palette.js')).href);
const api = apiMod.api;

let pollCalls = 0;
let cancelCalls = 0;
let refreshed = 0;

const baseSession = (over = {}) => ({
  id: 'S1',
  status: 'pending',
  userCode: '10AF-6540',
  verificationUri: 'https://github.com/login/device',
  interval: 1,
  expiresIn: 900,
  scopes: 'read:user repo read:org',
  scopeMode: 'write',
  ...over,
});

function reset() {
  timers.length = 0;
  pollCalls = 0;
  cancelCalls = 0;
  refreshed = 0;
  overlay.innerHTML = '';
  overlay.hidden = true;
}

const ctx = { state: { ghScope: 'write' }, refresh: () => { refreshed += 1; } };

api.ghDeviceCancel = async () => {
  cancelCalls += 1;
  return { ok: true };
};

/* ============================================================
   1. 正常授权：轮询必须活下去，直到拿到 token
   ============================================================ */
console.log('[1] 正常授权：等待 → 等待 → 成功');
{
  reset();
  api.ghDeviceStart = async () => baseSession();
  api.ghDevicePoll = async () => {
    pollCalls += 1;
    if (pollCalls < 3) return baseSession({ expiresIn: 900 - pollCalls });
    return baseSession({ status: 'ok', viewer: { login: 'octocat', scopes: ['repo'] } });
  };

  await palette.openGithubAuthorize(ctx);

  check('已进入等待态并显示设备码', overlay.innerHTML.includes('10AF-6540'));
  check('已排定首次轮询', timers.length === 1, `timers=${timers.length}`);

  await step(); // 第 1 次轮询 → pending
  check('★ 第 1 次轮询后仍在等待（没有被自己的 dispose 清掉）', timers.length === 1, `timers=${timers.length}`);
  check('★ 第 1 次轮询后没有取消服务端会话', cancelCalls === 0, `cancelCalls=${cancelCalls}`);
  check('第 1 次轮询确实打到了接口', pollCalls === 1, `pollCalls=${pollCalls}`);

  await step(); // 第 2 次轮询 → pending
  check('第 2 次轮询后仍在等待', timers.length === 1, `timers=${timers.length}`);
  check('轮询在持续推进（不是只有一次）', pollCalls === 2, `pollCalls=${pollCalls}`);

  await step(); // 第 3 次轮询 → ok
  check('第 3 次轮询拿到 token', pollCalls === 3, `pollCalls=${pollCalls}`);
  check('成功态显示已连接的账号', overlay.innerHTML.includes('octocat'), overlay.innerHTML.slice(0, 120));
  check('成功后通知上层刷新', refreshed === 1, `refreshed=${refreshed}`);
  check('成功后不再继续轮询', timers.length === 0, `timers=${timers.length}`);
  check('正常流程中从未取消会话', cancelCalls === 0, `cancelCalls=${cancelCalls}`);
}

/* ============================================================
   2. 网络闪断：不能一次抖动就毁掉整个授权
   ============================================================ */
console.log('\n[2] 网络闪断（本机代理不稳时很常见）');
{
  reset();
  let n = 0;
  api.ghDeviceStart = async () => baseSession();
  api.ghDevicePoll = async () => {
    n += 1;
    if (n <= 2) {
      const e = new Error('请求失败（0）');
      e.status = 0; // 非 404：属于可重试的传输层错误
      throw e;
    }
    return baseSession({ status: 'ok', viewer: { login: 'octocat', scopes: ['repo'] } });
  };

  await palette.openGithubAuthorize(ctx);
  await step(); // 第 1 次失败
  check('★ 单次闪断后流程仍然存活', timers.length === 1, `timers=${timers.length}`);
  check('闪断后没有误判成会话失效', !overlay.innerHTML.includes('授权会话已失效'));

  await step(); // 第 2 次失败
  check('★ 两次闪断后仍然存活', timers.length === 1, `timers=${timers.length}`);

  await step(); // 第 3 次成功
  check('闪断恢复后能成功完成授权', refreshed === 1, `refreshed=${refreshed}`);
  check('成功后停止轮询', timers.length === 0);
}

/* ============================================================
   3. 会话真的没了（404）：给出明确提示，别让用户干等
   ============================================================ */
console.log('\n[3] 授权会话失效（例如本地服务重启过）');
{
  reset();
  api.ghDeviceStart = async () => baseSession();
  api.ghDevicePoll = async () => {
    const e = new Error('授权会话不存在或已过期，请重新发起');
    e.status = 404;
    throw e;
  };

  await palette.openGithubAuthorize(ctx);
  await step();

  check('给出「会话已失效」的明确提示', overlay.innerHTML.includes('授权会话已失效'), overlay.innerHTML.slice(0, 120));
  check('提示里建议重新发起', overlay.innerHTML.includes('重新发起'));
  check('失效后不再继续轮询', timers.length === 0, `timers=${timers.length}`);
  check('失效时不显示为成功', refreshed === 0);
}

/* ============================================================
   4. 连续失败：最终要停下并如实告知，而不是无限重试
   ============================================================ */
console.log('\n[4] 连续失败最终停止');
{
  reset();
  api.ghDeviceStart = async () => baseSession();
  api.ghDevicePoll = async () => {
    const e = new Error('请求失败（0）');
    e.status = 0;
    throw e;
  };

  await palette.openGithubAuthorize(ctx);
  for (let i = 1; i <= 4; i += 1) {
    await step();
    check(`第 ${i} 次失败后仍会重试`, timers.length === 1, `timers=${timers.length}`);
  }
  await step(); // 第 5 次 → 达到上限
  check('达到重试上限后停止', timers.length === 0, `timers=${timers.length}`);
  check('停止时给出「授权中断」提示', overlay.innerHTML.includes('授权中断'));
}

console.log('');
console.log('='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0 ? '全部通过 ✓' : '存在失败 ✗');
process.exit(fail === 0 ? 0 : 1);
