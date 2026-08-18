import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PanelConfig {
  url: string;
  client_key?: string;
  /** Panel account password — used ONLY as SFTP auth fallback, never for panel login. */
  password?: string;
  app_key?: string;
  ssh_key?: string;
  /**
   * Overrides the SFTP host the panel advertises in `sftp_details`. Needed when the node's FQDN is
   * fronted by a proxy that only forwards HTTP/HTTPS (Cloudflare's orange cloud being the common
   * case) — the panel API still reports that hostname, but it never accepts TCP on the SFTP port,
   * so connections hang at the SSH handshake. Point this at the origin IP, a DNS-only hostname, or
   * a local forwarder (e.g. 127.0.0.1 for a Cloudflare Tunnel).
   */
  sftp_host?: string;
  /** Overrides the SFTP port from `sftp_details`. Defaults to the panel-reported port (usually 2022). */
  sftp_port?: number;
  /**
   * Credential for a Cloudflare Access gate in front of the panel. Without it, a gated panel answers
   * every API call with a redirect to the SSO login page, so the Pterodactyl API key never reaches
   * the panel at all.
   *
   * Either a literal Access JWT, or `"cloudflared"` to mint a fresh one per request via the
   * cloudflared CLI. Prefer `"cloudflared"`: it needs no Zero Trust admin rights, survives token
   * rotation, and keeps the token out of this file — see README.md.
   */
  cf_access?: string;
}

export interface Config {
  default_panel?: string;
  panels: Record<string, PanelConfig>;
}

/** Property names that must never be used as panel aliases or object keys built from user input. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Env vars that carry MCP-server-level configuration, never a per-panel field. */
const RESERVED_ENV_VARS = new Set(["PTERO_MCP_CONFIG", "PTERO_DEFAULT_PANEL"]);

/** Resolves the config file location: PTERO_MCP_CONFIG env override, else ~/.ptero-mcp/config.json */
export function configPath(): string {
  return process.env.PTERO_MCP_CONFIG || join(homedir(), ".ptero-mcp", "config.json");
}

/** Replaces ${ENV_VAR} placeholders in a string with process.env values (left as-is if unset). */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const envVal = process.env[name];
    return envVal !== undefined ? envVal : match;
  });
}

/** Strips a trailing slash from a panel base URL. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function interpolatePanelConfig(panel: PanelConfig): PanelConfig {
  const result: PanelConfig = { url: normalizeUrl(interpolateEnv(panel.url)) };
  for (const key of Object.keys(panel) as Array<keyof PanelConfig>) {
    if (key === "url") continue;
    const val = panel[key];
    if (typeof val === "string") {
      (result as any)[key] = interpolateEnv(val);
    } else if (typeof val === "number") {
      // Numeric fields (sftp_port) carry through untouched — dropping them here would silently
      // discard a configured port override.
      (result as any)[key] = val;
    }
  }
  return result;
}

/**
 * Reads and parses only the config file (no env-var overlay). Missing file -> {panels: {}}.
 * Exported so callers that need to WRITE back to disk (e.g. sftp.ts's setupKey persisting a
 * generated ssh_key path) can update just the file-backed layer without also duplicating
 * env-var-only secrets onto disk — see saveConfig()/loadConfig()'s merge behavior.
 */
export function loadFileConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    return { panels: {} };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Config;
  const panels: Record<string, PanelConfig> = {};
  for (const [alias, panel] of Object.entries(parsed.panels ?? {})) {
    // Guard against prototype pollution via a crafted config file (e.g. an alias key of
    // "__proto__") — skip it rather than let bracket assignment touch Object.prototype.
    if (RESERVED_KEYS.has(alias)) continue;
    panels[alias] = interpolatePanelConfig(panel);
  }
  const cfg: Config = { panels };
  if (parsed.default_panel !== undefined) {
    cfg.default_panel = parsed.default_panel;
  }
  return cfg;
}

/**
 * Loads the config file, applying ${ENV_VAR} interpolation and URL normalization, then overlays
 * panels declared directly as PTERO_* environment variables (see loadEnvPanels) — env wins
 * per-field on alias collisions. Default panel precedence: PTERO_DEFAULT_PANEL > file's
 * default_panel. Any warnings produced while parsing env panels are printed to stderr exactly
 * once per process.
 */
export function loadConfig(): Config {
  const fileCfg = loadFileConfig();
  const { panels: envPanels, defaultPanel: envDefaultPanel, warnings } = loadEnvPanels();

  warnOnceForEnvPanels(warnings);

  const merged: Record<string, PanelConfig> = {};
  for (const [alias, panel] of Object.entries(fileCfg.panels)) {
    merged[alias] = { ...panel };
  }
  for (const [alias, panel] of Object.entries(envPanels)) {
    merged[alias] = { ...(merged[alias] ?? {}), ...panel };
  }

  const cfg: Config = { panels: merged };
  const defaultPanel = envDefaultPanel ?? fileCfg.default_panel;
  if (defaultPanel !== undefined) {
    cfg.default_panel = defaultPanel;
  }
  return cfg;
}

