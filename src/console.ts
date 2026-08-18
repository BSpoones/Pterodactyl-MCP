import WebSocket from "ws";
import { PanelError } from "./panel.js";
import type { ServerRef } from "./resolve.js";

export interface ConsoleResult {
  output: string;
  states: string[];
  truncated: boolean;
}

// Matches ANSI/VT escape sequences:
//  - OSC sequences: ESC ] ... terminated by BEL or ESC \
//  - CSI and other ESC-prefixed sequences: ESC [ (optional intermediate bytes) params final-byte
// Covers SGR color codes, cursor movement, and screen/line erase - the sequences game console
// output is typically full of. Built from \u escapes (not raw control bytes) so the source file
// stays plain ASCII.
const ESC = "\\u001B";
const BEL = "\\u0007";
const OSC_PATTERN = `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`;
const CSI_PATTERN = `[${ESC}\\u009B][\\[\\]()#;?]*[0-9;]*[a-zA-Z0-9=><~]`;
const ANSI_PATTERN = new RegExp(`(?:${OSC_PATTERN})|(?:${CSI_PATTERN})`, "g");

/** Strips ANSI/VT escape sequences (color codes, cursor movement, etc.) from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Pure helpers — no network/timers, so these are what test/console.test.ts exercises.
// ---------------------------------------------------------------------------

export interface WsMessage {
  event: string;
  args: any[];
}

/**
 * Parses a raw WebSocket text frame (the Wings console protocol is always a JSON object
 * shaped like `{"event":"...","args":[...]}`) into a typed message. Returns undefined for
 * anything malformed rather than throwing, since a single bad frame shouldn't kill the session.
 */
export function parseWsMessage(raw: string): WsMessage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  if (typeof obj.event !== "string") return undefined;
  const args = Array.isArray(obj.args) ? (obj.args as any[]) : [];
  return { event: obj.event, args };
}

/** Splits a raw console chunk into individual lines (Wings occasionally bundles several history lines into one event). */
export function splitConsoleLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/);
}

