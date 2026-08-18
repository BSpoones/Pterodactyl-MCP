import { statSync } from "node:fs";
import { loadConfig, configPath, type PanelConfig } from "./config.js";
import { CLOUDFLARED_SENTINEL, invalidateCfAccessToken, resolveCfAccessToken } from "./cfaccess.js";

export class PanelError extends Error {
  status?: number;
  detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "PanelError";
    this.status = status;
    this.detail = detail;
  }
}

interface ApiOptions {
  raw?: boolean;
  query?: Record<string, string>;
}

interface PterodactylErrorBody {
  errors?: Array<{ code?: string; status?: string; detail?: string }>;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(base + path);
  if (query) {
    const params = new URLSearchParams(query);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a response came from Cloudflare Access's SSO login page rather than from the panel.
 *
 * Access answers an unauthenticated request with a 302 to the identity provider, which fetch follows
 * to an HTML page carrying a 200 — so without this check the JSON parse downstream fails on
 * "<!DOCTYPE" and blames the panel for malformed output. Two signals catch it: landing on a different
 * host than the panel, and an HTML body where the panel would have sent JSON.
 */
function isAccessChallenge(response: Response, baseUrl: string, raw: boolean): boolean {
  try {
    const landed = new URL(response.url);
    if (landed.host !== new URL(baseUrl).host) return true;
    if (landed.pathname.startsWith("/cdn-cgi/access/")) return true;
  } catch {
    // No usable response.url — fall through to the content-type signal.
  }
  if (raw) return false;
  return response.ok && (response.headers.get("Content-Type") ?? "").includes("text/html");
}

export class PanelClient {
  public readonly alias: string;
  public readonly cfg: PanelConfig;

  constructor(alias: string, cfg: PanelConfig) {
    this.alias = alias;
    this.cfg = cfg;
  }

  get baseUrl(): string {
    return this.cfg.url;
  }

  async api<T = any>(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
    if (!this.cfg.client_key) {
      throw new PanelError(
        `No client_key configured for panel "${this.alias}" — create one at ${this.cfg.url}/account/api, then run: ptero-mcp add-panel ${this.alias} --url ${this.cfg.url} --client-key ptlc_...`
      );
    }
    return this.request<T>(`${this.baseUrl}/api/client`, this.cfg.client_key, method, path, body, opts);
  }

  async appApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cfg.app_key) {
      throw new PanelError(
        `No app_key configured for panel "${this.alias}" — application API access requires an admin-issued ptla_ key. Add it to the panel's config entry.`
      );
    }
    return this.request<T>(`${this.baseUrl}/api/application`, this.cfg.app_key, method, path, body);
  }

  private async request<T>(
    baseSegment: string,
    key: string,
    method: string,
    path: string,
    body?: unknown,
    opts?: ApiOptions
  ): Promise<T> {
    const raw = opts?.raw ?? false;
    const url = buildUrl(baseSegment, path, opts?.query);

    const headers: Record<string, string> = {
      Accept: "application/vnd.pterodactyl.v1+json",
      Authorization: `Bearer ${key}`,
    };
    if (this.cfg.cf_access) {
      headers["cf-access-token"] = await resolveCfAccessToken(this.cfg.cf_access, this.baseUrl);
    }

    let requestBody: BodyInit | undefined;
    if (body !== undefined) {
      if (raw) {
        headers["Content-Type"] = "text/plain";
        requestBody = typeof body === "string" ? body : String(body);
      } else {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }
    }

    let attempt = 0;
    let reminted = false;
    for (;;) {
      const response = await fetch(url, { method, headers, body: requestBody });

      if (isAccessChallenge(response, this.baseUrl, raw)) {
        // A token revoked earlier than its `exp` claimed still looks cached-and-valid here, so one
        // re-mint separates "stale cache" from "never had access". Only worth doing for the CLI path —
        // a literal token is all we have and would just be resent unchanged.
        if (this.cfg.cf_access === CLOUDFLARED_SENTINEL && !reminted) {
          reminted = true;
          invalidateCfAccessToken(this.baseUrl);
          headers["cf-access-token"] = await resolveCfAccessToken(this.cfg.cf_access, this.baseUrl);
          continue;
        }
        throw new PanelError(this.accessChallengeMessage(), response.status);
      }

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new PanelError(`Rate limited by panel "${this.alias}" after ${MAX_RETRIES} retries`, 429);
        }
        const retryAfterHeader = response.headers.get("Retry-After");
        const retrySeconds = retryAfterHeader ? Number(retryAfterHeader) : DEFAULT_RETRY_SECONDS;
        await sleep((Number.isFinite(retrySeconds) ? retrySeconds : DEFAULT_RETRY_SECONDS) * 1000);
        attempt++;
        continue;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      if (!response.ok) {
        await this.throwForError(response);
      }

      if (raw) {
        return (await response.text()) as unknown as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }
  }

