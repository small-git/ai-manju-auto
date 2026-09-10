/**
 * 文案账本：主线/小说 → 续写/反转草稿，独立于成片资产。
 * 落盘：stories/<story_id>/writing.json
 */
import fs from "node:fs";
import path from "node:path";
import { STORIES_DIR, ensureDir } from "../paths.js";

export type WritingKind = "seed" | "continue" | "twist" | "revise";

export type WritingDraft = {
  id: string;
  kind: WritingKind;
  instruction?: string;
  content: string;
  created_at: string;
};

export type WritingLedger = {
  version: 1;
  story_id: string;
  title?: string;
  /** 当前正典正文（主线 / 小说累计稿） */
  source_text: string;
  logline?: string;
  drafts: WritingDraft[];
  active_draft_id?: string | null;
  updated_at?: string;
};

export function writingPath(storyId: string): string {
  return path.join(STORIES_DIR, storyId, "writing.json");
}

function nowId(kind: WritingKind): string {
  const t = new Date();
  const stamp = t.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${kind}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyWriting(storyId: string, partial?: Partial<WritingLedger>): WritingLedger {
  return {
    version: 1,
    story_id: storyId,
    title: partial?.title,
    source_text: partial?.source_text || "",
    logline: partial?.logline || "",
    drafts: partial?.drafts || [],
    active_draft_id: partial?.active_draft_id ?? null,
    updated_at: new Date().toISOString(),
  };
}

export function loadWriting(storyId: string): WritingLedger {
  if (!storyId?.trim()) throw new Error("story_id 必填");
  const p = writingPath(storyId);
  if (!fs.existsSync(p)) return emptyWriting(storyId);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as WritingLedger;
    return {
      version: 1,
      story_id: storyId,
      title: raw.title,
      source_text: raw.source_text || "",
      logline: raw.logline || "",
      drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
      active_draft_id: raw.active_draft_id ?? null,
      updated_at: raw.updated_at,
    };
  } catch {
    return emptyWriting(storyId);
  }
}

export function saveWriting(doc: WritingLedger): string {
  const p = writingPath(doc.story_id);
  ensureDir(path.dirname(p));
  doc.version = 1;
  doc.updated_at = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), "utf8");
  return p;
}

export function appendDraft(
  doc: WritingLedger,
  kind: WritingKind,
  content: string,
  instruction?: string,
): WritingDraft {
  const draft: WritingDraft = {
    id: nowId(kind),
    kind,
    instruction: instruction?.trim() || undefined,
    content: content.trim(),
    created_at: new Date().toISOString(),
  };
  doc.drafts = [...(doc.drafts || []), draft].slice(-40);
  doc.active_draft_id = draft.id;
  return draft;
}

export function getActiveDraft(doc: WritingLedger): WritingDraft | null {
  if (!doc.active_draft_id) return doc.drafts[doc.drafts.length - 1] || null;
  return doc.drafts.find((d) => d.id === doc.active_draft_id) || null;
}

/** 采用草稿为正文（可覆盖或追加） */
export function adoptDraft(
  doc: WritingLedger,
  draftId: string | undefined,
  mode: "replace" | "append" = "replace",
): WritingLedger {
  const draft = draftId
    ? doc.drafts.find((d) => d.id === draftId)
    : getActiveDraft(doc);
  if (!draft?.content) throw new Error("没有可采用的文案草稿");
  if (mode === "append" && doc.source_text.trim()) {
    doc.source_text = `${doc.source_text.trim()}\n\n${draft.content.trim()}`;
  } else {
    doc.source_text = draft.content.trim();
  }
  doc.active_draft_id = draft.id;
  return doc;
}
