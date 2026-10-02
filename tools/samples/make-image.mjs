/**
 * 生成示例文档里用的配图。
 *
 * 本机没有图像库，也不想为一个占位图引入依赖，所以直接手写最小 PNG 编码器。
 * 画的是一张色板示意：烟雨江南的四个源色。
 *
 *   node tools/samples/make-image.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- 最小 PNG 编码 ---------------- */

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                       // 每行一个 filter 字节，0 = 不过滤
    for (let x = 0; x < width; x++) {
      const c = rgbAt(x, y);
      raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 2;   // 真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 绘制 ---------------- */

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const W = 900, H = 420;

const BG_FROM = hex('#f9faf4');   // 纸白
const BG_TO = hex('#dfe8ee');     // 雾蓝的极浅调，用来做背景渐变
const SWATCHES = ['#f9faf4', '#758ea2', '#cfd3d4', '#cee0ba'].map(hex);

const CX = [150, 350, 550, 750];
const CY = 160;
const R = 90;
const DIAMOND_Y = 336;

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function rgbAt(x, y) {
  /* 背景：左上到右下的斜向渐变 */
  const t = Math.min(1, Math.max(0, (x / W) * 0.65 + (y / H) * 0.35));
  let c = mix(BG_FROM, BG_TO, t);

  /* 下半部分的菱形，位置在两圆之间，作为"色卡"的点缀 */
  for (let i = 0; i < 4; i++) {
    const dx = Math.abs(x - CX[i]);
    const dy = Math.abs(y - DIAMOND_Y);
    if (dx + dy <= 26) {
      c = mix(c, SWATCHES[i], 0.92);
      /* 视觉上压一层，避免和圆形抢注意力 */
      c = mix(c, BG_FROM, 0.06);
    }
  }

  /* 四个圆 */
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(x - CX[i], y - CY);
    if (d <= R) {
      /* 圆形内部给一点极轻的纵向渐变，看起来是"实体"而不是色块 */
      const k = 0.94 + 0.06 * (1 - (y - (CY - R)) / (2 * R));
      c = SWATCHES[i].map((v) => Math.round(v * k));
      /* 纸白那一枚需要描边，否则和背景糊在一起 */
      if (i === 0 && d > R - 2) c = mix(BG_TO, SWATCHES[0], 0.35);
    } else if (d <= R + 7) {
      /* 外圈一圈极淡的投影 */
      const a = (1 - (d - R) / 7) * 0.10;
      c = mix(c, [60, 80, 95], a);
    }
  }

  return c;
}

const out = path.join(import.meta.dirname, 'preview-cover.png');
fs.writeFileSync(out, encodePng(W, H, rgbAt));
console.log(`已生成 ${path.relative(process.cwd(), out)}  ${W}x${H}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
