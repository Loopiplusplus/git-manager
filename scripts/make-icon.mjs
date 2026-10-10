/**
 * 生成应用图标（PNG + ICO），无任何外部依赖。
 *
 * 为什么手写光栅化而不是找现成图标库 / 生成式模型：
 *  - 图标是**界面元素**，要精确贴合既有设计系统（苹果蓝 #0A84FF、圆角比例、留白），
 *    生成式模型给不出可控的几何与准确的品牌色；
 *  - 脚本化之后可复现、可改参、零成本，改配色不用重新出图。
 *
 * 产出：
 *   desktop/build/icon.ico   —— Windows 用（内嵌多尺寸 PNG，electron-builder 需要 ≥256）
 *   desktop/build/icon.png   —— 512px 通用位图（README / Linux / macOS 备用）
 *
 * 运行：node scripts/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'desktop', 'build');

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer(w*h*4)，输出 8 位带 alpha 的 PNG */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节（0 = None）
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 形状（归一化坐标 0..1 上判定）
 * ------------------------------------------------------------------ */

function inRoundedRect(x, y, l, t, r, b, rad) {
  if (x < l || x > r || y < t || y > b) return false;
  const qx = Math.max(l + rad - x, x - (r - rad), 0);
  const qy = Math.max(t + rad - y, y - (b - rad), 0);
  return qx * qx + qy * qy <= rad * rad;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 底板：苹果风圆角方（圆角比例沿用 macOS 图标的 ~22.4%） */
const PLATE = { pad: 0.025, radius: 0.225 };
function inPlate(x, y) {
  const p = PLATE.pad;
  return inRoundedRect(x, y, p, p, 1 - p, 1 - p, PLATE.radius * (1 - 2 * p));
}

/** 图形：git 分支 —— 主干两点 + 一条斜向分叉点 */
const TRUNK = { x: 0.345, y1: 0.225, y2: 0.775, halfW: 0.036 };
const BRANCH = { x1: 0.345, y1: 0.505, x2: 0.7, y2: 0.355, halfW: 0.036 };
const NODES = [
  { x: 0.345, y: 0.225, r: 0.088 },
  { x: 0.345, y: 0.775, r: 0.088 },
  { x: 0.7, y: 0.355, r: 0.076 },
];

function inGlyph(x, y) {
  for (const n of NODES) {
    if (Math.hypot(x - n.x, y - n.y) <= n.r) return true;
  }
  if (distToSeg(x, y, TRUNK.x, TRUNK.y1, TRUNK.x, TRUNK.y2) <= TRUNK.halfW) return true;
  if (distToSeg(x, y, BRANCH.x1, BRANCH.y1, BRANCH.x2, BRANCH.y2) <= BRANCH.halfW) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 颜色
 * ------------------------------------------------------------------ */

/** 苹果蓝家族，与 web/css/app.css 的 --accent 同源 */
const GRAD_TOP = [0x4f, 0xa8, 0xff];
const GRAD_BOT = [0x0a, 0x6b, 0xff];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 底色（含顶部高光，让圆角方有一点体积感） */
function plateColor(ny) {
  const t = Math.min(1, Math.max(0, ny));
  // 轻微缓出，避免下缘过暗
  const e = t * t * (3 - 2 * t);
  return [
    lerp(GRAD_TOP[0], GRAD_BOT[0], e),
    lerp(GRAD_TOP[1], GRAD_BOT[1], e),
    lerp(GRAD_TOP[2], GRAD_BOT[2], e),
  ];
}

const GLYPH_COLOR = [0xff, 0xff, 0xff];

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

const SS = 4; // 4x4 超采样做抗锯齿

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const inv = 1 / size;
  const step = 1 / (SS + 1);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let plateHit = 0;
      let glyphHit = 0;
      let colorAcc = [0, 0, 0];

      for (let sy = 1; sy <= SS; sy++) {
        for (let sx = 1; sx <= SS; sx++) {
          const nx = (px + sx * step) * inv;
          const ny = (py + sy * step) * inv;
          if (!inPlate(nx, ny)) continue;
          plateHit++;
          const c = plateColor(ny);
          colorAcc[0] += c[0];
          colorAcc[1] += c[1];
          colorAcc[2] += c[2];
          if (inGlyph(nx, ny)) glyphHit++;
        }
      }

      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (plateHit === 0) continue; // 全透明

      // 底板颜色（只对命中底板的采样求平均，避免边缘被透明像素拉黑）
      let r = colorAcc[0] / plateHit;
      let g = colorAcc[1] / plateHit;
      let b = colorAcc[2] / plateHit;

      // 图形以覆盖率叠加在底板之上
      const gc = glyphHit / plateHit;
      if (gc > 0) {
        r = lerp(r, GLYPH_COLOR[0], gc);
        g = lerp(g, GLYPH_COLOR[1], gc);
        b = lerp(b, GLYPH_COLOR[2], gc);
      }

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round((plateHit / total) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------------------------------------------ *
 * ICO 封装（内嵌 PNG，Vista 起支持）
 * ------------------------------------------------------------------ */

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;

  entries.forEach((e, idx) => {
    const o = idx * 16;
    // 256 必须写 0，这是 ICO 格式的历史约定
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // 调色板数
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const SIZES = [16, 24, 32, 48, 64, 128, 256];

fs.mkdirSync(OUT_DIR, { recursive: true });

const entries = SIZES.map((size) => ({ size, png: render(size) }));
const ico = buildIco(entries);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

const png512 = render(512);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

console.log('图标已生成：');
console.log(`  ${path.join(OUT_DIR, 'icon.ico')}  ${(ico.length / 1024).toFixed(1)} KB（内嵌 ${SIZES.join('/')} 共 ${SIZES.length} 个尺寸）`);
console.log(`  ${path.join(OUT_DIR, 'icon.png')}  ${(png512.length / 1024).toFixed(1)} KB（512×512）`);