/**
 * Saves the config file, creating parent directories as needed, pretty-printed. Config contains
 * panel API keys/passwords, so both the containing directory and the file itself are created with
 * restrictive permissions, and restrictConfigAcl() is always run afterward — writeFileSync's mode
 * argument only takes effect when the file is newly created, so an explicit chmod/icacls pass is
 * what keeps an existing file's permissions correct across rewrites.
 */
export function saveConfig(cfg: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const json = JSON.stringify(cfg, null, 2);
  writeFileSync(path, json, { encoding: "utf-8", mode: 0o600 });
  restrictConfigAcl();
}

export type UrlValidationResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validates and normalizes a panel base URL: must be https://, except http:// is permitted for
 * localhost/127.0.0.1 (local test panels). Strips a trailing slash. Shared by the CLI (`add-panel`)
 * and env-var panel parsing so every onboarding path agrees on what a valid panel URL looks like.
 */
export function validatePanelUrl(input: string): UrlValidationResult {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL.` };
  }
  const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost)) {
    return {
      ok: false,
      error: `URL must be https:// (got "${parsed.protocol}") — Pterodactyl panels should be served over TLS.`,
    };
  }
  return { ok: true, url: trimmed.replace(/\/+$/, "") };
}

export type AliasValidationResult = { ok: true; alias: string } | { ok: false; error: string };

/**
 * Validates and normalizes a panel alias: lowercases it, then requires it to match
 * ^[a-z0-9][a-z0-9_-]{0,63}$, and explicitly rejects the JavaScript-prototype-polluting special
 * names ("__proto__", "constructor", "prototype"). Shared by env-var panel parsing, the CLI
 * (`add-panel`), and sftp.ts's setupKey — an alias that reaches a filesystem path unvalidated could
 * escape the intended directory via "/" or "..".
 */
export function validateAlias(alias: string): AliasValidationResult {
  const lowered = alias.toLowerCase();
  if (RESERVED_KEYS.has(lowered)) {
    return { ok: false, error: `"${alias}" is a reserved name and cannot be used as a panel alias.` };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(lowered)) {
    return {
      ok: false,
      error:
        `"${alias}" is not a valid panel alias — aliases must start with a letter or digit and contain only ` +
        `lowercase letters, digits, "_", or "-" (max 64 characters).`,
    };
  }
  return { ok: true, alias: lowered };
}

// ---------------------------------------------------------------------------
// Env-var panel parsing (PTERO_<ALIAS>_<FIELD>)
// ---------------------------------------------------------------------------

/**
 * Recognized env var suffixes mapped to PanelConfig fields, ordered LONGEST-FIRST so that e.g.
 * PTERO_BLOOM_APP_KEY parses as alias="bloom" field="app_key" rather than alias="bloom_app"
 * field="key" (which would happen if the generic "_KEY" suffix were checked first).
 */
const ENV_PANEL_SUFFIXES: Array<{ suffix: string; field: keyof PanelConfig }> = [
  { suffix: "_SFTP_HOST", field: "sftp_host" },
  { suffix: "_SFTP_PORT", field: "sftp_port" },
  { suffix: "_CF_ACCESS", field: "cf_access" },
  { suffix: "_APP_KEY", field: "app_key" },
  { suffix: "_SSH_KEY", field: "ssh_key" },
  { suffix: "_PASSWORD", field: "password" },
  { suffix: "_URL", field: "url" },
  { suffix: "_KEY", field: "client_key" },
];

const ENV_PREFIX = "PTERO_";

function matchPanelEnvVar(name: string): { alias: string; field: keyof PanelConfig } | undefined {
  if (!name.startsWith(ENV_PREFIX)) return undefined;
  const rest = name.slice(ENV_PREFIX.length);
  for (const { suffix, field } of ENV_PANEL_SUFFIXES) {
    if (rest.length > suffix.length && rest.endsWith(suffix)) {
      const alias = rest.slice(0, rest.length - suffix.length);
      if (alias.length > 0) {
        return { alias, field };
      }
    }
  }
  return undefined;
}

export interface EnvPanelsResult {
  panels: Record<string, PanelConfig>;
  defaultPanel?: string;
  warnings: string[];
}

/**
 * Parses panel definitions directly from environment variables, e.g.:
 *   PTERO_PROD_URL, PTERO_PROD_KEY, PTERO_BLOOM_URL, PTERO_BLOOM_KEY, PTERO_BLOOM_APP_KEY,
 *   PTERO_DEFAULT_PANEL
 * Never throws — invalid aliases/URLs are skipped and explained in `warnings`. A panel missing
 * its URL or its client key is still returned (so `doctor`/tool errors can explain what's
 * missing) with a warning naming the gap.
 */
