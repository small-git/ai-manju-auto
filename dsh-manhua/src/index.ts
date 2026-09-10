/**
 * DeepSeek Harness plugin entry.
 * Load via: pnpm dsh web --patch ./dsh-manhua/cordis.yml
 *
 * Keys are managed in the toolbox:
 *   keys.status / keys.set / keys.unset / keys.set_settings
 * Config only stores credential references (apiKeyEnv-style), never literals.
 */
import { createRequire } from "node:module";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  Config as ConfigSchema,
  MANHUA_SETTINGS_NS,
  refsFromConfig,
  settingsFromConfig,
  type Config as PluginConfig,
} from "./plugin-config.js";
import { bindKeyRuntime, type CredentialLike } from "./keys.js";
import { toolSpecs } from "./tools/core.js";

export const name = "dsh-manhua";
export const inject = ["tools"];
export { ConfigSchema as Config };
export type { PluginConfig };

function wrapCredentials(ctx: Context): CredentialLike | undefined {
  const creds = (ctx as Context & { get?: (name: string) => unknown }).get?.("credentials") as
    | {
        resolve: (ref: unknown) => Promise<{ value: string; source?: string } | undefined>;
        describe: (ref: unknown) => Promise<{ configured: boolean; source?: string; writable?: boolean }>;
        set: (ref: unknown, value: string) => Promise<void>;
        unset: (ref: unknown) => Promise<void>;
      }
    | undefined;
  if (!creds) return undefined;

  const toRef = (name: string): unknown => {
    try {
      const req = createRequire(import.meta.url);
      const { credentialRef } = req("@deepseek-ai/dsh-credentials") as {
        credentialRef: (n: string) => unknown;
      };
      return credentialRef(name);
    } catch {
      return name;
    }
  };

  return {
    resolve: (ref) => creds.resolve(toRef(ref)),
    describe: (ref) => creds.describe(toRef(ref)),
    set: (ref, value) => creds.set(toRef(ref), value),
    unset: (ref) => creds.unset(toRef(ref)),
  };
}

function installSettings(ctx: Context, config: PluginConfig): void {
  if (!ConfigSchema) return;
  const settingsApi = (ctx as Context & { get?: (name: string) => unknown }).get?.("settings") as
    | {
        installSection: (
          owner: Context,
          ns: string,
          schema: unknown,
          entry: PluginConfig,
          hooks: {
            setSource: (source: () => PluginConfig) => void;
            onChange: () => void;
            expose?: string;
          },
        ) => void;
      }
    | undefined;
  if (!settingsApi?.installSection) return;

  let current: () => PluginConfig = () => config;
  settingsApi.installSection(ctx, MANHUA_SETTINGS_NS, ConfigSchema, config, {
    setSource: (source) => {
      current = source;
      bindKeyRuntime({
        refs: refsFromConfig(current()),
        settings: settingsFromConfig(current()),
      });
    },
    onChange: () => {
      bindKeyRuntime({
        refs: refsFromConfig(current()),
        settings: settingsFromConfig(current()),
      });
    },
    expose: "web",
  });
}

export function apply(ctx: Context, config: PluginConfig = {}): void {
  bindKeyRuntime({
    credentials: wrapCredentials(ctx),
    refs: refsFromConfig(config),
    settings: settingsFromConfig(config),
  });

  try {
    installSettings(ctx, config);
  } catch (err) {
    console.warn("[dsh-manhua] settings section skipped:", err instanceof Error ? err.message : err);
  }

  for (const spec of toolSpecs) {
    const title = (spec as { title?: string; name: string }).title || spec.name;
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args: unknown, value: Record<string, unknown>) => spec.render(args, value),
        },
        presentCall: () => ({
          card: "generic",
          title,
          kind: "search",
        }),
        presentResult: (_args: unknown, result: { isError?: boolean }) => ({
          card: "generic",
          title: result.isError ? `${title}（失败）` : `${title}（完成）`,
        }),
        async execute(args: Record<string, unknown>, exec: { signal: AbortSignal }) {
          const fn = spec.execute as (
            a: Record<string, unknown>,
            signal?: AbortSignal,
          ) => Promise<Record<string, unknown>>;
          return await fn(args, exec.signal);
        },
        timeoutMs: 30 * 60 * 1000,
      }),
    );
  }
  console.log(`[dsh-manhua] 已挂载中文工具: ${toolSpecs.map((t) => t.name).join("、")}`);
}
