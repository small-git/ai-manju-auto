import fs from "node:fs";

export type RetryOpts = {
  retries?: number;
  delayMs?: number;
  label?: string;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1500;
  const label = opts.label || "task";
  let lastErr: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= retries) break;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`[retry ${i}/${retries}] ${label}: ${msg}\n`);
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 已有成片则跳过（补全并生成） */
export function shouldSkipExisting(existingPath: string | null | undefined, force?: boolean): boolean {
  if (force) return false;
  return !!existingPath && fs.existsSync(existingPath);
}
