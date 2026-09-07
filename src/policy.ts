import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { configPath } from "./config.js";
import { PanelError } from "./panel.js";
import type { ServerRef } from "./resolve.js";

/**
 * How a server may be written to.
 *
 *  - `dev` / `staging`: writes allowed freely.
 *  - `live`: every write needs `confirm_live: true`, which the caller may only pass when the user
 *    explicitly asked, in the current conversation, to write to that live server.
 *  - `retired`: never written to.
 */
export type ServerEnv = "dev" | "staging" | "live" | "retired";

/**
 * Paths on a server that a deploy repo owns. Anything written there by hand is deleted the next
 * time the server boots, so the tool refuses outright and points at the repo/skill instead.
 */
export interface ManagedRule {
  paths: string[];
  repo: string;
  skill?: string;
  why?: string;
}

export interface ServerPolicy {
  name?: string;
  env?: ServerEnv;
  managed?: ManagedRule;
  note?: string;
}

export interface PanelPolicy {
  env?: ServerEnv;
  managed?: ManagedRule;
}

export interface Policy {
  panels?: Record<string, PanelPolicy>;
  /** Keyed `"<panel alias>:<8-char identifier>"`. */
  servers?: Record<string, ServerPolicy>;
}

export interface Classification {
  env: ServerEnv;
  managed?: ManagedRule;
  source: "server" | "panel" | "name" | "default";
}

export interface WriteRequest {
  tool: string;
  action?: string;
  /** Remote paths the write touches (POSIX, absolute or relative to "/"). */
  paths?: string[];
  confirmLive?: boolean;
}

const DEV_NAME = /\b(dev|staging|playtest|test|sandbox)\b/i;
const RETIRED_NAME = /\b(old|retired|archive[d]?)\b/i;

/** Resolves the policy file location: PTERO_MCP_POLICY env override, else policy.json beside config.json. */
export function policyPath(): string {
  return process.env.PTERO_MCP_POLICY || join(dirname(configPath()), "policy.json");
}

interface PolicyCache {
  policy: Policy;
  mtimeMs: number;
  size: number;
}

let cache: PolicyCache | undefined;

function statPolicy(path: string): { mtimeMs: number; size: number } {
  const s = statSync(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

/**
 * Loads the policy file, re-reading it whenever its mtime/size changes so a long-lived MCP process
 * picks up edits without a restart. A missing file means "no policy": every server classifies by
 * name, and unknown names are treated as live.
 */
export function loadPolicy(): Policy {
  const path = policyPath();
  if (!existsSync(path)) {
    cache = undefined;
    return {};
  }
  const current = statPolicy(path);
  if (cache && cache.mtimeMs === current.mtimeMs && cache.size === current.size) {
    return cache.policy;
  }
  const policy = JSON.parse(readFileSync(path, "utf-8")) as Policy;
  cache = { policy, ...current };
  return policy;
}

/** Test hook — forget the cached policy so the next call re-reads the file. */
export function invalidatePolicyCache(): void {
  cache = undefined;
}

function envFromName(name: string): ServerEnv | undefined {
  if (RETIRED_NAME.test(name)) return "retired";
  if (DEV_NAME.test(name)) return "dev";
  return undefined;
}

/** Classifies a server: explicit server entry, then panel default, then name heuristic, then live. */
export function classifyServer(ref: ServerRef, policy: Policy = loadPolicy()): Classification {
  const key = `${ref.panel.alias}:${ref.identifier}`;
  const server = policy.servers?.[key];
  const panel = policy.panels?.[ref.panel.alias];
  const managed = server?.managed ?? panel?.managed;

  if (server?.env) return { env: server.env, managed, source: "server" };
  if (panel?.env) return { env: panel.env, managed, source: "panel" };

  const byName = envFromName(ref.name ?? "");
  if (byName) return { env: byName, managed, source: "name" };
  return { env: "live", managed, source: "default" };
}

/** `"Staging Playtest 1" (f3be6903 on ci-synx)` — names first, ids second, so messages read as servers not hashes. */
export function describeServer(ref: ServerRef): string {
  return `"${ref.name}" (${ref.identifier} on ${ref.panel.alias})`;
}

/** Normalises a remote path to an absolute POSIX path with no trailing slash ("/" stays "/"). */
export function normalizeRemote(path: string): string {
  const joined = posix.normalize("/" + path.replace(/\\/g, "/"));
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

/** True when `path` is `managed` itself or lives underneath it. */
export function isUnderManaged(path: string, managed: string): boolean {
  const p = normalizeRemote(path);
  const m = normalizeRemote(managed);
  return p === m || p.startsWith(m === "/" ? "/" : `${m}/`);
}

function managedHit(rule: ManagedRule, paths: string[]): string | undefined {
  for (const path of paths) {
    for (const managed of rule.paths) {
      if (isUnderManaged(path, managed)) return normalizeRemote(path);
    }
  }
  return undefined;
}

/**
 * The single gate every mutating tool passes through after resolving its server.
 *
 * Order matters: a retired box is refused before anything else; a deploy-repo-managed path is
 * refused even with `confirm_live`, because the write would be silently undone on the next boot;
 * only then does the live check apply.
 */
export function assertWriteAllowed(ref: ServerRef, request: WriteRequest, policy: Policy = loadPolicy()): Classification {
  const cls = classifyServer(ref, policy);
  const what = request.action ? `${request.tool}(${request.action})` : request.tool;
  const where = describeServer(ref);

  if (cls.env === "retired") {
    throw new PanelError(`${what} refused: ${where} is retired. Nothing is written to retired servers.`);
  }

  if (cls.managed && request.paths?.length) {
    const hit = managedHit(cls.managed, request.paths);
    if (hit) {
      const rule = cls.managed;
      const lines = [
        `${what} refused: ${hit} on ${where} is owned by the deploy repo ${rule.repo}.`,
        rule.why ?? "The server rebuilds that directory from the repo on every boot, so a file written here vanishes on the next restart and the server keeps running the old build.",
        rule.skill
          ? `Put the file in the repo and restart the server instead - invoke the "${rule.skill}" skill, which owns that flow.`
          : "Put the file in the repo and restart the server instead.",
        "There is no override for this; it is not a permission check, it is how the server boots.",
      ];
      throw new PanelError(lines.join(" "));
    }
  }

  if (cls.env === "live" && request.confirmLive !== true) {
    throw new PanelError(
      `${what} refused: ${where} is LIVE with real players on it. ` +
        `Re-issue with confirm_live: true ONLY if the user explicitly asked, in this conversation, to write to this live server ` +
        `(a dev/staging approval, urgency, or an earlier session does not count). If they did not, pick the dev/staging box instead.`
    );
  }

  return cls;
}

/** Remote paths a `file_action` call touches, for the managed-path check. */
export function fileActionPaths(args: {
  action: string;
  root?: string;
  from?: string;
  to?: string;
  location?: string;
  files?: string[];
  name?: string;
  file?: string;
}): string[] {
  const root = args.root ?? "/";
  const under = (rel: string) => posix.join(root, rel);
  switch (args.action) {
    case "move":
      return [args.from, args.to].filter((v): v is string => Boolean(v)).map(under);
    case "copy":
      return args.location ? [args.location] : [root];
    case "delete":
      return (args.files ?? []).map(under);
    case "mkdir":
      return args.name ? [under(args.name)] : [root];
    case "chmod":
      return args.file ? [under(args.file)] : [root];
    default:
      return [root];
  }
}
