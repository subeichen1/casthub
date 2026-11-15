// 生成桌面图标：纯色圆角方块 + 字母 C，四档 PNG，无图片处理原生依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngjs from "pngjs";

const { PNG } = pngjs;
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(DESKTOP_DIR, "assets");
const SIZES = [512, 256, 128, 32];
const BG = { r: 37, g: 99, b: 235 };
const FG = { r: 255, g: 255, b: 255 };

function insideRoundedRect(x, y, width, height, radius) {
  const dx = Math.abs(x - width / 2) - (width / 2 - radius);
  const dy = Math.abs(y - height / 2) - (height / 2 - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return ax * ax + ay * ay <= radius * radius;
}

function letterCCoverage(size, x, y) {
  const samples = 4;
  let hits = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      const dx = px - size / 2;
      const dy = py - size / 2;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const radius = size * 0.295;
      const stroke = size * 0.085;
      const angle = Math.atan2(dy, dx);
      // 右侧留 64° 缺口，形成 C 的开口
      const inRing = Math.abs(distance - radius) <= stroke / 2;
      const inGap = Math.abs(angle) < 0.56;
      if (inRing && !inGap) hits += 1;
    }
  }
  return hits / (samples * samples);
}

function makeIcon(size) {
  const png = new PNG({ width: size, height: size });
  const margin = size * 0.04;
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const inside =
        insideRoundedRect(x + 0.5, y + 0.5, size, size, radius) &&
        x + 0.5 >= margin &&
        x + 0.5 <= size - margin &&
        y + 0.5 >= margin &&
        y + 0.5 <= size - margin;
      if (!inside) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }
      const c = letterCCoverage(size, x, y);
      png.data[idx] = Math.round(BG.r + (FG.r - BG.r) * c);
      png.data[idx + 1] = Math.round(BG.g + (FG.g - BG.g) * c);
      png.data[idx + 2] = Math.round(BG.b + (FG.b - BG.b) * c);
      png.data[idx + 3] = 255;
    }
  }
  return png;
}

fs.mkdirSync(ASSETS_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(ASSETS_DIR, `icon-${size}.png`);
  const buffer = PNG.sync.write(makeIcon(size));
  fs.writeFileSync(file, buffer);
  const header = fs.readFileSync(file).subarray(0, 8).toString("hex");
  console.log(`${file} bytes=${buffer.length} header=${header} dims=${size}x${size}`);
}