export function loadEnvPanels(env: NodeJS.ProcessEnv = process.env): EnvPanelsResult {
  const warnings: string[] = [];
  const partials = new Map<string, Partial<PanelConfig>>();
  // Tracks which fields had a (possibly invalid) env var provided, so a field that failed
  // validation (e.g. a malformed URL) is reported once via its specific error rather than also
  // being reported again as "missing" below.
  const seenFields = new Map<string, Set<keyof PanelConfig>>();
  let defaultPanel: string | undefined;

  for (const [name, rawValue] of Object.entries(env)) {
    if (!rawValue) continue;
    if (!name.startsWith(ENV_PREFIX)) continue;
    if (RESERVED_ENV_VARS.has(name)) {
      if (name === "PTERO_DEFAULT_PANEL") {
        defaultPanel = rawValue.trim().toLowerCase();
      }
      continue;
    }

    const matched = matchPanelEnvVar(name);
    if (!matched) continue;

    const aliasResult = validateAlias(matched.alias);
    if (!aliasResult.ok) {
      warnings.push(`Ignoring env var "${name}" — ${aliasResult.error}`);
      continue;
    }
    const alias = aliasResult.alias;

    let fieldSet = seenFields.get(alias);
    if (!fieldSet) {
      fieldSet = new Set();
      seenFields.set(alias, fieldSet);
    }
    fieldSet.add(matched.field);
    if (!partials.has(alias)) partials.set(alias, {});

    let value = rawValue;
    if (matched.field === "url") {
      const urlResult = validatePanelUrl(rawValue);
      if (!urlResult.ok) {
        warnings.push(`Ignoring env var "${name}" — ${urlResult.error}`);
        continue;
      }
      value = urlResult.url;
    }

    const existing = partials.get(alias)!;
    (existing as any)[matched.field] = value;
  }

  const panels: Record<string, PanelConfig> = {};
  for (const [alias, partial] of partials) {
    const upperAlias = alias.toUpperCase();
    const seen = seenFields.get(alias) ?? new Set<keyof PanelConfig>();
    if (!seen.has("url")) {
      warnings.push(
        `Panel "${alias}" (from env vars) has no PTERO_${upperAlias}_URL — it will not be usable until one is set.`
      );
    }
    if (!seen.has("client_key")) {
      warnings.push(
        `Panel "${alias}" (from env vars) has no PTERO_${upperAlias}_KEY (client key) — it will not be usable until one is set.`
      );
    }
    panels[alias] = { url: partial.url ?? "", ...partial };
  }

  const result: EnvPanelsResult = { panels, warnings };
  if (defaultPanel !== undefined) {
    result.defaultPanel = defaultPanel;
  }
  return result;
}

let hasWarnedEnvPanels = false;

/** Prints env-panel-parsing warnings to stderr exactly once per process (never stdout — see server.ts). */
function warnOnceForEnvPanels(warnings: string[]): void {
  if (warnings.length === 0 || hasWarnedEnvPanels) return;
  hasWarnedEnvPanels = true;
  for (const w of warnings) {
    console.error(`ptero-mcp: ${w}`);
  }
}

/** Where a configured panel's definition comes from — used by `doctor` and `list_panels`. */
export function panelSource(alias: string): "env" | "file" | "both" | undefined {
  const fileHas = Object.prototype.hasOwnProperty.call(loadFileConfig().panels, alias);
  const envHas = Object.prototype.hasOwnProperty.call(loadEnvPanels().panels, alias);
  if (fileHas && envHas) return "both";
  if (envHas) return "env";
  if (fileHas) return "file";
  return undefined;
}

/**
 * Best-effort restriction of a file to the current user only. Windows: icacls. Other platforms:
 * chmod 0600. Never throws — logs a warning to stderr and moves on if it fails, since a file
 * that's merely world-readable is far better than a crashed CLI/server.
 */
export function restrictFileAcl(path: string): void {
  if (process.platform === "win32") {
    const user = process.env.USERNAME || process.env.USER;
    if (!user) {
      console.error(`Warning: could not determine the current username — skipped restricting permissions on ${path}.`);
      return;
    }
    try {
      execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `Warning: failed to restrict permissions on ${path} (${message}). The file may be readable by other local accounts.`
      );
    }
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Warning: failed to chmod 0600 ${path} (${message}). The file may be readable by other local accounts.`
    );
  }
}

/** Restricts the config file (configPath()) to the current user only. See restrictFileAcl(). */
export function restrictConfigAcl(): void {
  restrictFileAcl(configPath());
}
