/**
 * Lightweight connectivity probes for key management UI.
 * Never logs secret values.
 */
import { loadConfig } from "../config.js";
import { parseProvider, requireKey, type KeyProvider } from "../keys.js";

export type ProbeResult = {
  ok: true;
  reachable: boolean;
  provider: KeyProvider;
  latency_ms: number;
  endpoint: string;
  message: string;
  http_status?: number;
  detail?: string;
};

function truncate(s: string, n = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function readBody(resp: Response): Promise<string> {
  try {
    return truncate(await resp.text());
  } catch {
    return "";
  }
}

export async function probeProvider(providerRaw: string): Promise<ProbeResult> {
  const provider = parseProvider(providerRaw);
  const cfg = loadConfig();
  const started = Date.now();
  const signal = AbortSignal.timeout(20_000);

  try {
    if (provider === "openai") {
      const key = await requireKey("openai");
      const endpoint = `${cfg.openaiBaseUrl}/models`;
      const resp = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal,
      });
      const body = await readBody(resp);
      if (!resp.ok) {
        return {
          ok: true,
          reachable: false,
          provider,
          latency_ms: Date.now() - started,
          endpoint,
          http_status: resp.status,
          message: `OpenAI 不通（HTTP ${resp.status}）`,
          detail: body,
        };
      }
      return {
        ok: true,
        reachable: true,
        provider,
        latency_ms: Date.now() - started,
        endpoint,
        http_status: resp.status,
        message: `OpenAI 连通 · ${cfg.openaiImageModel} / chat`,
      };
    }

    if (provider === "gemini") {
      const key = await requireKey("gemini");
      let base = cfg.geminiBaseUrl.replace(/\/$/, "");
      if (/^https?:\/\/[^/]+$/i.test(base)) base = `${base}/v1beta`;
      else if (base.endsWith("/v1")) base = `${base.slice(0, -3)}/v1beta`;
      const endpoint = `${base}/models?pageSize=1&key=${encodeURIComponent(key)}`;
      const displayEndpoint = `${base}/models?pageSize=1`;
      const resp = await fetch(endpoint, { method: "GET", headers: { Accept: "application/json" }, signal });
      const body = await readBody(resp);
      if (!resp.ok) {
        return {
          ok: true,
          reachable: false,
          provider,
          latency_ms: Date.now() - started,
          endpoint: displayEndpoint,
          http_status: resp.status,
          message: `Gemini 不通（HTTP ${resp.status}）`,
          detail: body,
        };
      }
      return {
        ok: true,
        reachable: true,
        provider,
        latency_ms: Date.now() - started,
        endpoint: displayEndpoint,
        http_status: resp.status,
        message: `Gemini 连通 · ${cfg.geminiImageModel}`,
      };
    }

    // autodl: probe result endpoint with dummy task — auth OK if not 401/403
    {
      const token = await requireKey("autodl");
      const endpoint = `${cfg.autodlBaseUrl}/api/v1/comfyui/comfyui_workflow/result/__manhua_probe__`;
      const resp = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: token,
          Accept: "application/json",
        },
        signal,
      });
      const body = await readBody(resp);
      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: true,
          reachable: false,
          provider,
          latency_ms: Date.now() - started,
          endpoint,
          http_status: resp.status,
          message: `AutoDL 鉴权失败（HTTP ${resp.status}）`,
          detail: body,
        };
      }
      // 404 / business error still means host + token path are reachable
      return {
        ok: true,
        reachable: true,
        provider,
        latency_ms: Date.now() - started,
        endpoint,
        http_status: resp.status,
        message: `AutoDL 连通 · workflow ${cfg.defaultVideoWorkflowId}`,
        detail: body || undefined,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: true,
      reachable: false,
      provider,
      latency_ms: Date.now() - started,
      endpoint: "",
      message: `${provider} 探测失败`,
      detail: truncate(msg),
    };
  }
}
