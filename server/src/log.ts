// 轻量级按大小轮转的日志流，避免长期运行把磁盘写满。
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";

export function createRotatingLogStream(file: string, maxBytes = 5 * 1024 * 1024, keep = 3): Writable {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stream = fs.createWriteStream(file, { flags: "a" });

  function rotateFiles(): void {
    const oldest = `${file}.${keep}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  }

  function rotate(next: () => void): void {
    const previous = stream;
    // 等旧流真正关闭后再 rename，避免 Windows 上文件仍被占用导致轮转失败。
    previous.end(() => {
      try {
        rotateFiles();
      } catch {
        // 轮转失败时继续写原文件，不能影响主流程。
      }
      stream = fs.createWriteStream(file, { flags: "a" });
      next();
    });
  }

  return new Writable({
    write(chunk, encoding, callback) {
      if (stream.bytesWritten >= maxBytes) {
        rotate(() => stream.write(chunk, encoding, callback));
      } else {
        stream.write(chunk, encoding, callback);
      }
    },
    final(callback) {
      stream.end(callback);
    }
  });
}
