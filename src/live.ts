import { AsyncLocalStorage } from "node:async_hooks";
import { PanelError } from "./panel.js";

/**
 * Live-server protection, enforced in code rather than by banning tool names.
 *
 * The user's settings.json used to deny seven tools outright (archive, pull_url, write_file, ...),
 * which protected live boxes by making zipping and URL pulls impossible everywhere - the direct
 * cause of a bulk transfer degrading into fourteen parallel per-file downloads. The real rule is
 * not "never zip", it is "never write to a live server by accident", so that is what this checks.
 *
 * Reads are always allowed. Any mutating request to a known-live server is refused unless the
 * caller explicitly passed confirm_live, which is the panel equivalent of saying it out loud.
 */

export interface LiveServer {
  panel?: string;
  identifier: string;
  name: string;
  why: string;
}

/** Authoritative list. Identifiers are stable; names are only used to explain a refusal. */
export const LIVE_SERVERS: LiveServer[] = [
  {
    panel: "aureus-mc",
    identifier: "f67688b7",
    name: "Cobblemon Lotus",
    why: "LIVE Aureus server with real players. Formerly named 'Cobblemon Dev 2', so old notes mislead.",
  },
  {
    panel: "mb-synx",
    identifier: "1ab48184",
    name: "Production Cobblemon",
    why: "LIVE EnchantMC production server.",
  },
];

/**
 * Anything whose name looks live is also refused, so a box nobody has catalogued yet fails
 * closed instead of open. Dev and staging names are explicitly exempt.
 */
const LIVE_NAME = /\b(production|prod|live|lotus)\b/i;
const NOT_LIVE_NAME = /\b(dev|development|staging|test|playtest|sandbox)\b/i;

const names = new Map<string, string>();

/** Called by the resolver so a refusal can name the server, and so the heuristic has data. */
export function rememberServer(identifier: string, name: string): void {
  if (identifier && name) names.set(identifier.toLowerCase(), name);
}

export function liveReason(identifier: string, panelAlias?: string): string | null {
  const id = (identifier ?? "").toLowerCase();
  const listed = LIVE_SERVERS.find(
    (s) => s.identifier.toLowerCase() === id && (!s.panel || !panelAlias || s.panel === panelAlias),
  );
  if (listed) return `${listed.name} (${listed.identifier}) - ${listed.why}`;

  const name = names.get(id);
  if (name && LIVE_NAME.test(name) && !NOT_LIVE_NAME.test(name)) {
    return `${name} (${identifier}) - name looks like a live server, so it fails closed`;
  }
  return null;
}

const confirmed = new AsyncLocalStorage<boolean>();

/** Wraps a tool handler that was given confirm_live, so the guard lets its writes through. */
export function withLiveConfirmed<T>(confirm: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  if (!confirm) return fn();
  return confirmed.run(true, fn);
}

/**
 * Same guard as assertWritable, for the few write paths (raw SFTP) that never go through
 * PanelClient.api and so can't be caught by the HTTP-method hook below.
 */
export function assertLiveWriteConfirmed(identifier: string, panelAlias?: string): void {
  if (confirmed.getStore() === true) return;
  if (process.env.PTERO_ALLOW_LIVE === "1") return;
  const reason = liveReason(identifier, panelAlias);
  if (!reason) return;
  throw new PanelError(
    `Refused: write on a LIVE server - ${reason}. ` +
      `If the user has just confirmed a live change in this turn, re-issue with confirm_live: true. ` +
      `Never infer live intent from context or an earlier approval.`,
  );
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Hooked into PanelClient.api so no tool can forget to call it. */
export function assertWritable(panelAlias: string, method: string, path: string): void {
  if (READ_METHODS.has(method.toUpperCase())) return;
  if (confirmed.getStore() === true) return;
  if (process.env.PTERO_ALLOW_LIVE === "1") return;

  const match = /^\/servers\/([^/]+)/.exec(path);
  if (!match) return;
  const reason = liveReason(match[1], panelAlias);
  if (!reason) return;

  throw new PanelError(
    `Refused: ${method.toUpperCase()} on a LIVE server - ${reason}. ` +
      `Reads are fine; this was a write. If the user has just confirmed a live change in this turn, ` +
      `re-issue with confirm_live: true. Never infer live intent from context or an earlier approval.`,
  );
}
