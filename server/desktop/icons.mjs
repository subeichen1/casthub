// 生成桌面图标：纯色圆角方块 + 字母 C，多档 PNG + ICO，无图片处理原生依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngjs from "pngjs";

const { PNG } = pngjs;
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(DESKTOP_DIR, "assets");
const PNG_SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = { r: 37, g: 99, b: 235 };
const FG = { r: 255, g: 255, b: 255 };

function insideRoundedRect(x, y, size, radius, margin) {
  const left = margin;
  const top = margin;
  const right = size - margin;
  const bottom = size - margin;
  if (x < left || x > right || y < top || y > bottom) return false;
  const dx = Math.abs(x - size / 2) - (size / 2 - margin - radius);
  const dy = Math.abs(y - size / 2) - (size / 2 - margin - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return ax * ax + ay * ay <= radius * radius;
}

function inLetterC(px, py, size) {
  const dx = px - size / 2;
  const dy = py - size / 2;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const radius = size * 0.295;
  const stroke = size * 0.085;
  const angle = Math.atan2(dy, dx);
  // 右侧留 64° 缺口，形成 C 的开口
  const inRing = Math.abs(distance - radius) <= stroke / 2;
  const inGap = Math.abs(angle) < 0.56;
  return inRing && !inGap;
}

function makeIcon(size) {
  const png = new PNG({ width: size, height: size });
  const margin = size * 0.04;
  const radius = size * 0.22;
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      let inside = 0;
      let cHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (!insideRoundedRect(px, py, size, radius, margin)) continue;
          inside += 1;
          if (inLetterC(px, py, size)) cHits += 1;
        }
      }
      if (inside === 0) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }
      const c = cHits / inside;
      png.data[idx] = Math.round(BG.r + (FG.r - BG.r) * c);
      png.data[idx + 1] = Math.round(BG.g + (FG.g - BG.g) * c);
      png.data[idx + 2] = Math.round(BG.b + (FG.b - BG.b) * c);
      png.data[idx + 3] = Math.round((inside / (samples * samples)) * 255);
    }
  }
  return png;
}

function makeIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i += 1) {
    const { size, buffer } = pngBuffers[i];
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(buffer.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += buffer.length;
  }
  return Buffer.concat([header, ...pngBuffers.map((item) => item.buffer)]);
}

fs.mkdirSync(ASSETS_DIR, { recursive: true });
const buffers = new Map();
for (const size of PNG_SIZES) {
  const buffer = PNG.sync.write(makeIcon(size));
  buffers.set(size, buffer);
  const name = size === 1024 ? "icon.png" : `icon-${size}.png`;
  const file = path.join(ASSETS_DIR, name);
  fs.writeFileSync(file, buffer);
  console.log(`${file} bytes=${buffer.length} dims=${size}x${size}`);
}

const ico = makeIco(ICO_SIZES.map((size) => ({ size, buffer: buffers.get(size) })));
const icoPath = path.join(ASSETS_DIR, "icon.ico");
fs.writeFileSync(icoPath, ico);
console.log(`${icoPath} bytes=${ico.length} sizes=${ICO_SIZES.join(",")}`);
