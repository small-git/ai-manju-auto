import fs from "node:fs";
import { fail, info, warn } from "../zh-log.js";

export type RetryOpts = {
  retries?: number;
  delayMs?: number;
  label?: string;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1500;
  const label = opts.label || "任务";
  let lastErr: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= retries) break;
      const msg = err instanceof Error ? err.message : String(err);
      warn("重试", `${label} 第 ${i}/${retries} 次失败，准备重试`, { error: msg });
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  fail("重试", `${label} 已用尽 ${retries} 次重试`, { error: finalMsg });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 已有成片则跳过（补全并生成） */
export function shouldSkipExisting(existingPath: string | null | undefined, force?: boolean): boolean {
  if (force) return false;
  const skip = !!existingPath && fs.existsSync(existingPath);
  if (skip) info("跳过", "检测到已有成片", { path: existingPath });
  return skip;
}
