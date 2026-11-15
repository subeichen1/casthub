// 从 icon-source.png 生成桌面图标：多档 PNG + ICO，无图片处理原生依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngjs from "pngjs";

const { PNG } = pngjs;
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(DESKTOP_DIR, "assets");
const SOURCE = path.join(ASSETS_DIR, "icon-source.png");
const PNG_SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function resize(source, size) {
  const dst = new PNG({ width: size, height: size });
  const scaleX = source.width / size;
  const scaleY = source.height / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = y * scaleY;
    const y1 = y0 + scaleY;
    for (let x = 0; x < size; x += 1) {
      const x0 = x * scaleX;
      const x1 = x0 + scaleX;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let weightSum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const idx = (source.width * sy + sx) << 2;
          const alpha = source.data[idx + 3] / 255;
          rSum += source.data[idx] * alpha * weight;
          gSum += source.data[idx + 1] * alpha * weight;
          bSum += source.data[idx + 2] * alpha * weight;
          aSum += alpha * weight;
          weightSum += weight;
        }
      }
      const idx = (size * y + x) << 2;
      if (aSum <= 0 || weightSum <= 0) {
        dst.data[idx] = 0;
        dst.data[idx + 1] = 0;
        dst.data[idx + 2] = 0;
        dst.data[idx + 3] = 0;
        continue;
      }
      dst.data[idx] = Math.round(rSum / aSum);
      dst.data[idx + 1] = Math.round(gSum / aSum);
      dst.data[idx + 2] = Math.round(bSum / aSum);
      dst.data[idx + 3] = Math.round((aSum / weightSum) * 255);
    }
  }
  return dst;
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
const source = PNG.sync.read(fs.readFileSync(SOURCE));
const buffers = new Map();
for (const size of PNG_SIZES) {
  let buffer;
  if (size === source.width && size === source.height) {
    buffer = fs.readFileSync(SOURCE);
  } else {
    buffer = PNG.sync.write(resize(source, size));
  }
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
