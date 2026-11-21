// 轻量级按大小轮转的日志流，避免长期运行把磁盘写满。
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";

export function createRotatingLogStream(file: string, maxBytes = 5 * 1024 * 1024, keep = 3): Writable {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function openStream(): fs.WriteStream {
    const next = fs.createWriteStream(file, { flags: "a" });
    // 磁盘满、权限变化等写入错误必须被消费，否则会成为未处理的 error 事件并终止进程。
    next.on("error", (error) => {
      console.error(`[log] 写入日志失败 ${file}: ${error.message}`);
    });
    return next;
  }

  let stream = openStream();

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
      stream = openStream();
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
