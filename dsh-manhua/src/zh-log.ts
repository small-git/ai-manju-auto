/** 中文运行日志：标明当前跑到哪一步、哪里出问题。 */

function fmt(extra?: Record<string, unknown>): string {
  if (!extra || !Object.keys(extra).length) return "";
  return (
    " | " +
    Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
  );
}

export function step(module: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(`[进行中][${module}] ${msg}${fmt(extra)}`);
}

export function info(module: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(`[信息][${module}] ${msg}${fmt(extra)}`);
}

export function ok(module: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(`[完成][${module}] ${msg}${fmt(extra)}`);
}

export function fail(module: string, msg: string, extra?: Record<string, unknown>): void {
  console.error(`[失败][${module}] 失败于：${msg}${fmt(extra)}`);
}

export function warn(module: string, msg: string, extra?: Record<string, unknown>): void {
  console.warn(`[警告][${module}] ${msg}${fmt(extra)}`);
}
