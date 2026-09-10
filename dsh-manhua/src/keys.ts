/**
 * Key management for the manhua toolbox.
 *
 * Priority when resolving a secret:
 *   1. Harness `ctx.credentials` (Settings / .credentials.yaml)
 *   2. Project local store `.manhua-secrets.json`（工具箱 keys.set 写入）
 *   3. process.env / .env
 *
 * Config only stores credential *references* (env names), never literal keys.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { REPO_ROOT, ensureDir } from "./paths.js";

let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  dotenv.config({ path: path.join(REPO_ROOT, ".env") });
  dotenv.config({ path: path.join(REPO_ROOT, "dsh-manhua", ".env") });
  envLoaded = true;
}

export const KEY_PROVIDERS = ["autodl", "openai", "gemini"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

export const DEFAULT_KEY_REFS: Record<KeyProvider, string> = {
  autodl: "AUTODL_API_TOKEN",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export type LocalSecrets = {
  version: 1;
  /** provider -> secret value */
  keys: Partial<Record<KeyProvider, string>>;
  /** optional non-secret overrides */
  settings?: {
    autodlBaseUrl?: string;
    openaiBaseUrl?: string;
    geminiBaseUrl?: string;
    openaiImageModel?: string;
    openaiChatModel?: string;
    geminiImageModel?: string;
    defaultResolution?: string;
    videoWorkflowId?: string;
    publicAssetBaseUrl?: string;
  };
};

export type CredentialLike = {
  resolve: (ref: string) => Promise<{ value: string; source?: string } | undefined>;
  describe: (ref: string) => Promise<{
    configured: boolean;
    source?: string;
    writable?: boolean;
  }>;
  set: (ref: string, value: string) => Promise<void>;
  unset: (ref: string) => Promise<void>;
};

type RuntimeBinding = {
  credentials?: CredentialLike;
  /** Live refs from plugin Config (Settings UI). */
  refs: Record<KeyProvider, string>;
  settings: NonNullable<LocalSecrets["settings"]>;
};

let binding: RuntimeBinding = {
  refs: { ...DEFAULT_KEY_REFS },
  settings: {},
};

export function secretsPath(): string {
  return path.join(REPO_ROOT, ".manhua-secrets.json");
}

export function bindKeyRuntime( partial: Partial<RuntimeBinding>): void {
  binding = {
    credentials: partial.credentials ?? binding.credentials,
    refs: { ...binding.refs, ...(partial.refs || {}) },
    settings: { ...binding.settings, ...(partial.settings || {}) },
  };
}

export function readLocalSecrets(): LocalSecrets {
  const p = secretsPath();
  if (!fs.existsSync(p)) return { version: 1, keys: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as LocalSecrets;
    return {
      version: 1,
      keys: raw.keys || {},
      settings: raw.settings || {},
    };
  } catch {
    return { version: 1, keys: {} };
  }
}

export function writeLocalSecrets(doc: LocalSecrets): void {
  ensureDir(path.dirname(secretsPath()));
  const cleaned: LocalSecrets = {
    version: 1,
    keys: {},
    settings: doc.settings,
  };
  for (const k of KEY_PROVIDERS) {
    const v = doc.keys[k]?.trim();
    if (v) cleaned.keys[k] = v;
  }
  fs.writeFileSync(secretsPath(), JSON.stringify(cleaned, null, 2), "utf8");
  try {
    fs.chmodSync(secretsPath(), 0o600);
  } catch {
    /* windows may ignore */
  }
}

export function refFor(provider: KeyProvider): string {
  return binding.refs[provider] || DEFAULT_KEY_REFS[provider];
}

export function parseProvider(raw: string): KeyProvider {
  const p = raw.trim().toLowerCase() as KeyProvider;
  if (!(KEY_PROVIDERS as readonly string[]).includes(p)) {
    throw new Error(`未知 provider: ${raw}（可选: ${KEY_PROVIDERS.join(", ")}）`);
  }
  return p;
}

/** Resolve secret for one provider. Never log the value. */
export async function resolveKey(provider: KeyProvider): Promise<{
  value: string;
  source: "credentials" | "local" | "env" | "missing";
  ref: string;
}> {
  ensureEnvLoaded();
  const ref = refFor(provider);
  if (binding.credentials) {
    const hit = await binding.credentials.resolve(ref);
    if (hit?.value?.trim()) {
      return { value: hit.value.trim(), source: "credentials", ref };
    }
  }
  const local = readLocalSecrets().keys[provider];
  if (local?.trim()) return { value: local.trim(), source: "local", ref };
  const env = process.env[ref];
  if (env?.trim()) return { value: env.trim(), source: "env", ref };
  return { value: "", source: "missing", ref };
}

export async function requireKey(provider: KeyProvider): Promise<string> {
  const hit = await resolveKey(provider);
  if (!hit.value) {
    throw new Error(
      `${provider} 密钥未配置。请在工具箱调用 keys.set（provider=${provider}），` +
        `或在 Harness Settings 填写；引用名: ${hit.ref}`,
    );
  }
  return hit.value;
}

export type KeyStatusRow = {
  provider: KeyProvider;
  ref: string;
  configured: boolean;
  source: string | null;
  writable: boolean;
};

