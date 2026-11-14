// 安全工具：控制台令牌、媒体 URL 签名、常量时间比较
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const MEDIA_URL_TTL_MS = 24 * 60 * 60 * 1000;

export function safeTokenEquals(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function canonicalMediaPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function signMediaPath(secret: Buffer, relativePath: string, expiresAt: number): string {
  return createHmac("sha256", secret)
    .update(canonicalMediaPath(relativePath) + "\n" + String(expiresAt))
    .digest("base64url");
}

export function verifyMediaPath(
  secret: Buffer,
  relativePath: string,
  expiresAt: number,
  signature: string
): boolean {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  if (!signature) return false;
  return safeTokenEquals(signMediaPath(secret, relativePath, expiresAt), signature);
}

/**
 * 读取或生成控制台令牌。环境变量优先于 config.json/调用方配置，
 * 否则从 configDir/console-token.txt 读取；不存在时生成并持久化。
 */
export function resolveConsoleToken(configDir: string, explicit?: string): string {
  const envToken = (process.env.CONSOLE_TOKEN ?? "").trim();
  const configured = envToken || (explicit ?? "").trim();
  if (configured) {
    if (configured.length < 16) throw new Error("CONSOLE_TOKEN 至少需要 16 个字符");
    return configured;
  }

  const tokenFile = path.join(configDir, "console-token.txt");
  try {
    const stored = fs.readFileSync(tokenFile, "utf8").trim();
    if (stored.length >= 16) return stored;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[security] 无法读取 ${tokenFile}: ${(error as Error).message}`);
    }
  }

  const token = randomBytes(24).toString("base64url");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，失败不影响功能
  }
  return token;
}
