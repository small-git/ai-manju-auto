#!/usr/bin/env node
/**
 * 漫剧工具箱 CLI（P0–P3，不依赖 Harness）
 *
 *   pnpm cli -- 漫剧_使用说明
 *   pnpm cli -- 漫剧_加载故事 --story_id overtime_system
 *   pnpm cli -- 漫剧_齐套检查 --story_id overtime_system
 */
import { toolSpecs } from "./tools/core.js";

type Spec = (typeof toolSpecs)[number];

const byName = new Map<string, Spec>(toolSpecs.map((t) => [t.name, t]));

const ALIASES: Record<string, string> = {
  help: "漫剧_使用说明",
  "keys.status": "漫剧_查看密钥",
  "keys.set": "漫剧_写入密钥",
  "keys.unset": "漫剧_清除密钥",
  "story.load": "漫剧_加载故事",
  "gate.check": "漫剧_齐套检查",
  "plan.update": "漫剧_计划预审",
  "chapter.pipeline": "漫剧_章节流水线",
};

function usage(): never {
  console.log(`用法:
  node --import tsx src/cli.ts <工具名> [--key value ...]

常用:
  漫剧_使用说明
  漫剧_加载故事 --story_id <id>
  漫剧_齐套检查 --story_id <id>
  漫剧_计划预审 --story_id <id> --shot_id <id> --plan_path bridge
  漫剧_自动Bridge --story_id <id>
  漫剧_GPT定妆 --story_id <id> --character_id <C01>
  漫剧_Gemini分镜 --story_id <id> --shot_id <id> [--as_grid]
  漫剧_AutoDL成片 --story_id <id> --shot_id <id> [--force]
  漫剧_章节流水线 --story_id <id>
  漫剧_导出时间线 --story_id <id>
  漫剧_导出ZIP --story_id <id>

全部工具:
${toolSpecs.map((t) => `  ${t.name}`).join("\n")}
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-/g, "_");
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i += 1;
    if (next === "true") out[key] = true;
    else if (next === "false") out[key] = false;
    else if (/^\d+$/.test(next)) out[key] = Number(next);
    else out[key] = next;
  }
  // convenience aliases
  if (out.story && !out.story_id) out.story_id = out.story;
  if (out.shot && !out.shot_id) out.shot_id = out.shot;
  if (out.character && !out.character_id) out.character_id = out.character;
  return out;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw || raw === "-h" || raw === "--help") usage();
  const toolName = ALIASES[raw] || raw;
  const spec = byName.get(toolName);
  if (!spec) {
    console.error(`未知工具: ${toolName}`);
    usage();
  }
  const args = parseArgs(process.argv.slice(3));
  const result = await (spec.execute as (a: Record<string, unknown>) => Promise<Record<string, unknown>>)(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
