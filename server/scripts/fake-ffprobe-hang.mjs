#!/usr/bin/env node
// 模拟卡死的 ffprobe：永不输出内容，用于验证 15s 超时保护。
setInterval(() => {}, 1000);
