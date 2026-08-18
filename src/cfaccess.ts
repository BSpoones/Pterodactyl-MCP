import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The `cf_access` value meaning "mint a fresh token with the cloudflared CLI" rather than treat the
 * value as a literal JWT. Chosen because a real Access token is always a three-segment JWT, so it
 * can never collide with this word.
 */
export const CLOUDFLARED_SENTINEL = "cloudflared";

/** Refresh a cached token this many ms before its `exp`, to absorb clock skew and request latency. */
const EXPIRY_SKEW_MS = 60_000;

/** Assumed lifetime for a token whose `exp` claim could not be read — short, so a stale one self-heals. */
const FALLBACK_TTL_MS = 5 * 60_000;

export class CfAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfAccessError";
  }
}

interface CachedToken {
  token: string;
  /** Epoch ms at which this entry stops being served from cache. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * In-flight mint per app URL. Tools like list_files fire several API calls concurrently, and without
 * this each one would spawn its own cloudflared process for the same token.
 */
const inFlight = new Map<string, Promise<string>>();

/** Remembers which candidate path actually ran, so only the first call pays for probing. */
let resolvedBinary: string | undefined;

/**
 * Candidate cloudflared executables, in priority order: PTERO_CLOUDFLARED_PATH wins outright, then
 * PATH, then the Windows MSI's install directories — that installer edits the *machine* PATH, which
 * an already-running process (this MCP server, or the editor that spawned it) does not inherit until
 * it is restarted, so a fresh install is otherwise invisible until the user reboots their editor.
 */
function cloudflaredCandidates(): string[] {
  const override = process.env.PTERO_CLOUDFLARED_PATH?.trim();
  if (override) return [override];

  const candidates = ["cloudflared"];
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (base) candidates.push(join(base, "cloudflared", "cloudflared.exe"));
    }
  }
  return candidates;
}

function isMissingBinaryError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/** True for a well-formed three-segment JWT. Guards against treating CLI diagnostics as a token. */
function looksLikeJwt(value: string): boolean {
  const segments = value.split(".");
  return segments.length === 3 && segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

/**
 * Reads the `exp` claim (epoch seconds) out of a JWT payload without verifying the signature — this
 * is only used to decide when to re-mint, never to make a trust decision. Returns undefined when the
 * token is opaque or malformed, in which case FALLBACK_TTL_MS applies.
 */
function readJwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    const claims = JSON.parse(decoded) as { exp?: unknown };
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
      return claims.exp * 1000;
    }
  } catch {
    // Not a JWT we can read — the caller falls back to a short TTL.
  }
  return undefined;
}

/**
 * Runs `cloudflared access token -app=<appUrl>`, which prints the JWT cached by a previous
 * `cloudflared access login`. Throws a CfAccessError naming the fix when cloudflared is absent or
 * has no cached login for this app.
 */
async function mintToken(appUrl: string): Promise<string> {
  const candidates = resolvedBinary ? [resolvedBinary] : cloudflaredCandidates();
  let lastMissing: unknown;

  for (const binary of candidates) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(binary, ["access", "token", `-app=${appUrl}`]));
    } catch (err) {
      if (isMissingBinaryError(err)) {
        lastMissing = err;
        continue;
      }
      // cloudflared ran but refused — overwhelmingly "no cached login for this app".
      const detail = (err as { stderr?: string; message?: string }).stderr?.trim() || (err as Error).message;
      throw new CfAccessError(
        `cloudflared could not provide an Access token for ${appUrl} (${detail}). Run: cloudflared access login ${appUrl}`
      );
    }

    resolvedBinary = binary;
    const token = stdout.trim();
    if (!looksLikeJwt(token)) {
      throw new CfAccessError(
        `cloudflared did not return an Access token for ${appUrl} — it printed "${token.slice(0, 120)}". ` +
          `Run: cloudflared access login ${appUrl}`
      );
    }
    return token;
  }

  throw new CfAccessError(
    `cloudflared is not installed or not on PATH (${String(
      (lastMissing as Error | undefined)?.message ?? "not found"
    )}). Install it with: winget install --id Cloudflare.cloudflared — then run: cloudflared access login ${appUrl}`
  );
}

/**
 * Resolves the `cf-access-token` header value for a panel sitting behind Cloudflare Access.
 *
 * A literal JWT in `cf_access` is returned as-is. The CLOUDFLARED_SENTINEL instead delegates to the
 * cloudflared CLI and caches the result until shortly before it expires, so a long-lived MCP process
 * keeps working across token rotation without spawning a process per API call.
 */
export async function resolveCfAccessToken(cfAccess: string, appUrl: string): Promise<string> {
  if (cfAccess !== CLOUDFLARED_SENTINEL) {
    return cfAccess;
  }

  const cached = tokenCache.get(appUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const pending = inFlight.get(appUrl);
  if (pending) return pending;

  const mint = mintToken(appUrl)
    .then((token) => {
      const expiry = readJwtExpiry(token);
      const expiresAt = expiry !== undefined ? expiry - EXPIRY_SKEW_MS : Date.now() + FALLBACK_TTL_MS;
      tokenCache.set(appUrl, { token, expiresAt });
      return token;
    })
    .finally(() => {
      inFlight.delete(appUrl);
    });

  inFlight.set(appUrl, mint);
  return mint;
}

/**
 * Drops any cached token for an app URL, forcing the next resolveCfAccessToken to re-mint. Called
 * when the panel answers with an Access challenge despite a token having been sent — the cached copy
 * was revoked or expired earlier than its `exp` claimed.
 */
export function invalidateCfAccessToken(appUrl: string): void {
  tokenCache.delete(appUrl);
}

/** Clears all cached tokens and the remembered binary path. Test seam. */
export function resetCfAccessCache(): void {
  tokenCache.clear();
  inFlight.clear();
  resolvedBinary = undefined;
}