/** Formats a power-state change as "HH:MM:SS state" using the given (local) timestamp. */
export function formatStateLine(at: Date, state: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${state}`;
}

/** Returns the last `n` lines of a newline-joined block of text (n clamped to >= 1). */
export function tailLines(text: string, n: number): string[] {
  if (text.length === 0) return [];
  return text.split("\n").slice(-Math.max(1, Math.round(n)));
}

export const CONSOLE_BUFFER_CAP_BYTES = 64 * 1024;

/**
 * A line buffer capped at a byte budget. Once the cap is exceeded, drops from the head
 * (oldest lines) and keeps the tail (most recent) — matching the "keep the last N KB of
 * console" semantics callers expect. Always keeps at least the most recent line, even if
 * that single line alone exceeds the cap. Pure/synchronous, so it's directly unit-testable.
 */
export class CappedLineBuffer {
  private lines: string[] = [];
  private bytes = 0;
  private readonly capBytes: number;
  truncated = false;

  constructor(capBytes: number = CONSOLE_BUFFER_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, "utf8") + 1;
    while (this.bytes > this.capBytes && this.lines.length > 1) {
      const removed = this.lines.shift() as string;
      this.bytes -= Buffer.byteLength(removed, "utf8") + 1;
      this.truncated = true;
    }
  }

  get text(): string {
    return this.lines.join("\n");
  }

  get all(): string[] {
    return [...this.lines];
  }
}

// ---------------------------------------------------------------------------
// WebSocket session plumbing — exercises real network I/O, so it is deliberately NOT covered
// by unit tests (per the console module spec: don't attempt to mock the WS handshake).
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS = 10_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const TAIL_COLLECT_MS = 2_000;
const MIN_WATCH_SECONDS = 1;
const MAX_WATCH_SECONDS = 120;
const MIN_CAPTURE_SECONDS = 1;
const MAX_CAPTURE_SECONDS = 60;

interface WebsocketCreds {
  token: string;
  socket: string;
}

function clampSeconds(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function originHint(): string {
  return (
    "Wings validates the Origin header on the WebSocket upgrade against the panel's base URL / " +
    "allowed_origins list — make sure the configured panel URL exactly matches what Wings expects " +
    "(scheme + host), and that the node is reachable with a valid TLS certificate."
  );
}

/** Encapsulates one Wings console WebSocket session: connect, auth, event handling, cleanup. */
class ConsoleSession {
  private readonly ref: ServerRef;
  private ws: WebSocket | undefined;
  private readonly buffer = new CappedLineBuffer();
  private readonly states: string[] = [];
  private authResolve: (() => void) | undefined;
  private authReject: ((err: Error) => void) | undefined;
  private authTimer: NodeJS.Timeout | undefined;
  private reauthAttempted = false;

  constructor(ref: ServerRef) {
    this.ref = ref;
  }

  private async fetchCreds(): Promise<WebsocketCreds> {
    const resp = await this.ref.panel.api<{ data: WebsocketCreds }>(
      "GET",
      `/servers/${this.ref.identifier}/websocket`
    );
    return resp.data;
  }

  /** Fetches WS credentials, opens the socket (with the mandatory Origin header), and completes the auth handshake. */
  async connect(): Promise<void> {
    const creds = await this.fetchCreds();
    await this.open(creds.socket);
    await this.authenticate(creds.token);
  }

  private open(socketUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(socketUrl, {
          headers: { Origin: this.ref.panel.baseUrl },
          handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
        });
      } catch (err) {
        reject(this.connectionError(err));
        return;
      }
      this.ws = ws;

      ws.on("open", () => {
        settled = true;
        resolve();
      });
      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(this.connectionError(err));
        }
      });
      ws.on("unexpected-response", (_req, res) => {
        if (!settled) {
          settled = true;
          reject(
            this.connectionError(
              new Error(`Server rejected the WebSocket upgrade with HTTP ${res.statusCode ?? "unknown"}`)
            )
          );
        }
        ws.terminate();
      });
      ws.on("message", (data) => this.handleMessage(data));
      ws.on("close", () => {
        // If we were still mid-auth when the socket closed, fail that wait instead of hanging.
        if (this.authReject) {
          const reject2 = this.authReject;
          this.clearAuthWait();
          reject2(
            new PanelError(
              `Console WebSocket for ${this.ref.name} (${this.ref.identifier}) closed before authentication completed`
            )
          );
        }
      });
    });
  }

  private connectionError(err: unknown): PanelError {
    const base = err instanceof Error ? err.message : String(err);
    return new PanelError(
      `Failed to open console WebSocket for ${this.ref.name} (${this.ref.identifier}): ${base} — ${originHint()}`
    );
  }

  private clearAuthWait(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = undefined;
    }
    this.authResolve = undefined;
    this.authReject = undefined;
  }

  private authenticate(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      this.authTimer = setTimeout(() => {
        this.clearAuthWait();
        reject(
          new PanelError(
            `Timed out waiting for WebSocket auth success on ${this.ref.name} (${this.ref.identifier})`
          )
        );
      }, AUTH_TIMEOUT_MS);
      this.sendAuth(token);
    });
  }

  private sendAuth(token: string): void {
    this.send({ event: "auth", args: [token] });
  }

  /** Asks Wings to replay recent console history (makes tail/watch instant on connect). */
  sendLogs(): void {
    this.send({ event: "send logs", args: [null] });
  }

  private send(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    const msg = parseWsMessage(rawDataToString(data));
    if (!msg) return;
    const [first] = msg.args;

    switch (msg.event) {
      case "auth success":
        if (this.authResolve) {
          const resolve = this.authResolve;
          this.clearAuthWait();
          resolve();
        }
        break;
      case "console output":
        if (typeof first === "string") {
          for (const line of splitConsoleLines(stripAnsi(first))) this.buffer.push(line);
        }
        break;
      case "status":
        if (typeof first === "string") {
          this.states.push(formatStateLine(new Date(), first));
        }
        break;
      case "token expiring":
        void this.reauthInPlace();
        break;
      case "token expired":
      case "jwt error":
        void this.handleAuthFailure();
        break;
      case "daemon message":
        if (typeof first === "string") {
          for (const line of splitConsoleLines(stripAnsi(first))) this.buffer.push(`[daemon] ${line}`);
        }
        break;
      case "install output":
        if (typeof first === "string") {
          for (const line of splitConsoleLines(stripAnsi(first))) this.buffer.push(`[install] ${line}`);
        }
        break;
      default:
        break;
    }
  }

  /** "token expiring": re-fetch a fresh token and send a new auth event in place — no reconnect. */
  private async reauthInPlace(): Promise<void> {
    try {
      const creds = await this.fetchCreds();
      this.sendAuth(creds.token);
    } catch {
      // Best-effort refresh. If it fails we risk the session dying later, which the
      // "token expired"/"jwt error" handler (or socket close) will fail out of gracefully.
    }
  }

  /** "token expired"/"jwt error": attempt exactly one re-auth, then give up and close. */
  private async handleAuthFailure(): Promise<void> {
    if (this.reauthAttempted) {
      this.close();
      return;
    }
    this.reauthAttempted = true;
    try {
      const creds = await this.fetchCreds();
      this.sendAuth(creds.token);
    } catch {
      this.close();
    }
  }

  /** Waits `ms`, collecting whatever events arrive in the meantime. */
  collect(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  result(): ConsoleResult {
    return { output: this.buffer.text, states: [...this.states], truncated: this.buffer.truncated };
  }

  /** Tears down the socket and any pending timers. Safe to call multiple times/paths (use in `finally`). */
  close(): void {
    this.clearAuthWait();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // best-effort cleanup — nothing useful to do if terminate() itself throws
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/** Connects, replays log history, collects for ~2s, and returns the last `lines` lines. */
export async function consoleTail(ref: ServerRef, lines = 100): Promise<ConsoleResult> {
  const wantLines = Math.max(1, Math.round(lines));
  const session = new ConsoleSession(ref);
  try {
    await session.connect();
    session.sendLogs();
    await session.collect(TAIL_COLLECT_MS);
  } finally {
    session.close();
  }
  const full = session.result();
  return { output: tailLines(full.output, wantLines).join("\n"), states: full.states, truncated: full.truncated };
}

/**
 * Connects and watches ONLY live output (+ state changes) for `seconds` (clamped 1-120).
 *
 * Deliberately does not replay log history: asking Wings for it made a 5-second watch return the
 * server's entire buffer back to boot — hundreds of lines to surface the handful produced during
 * the window, which is pure token waste for the caller. `consoleTail` is the tool for history.
 */
export async function consoleWatch(ref: ServerRef, seconds: number): Promise<ConsoleResult> {
  const watchMs = clampSeconds(seconds, MIN_WATCH_SECONDS, MAX_WATCH_SECONDS) * 1000;
  const session = new ConsoleSession(ref);
  try {
    await session.connect();
    await session.collect(watchMs);
  } finally {
    session.close();
  }
  return session.result();
}

/**
 * Opens/authenticates the console WebSocket FIRST, then sends `command` over REST, then
 * collects `captureSeconds` (clamped 1-60) of whatever the command produces on the console.
 */
export async function runAndCapture(
  ref: ServerRef,
  command: string,
  captureSeconds: number
): Promise<ConsoleResult> {
  const captureMs = clampSeconds(captureSeconds, MIN_CAPTURE_SECONDS, MAX_CAPTURE_SECONDS) * 1000;
  const session = new ConsoleSession(ref);
  try {
    await session.connect();
    try {
      await ref.panel.api("POST", `/servers/${ref.identifier}/command`, { command });
    } catch (err) {
      if (err instanceof PanelError && (err.status === 502 || err.status === 409)) {
        throw new PanelError(
          `${err.message} (the server is likely offline — commands can only be sent while it is running)`,
          err.status,
          err.detail
        );
      }
      throw err;
    }
    await session.collect(captureMs);
  } finally {
    session.close();
  }
  return session.result();
}