  /** Explains an Access challenge in terms of the specific `cf_access` setting that produced it. */
  private accessChallengeMessage(): string {
    const intro =
      `Panel "${this.alias}" sits behind Cloudflare Access — the request was answered by the SSO login ` +
      `page, so the Pterodactyl API key never reached the panel.`;
    if (this.cfg.cf_access === CLOUDFLARED_SENTINEL) {
      return `${intro} The cached cloudflared login was rejected — run: cloudflared access login ${this.baseUrl}`;
    }
    if (this.cfg.cf_access) {
      return (
        `${intro} The configured cf_access token was rejected, most likely expired. Replace it, or set ` +
        `"cf_access": "cloudflared" on this panel to have fresh tokens minted automatically.`
      );
    }
    return (
      `${intro} Set "cf_access": "cloudflared" on this panel's config entry, then run: ` +
      `cloudflared access login ${this.baseUrl}`
    );
  }

  private async throwForError(response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    let detail: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as PterodactylErrorBody;
        const first = parsed.errors?.[0];
        if (first?.detail) {
          detail = first.detail;
        }
      } catch {
        // not JSON — fall through, use raw text as detail
        detail = text;
      }
    }
    // A malformed or hostile panel response shouldn't be able to flood tool output.
    const MAX_DETAIL_LENGTH = 1000;
    if (detail && detail.length > MAX_DETAIL_LENGTH) {
      detail = `${detail.slice(0, MAX_DETAIL_LENGTH)}…`;
    }
    const message = detail
      ? `Panel "${this.alias}" returned ${response.status}: ${detail}`
      : `Panel "${this.alias}" returned ${response.status} ${response.statusText}`;
    throw new PanelError(message, response.status, detail);
  }
}

interface ConfigFileStat {
  mtimeMs: number;
  size: number;
}

interface PanelCache {
  panels: Map<string, PanelClient>;
  defaultPanel?: string;
  /** Snapshot of the config file's mtime/size at the time this cache was built; null if it didn't exist. */
  configStat: ConfigFileStat | null;
}

let panelCache: PanelCache | undefined;

/** Cheaply snapshots the config file's mtime/size. Never throws — a missing or unreadable file is `null`. */
function statConfigFile(): ConfigFileStat | null {
  try {
    const st = statSync(configPath());
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function configStatsEqual(a: ConfigFileStat | null, b: ConfigFileStat | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function buildCache(): PanelCache {
  const cfg = loadConfig();
  const panels = new Map<string, PanelClient>();
  for (const [alias, panelCfg] of Object.entries(cfg.panels)) {
    panels.set(alias, new PanelClient(alias, panelCfg));
  }
  const cache: PanelCache = { panels, configStat: statConfigFile() };
  if (cfg.default_panel !== undefined) {
    cache.defaultPanel = cfg.default_panel;
  }
  return cache;
}

/** Clears the in-memory panel cache, forcing the next getPanel/allPanels call to reload config from disk. */
export function invalidatePanelCache(): void {
  panelCache = undefined;
}

/**
 * Returns the current panel cache, rebuilding it if the config file has appeared, disappeared, or
 * changed (mtime/size) since it was last built. This lets a long-lived MCP server process pick up
 * config-file changes made by another process (e.g. `ptero-mcp add-panel` run in a separate
 * terminal, or the file being created after the server started with none configured) without
 * requiring a restart. Env-var-derived panels can't change mid-process, so no separate invalidation
 * is needed for them — a rebuild always re-runs loadConfig(), which re-applies the env overlay.
 */
function ensureFreshCache(): PanelCache {
  if (!panelCache) {
    panelCache = buildCache();
    return panelCache;
  }
  try {
    const currentStat = statConfigFile();
    if (!configStatsEqual(panelCache.configStat, currentStat)) {
      panelCache = buildCache();
    }
  } catch {
    // Best-effort freshness check — any failure here just means we keep using the existing cache
    // rather than letting a stat() hiccup break tool resolution.
  }
  return panelCache;
}

/**
 * Resolves a PanelClient by alias. If alias is omitted: uses default_panel, or — if exactly one
 * panel is configured — that panel. Throws PanelError listing available aliases otherwise.
 */
export function getPanel(alias?: string): PanelClient {
  const { panels, defaultPanel } = ensureFreshCache();

  if (alias !== undefined) {
    const panel = panels.get(alias);
    if (!panel) {
      const known = [...panels.keys()];
      throw new PanelError(
        known.length > 0
          ? `Unknown panel alias "${alias}". Configured panels: ${known.join(", ")}`
          : `Unknown panel alias "${alias}". No panels are configured yet — run ptero-mcp add-panel.`
      );
    }
    return panel;
  }

  if (defaultPanel) {
    const panel = panels.get(defaultPanel);
    if (panel) return panel;
  }

  if (panels.size === 1) {
    return [...panels.values()][0]!;
  }

  const known = [...panels.keys()];
  if (known.length === 0) {
    throw new PanelError("No panels are configured yet — run ptero-mcp add-panel.");
  }
  throw new PanelError(
    `No panel specified and no default_panel set. Configured panels: ${known.join(", ")}`
  );
}

/** Returns PanelClient instances for every configured panel. */
export function allPanels(): PanelClient[] {
  const { panels } = ensureFreshCache();
  return [...panels.values()];
}
