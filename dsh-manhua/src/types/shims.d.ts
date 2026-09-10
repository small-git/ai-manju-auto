/** Optional shims when peer packages are not installed locally (CLI-only workflow). */
declare module "@deepseek-ai/cordis" {
  export type Context = {
    tools: {
      register: (definition: unknown) => () => void;
    };
    get?: (name: string) => unknown;
  };
}

declare module "@deepseek-ai/dsh-tools" {
  export function defineTool(definition: Record<string, unknown>): unknown;
}

declare module "@deepseek-ai/dsh-credentials" {
  export function credentialRef(name: string): unknown;
}

declare module "@deepseek-ai/dsh-settings" {
  export function settingsNamespace(name: string): string;
}

declare module "@deepseek-ai/schemastery" {
  type Chain = {
    role: (r: string) => Chain;
    default: (v: unknown) => Chain;
  };
  type Builder = {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => Chain;
    number: () => Chain;
  };
  const z: Builder;
  export default z;
  export type z<T = unknown> = T;
}
