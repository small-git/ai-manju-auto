import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** repo root: autodl-manhua-pipeline */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const STORIES_DIR = path.join(REPO_ROOT, "stories");
export const RUNS_DIR = path.join(REPO_ROOT, "runs");

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