export async function keysStatus(): Promise<{
  ok: true;
  secrets_file: string;
  keys: KeyStatusRow[];
  settings: NonNullable<LocalSecrets["settings"]>;
}> {
  ensureEnvLoaded();
  const local = readLocalSecrets();
  const rows: KeyStatusRow[] = [];
  for (const provider of KEY_PROVIDERS) {
    const ref = refFor(provider);
    if (binding.credentials) {
      const info = await binding.credentials.describe(ref);
      if (info.configured) {
        rows.push({
          provider,
          ref,
          configured: true,
          source: info.source || "credentials",
          writable: info.writable !== false,
        });
        continue;
      }
    }
    if (local.keys[provider]?.trim()) {
      rows.push({
        provider,
        ref,
        configured: true,
        source: "local",
        writable: true,
      });
      continue;
    }
    if (process.env[ref]?.trim()) {
      rows.push({
        provider,
        ref,
        configured: true,
        source: "env",
        writable: false,
      });
      continue;
    }
    rows.push({
      provider,
      ref,
      configured: false,
      source: null,
      writable: true,
    });
  }
  return {
    ok: true,
    secrets_file: secretsPath(),
    keys: rows,
    settings: {
      autodlBaseUrl: local.settings?.autodlBaseUrl || binding.settings.autodlBaseUrl || "https://autodl.art",
      openaiBaseUrl:
        local.settings?.openaiBaseUrl || binding.settings.openaiBaseUrl || "https://api.openai.com/v1",
      geminiBaseUrl:
        local.settings?.geminiBaseUrl ||
        binding.settings.geminiBaseUrl ||
        "https://generativelanguage.googleapis.com/v1beta",
      openaiImageModel:
        local.settings?.openaiImageModel || binding.settings.openaiImageModel || "gpt-image-1",
      openaiChatModel:
        local.settings?.openaiChatModel || binding.settings.openaiChatModel || "gpt-4o-mini",
      geminiImageModel:
        local.settings?.geminiImageModel ||
        binding.settings.geminiImageModel ||
        "gemini-3.1-flash-image",
      defaultResolution: local.settings?.defaultResolution || binding.settings.defaultResolution || "768p横",
      videoWorkflowId:
        local.settings?.videoWorkflowId ||
        binding.settings.videoWorkflowId ||
        "minimax_h3_lightx2v_v5",
      publicAssetBaseUrl: local.settings?.publicAssetBaseUrl || binding.settings.publicAssetBaseUrl || "",
    },
  };
}

export async function keysSet(providerRaw: string, value: string): Promise<{
  ok: true;
  provider: KeyProvider;
  ref: string;
  stored_in: "credentials" | "local";
  note: string;
}> {
  const provider = parseProvider(providerRaw);
  const v = value.trim();
  if (!v) throw new Error("密钥不能为空；清除请用 keys.unset");
  const ref = refFor(provider);

  if (binding.credentials) {
    try {
      await binding.credentials.set(ref, v);
      // also mirror local so CLI outside Harness still works
      const doc = readLocalSecrets();
      doc.keys[provider] = v;
      writeLocalSecrets(doc);
      return {
        ok: true,
        provider,
        ref,
        stored_in: "credentials",
        note: "已写入 Harness credentials，并镜像到 .manhua-secrets.json",
      };
    } catch (err) {
      // fall through to local if credential plane rejects (e.g. env-masked)
      const msg = err instanceof Error ? err.message : String(err);
      const doc = readLocalSecrets();
      doc.keys[provider] = v;
      writeLocalSecrets(doc);
      return {
        ok: true,
        provider,
        ref,
        stored_in: "local",
        note: `credentials.set 失败（${msg}），已写入 .manhua-secrets.json`,
      };
    }
  }

  const doc = readLocalSecrets();
  doc.keys[provider] = v;
  writeLocalSecrets(doc);
  return {
    ok: true,
    provider,
    ref,
    stored_in: "local",
    note: "已写入 .manhua-secrets.json（权限建议 600；已 gitignore）",
  };
}

export async function keysUnset(providerRaw: string): Promise<{
  ok: true;
  provider: KeyProvider;
  ref: string;
}> {
  const provider = parseProvider(providerRaw);
  const ref = refFor(provider);
  if (binding.credentials) {
    try {
      await binding.credentials.unset(ref);
    } catch {
      /* ignore */
    }
  }
  const doc = readLocalSecrets();
  delete doc.keys[provider];
  writeLocalSecrets(doc);
  return { ok: true, provider, ref };
}

export function mergedSettings(): NonNullable<LocalSecrets["settings"]> {
  const local = readLocalSecrets().settings || {};
  // Local workbench / keys.set_settings wins over plugin binding defaults.
  return { ...binding.settings, ...local };
}

export async function keysSetSettings(
  patch: NonNullable<LocalSecrets["settings"]>,
): Promise<{ ok: true; settings: NonNullable<LocalSecrets["settings"]> }> {
  const doc = readLocalSecrets();
  doc.settings = { ...(doc.settings || {}), ...patch };
  // drop empty strings (restore defaults); also clear from live binding
  for (const [k, v] of Object.entries(doc.settings)) {
    if (v === undefined || v === "") {
      delete (doc.settings as Record<string, unknown>)[k];
      delete (binding.settings as Record<string, unknown>)[k];
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === "") delete (binding.settings as Record<string, unknown>)[k];
  }
  writeLocalSecrets(doc);
  binding.settings = { ...binding.settings, ...doc.settings };
  return { ok: true, settings: (await keysStatus()).settings };
}
