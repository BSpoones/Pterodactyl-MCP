import { createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { posix as pathPosix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PanelError } from "./panel.js";
import type { ServerRef } from "./resolve.js";
import { sftpTransfer } from "./sftp.js";

/** Files over this size refuse an inline read unless tail_lines is given. */
export const MAX_INLINE_READ_BYTES = 1024 * 1024; // 1 MB

/** Files over this size skip the signed-URL REST upload and go straight to SFTP. */
export const SFTP_UPLOAD_THRESHOLD_BYTES = 95 * 1024 * 1024; // 95 MB

/** Formats a byte count as a short human-readable size (e.g. "3.42 KB", "1.2 GB"). */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const formatted = unitIdx === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1);
  return `${formatted} ${units[unitIdx]}`;
}

/** Returns just the last `n` lines of `content` (like `tail -n`). n <= 0 yields "". */
export function sliceLastLines(content: string, n: number): string {
  if (n <= 0) return "";
  const lines = content.split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Splits a remote (always POSIX-style, forward-slash) path into its parent directory and base name.
 * Backslashes are normalized to forward slashes and a leading slash is assumed even if omitted,
 * since Pterodactyl paths are always absolute within the server's filesystem root.
 */
export function splitRemotePath(filePath: string): { dir: string; name: string } {
  let normalized = filePath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  const dir = pathPosix.dirname(normalized);
  const name = pathPosix.basename(normalized);
  return { dir, name };
}

/** Joins a remote directory and a file/folder name using POSIX semantics, always forward-slashed. */
export function remoteJoin(dir: string, name: string): string {
  let normalizedDir = dir.replace(/\\/g, "/");
  if (!normalizedDir.startsWith("/")) normalizedDir = `/${normalizedDir}`;
  return pathPosix.join(normalizedDir, name);
}

/** Lists the contents of a directory on the server. Returns the raw `data` array from the API. */
export async function listFiles(ref: ServerRef, dir: string = "/"): Promise<any[]> {
  const response = await ref.panel.api<{ data: any[] }>(
    "GET",
    `/servers/${ref.identifier}/files/list`,
    undefined,
    { query: { directory: dir } }
  );
  return response.data ?? [];
}

/** Best-effort lookup of a file's size via its parent directory listing. Returns undefined if not found or on error. */
async function findEntrySize(ref: ServerRef, filePath: string): Promise<number | undefined> {
  const { dir, name } = splitRemotePath(filePath);
  try {
    const entries = await listFiles(ref, dir);
    const match = entries.find((e: any) => e?.attributes?.name === name);
    const size = match?.attributes?.size;
    return typeof size === "number" ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a text file's contents. Refuses files over 1 MB unless tailLines is given (in which case
 * the full content is still fetched from the panel, then sliced to the last N lines locally).
 */
export async function readFileContents(
  ref: ServerRef,
  filePath: string,
  tailLines?: number
): Promise<string> {
  if (tailLines === undefined) {
    const size = await findEntrySize(ref, filePath);
    if (size !== undefined && size > MAX_INLINE_READ_BYTES) {
      throw new PanelError(
        `"${filePath}" is ${humanSize(size)}, over the 1 MB inline-read limit. Pass tail_lines to read just the end of it.`
      );
    }
  }

  const content = await ref.panel.api<string>(
    "GET",
    `/servers/${ref.identifier}/files/contents`,
    undefined,
    { raw: true, query: { file: filePath } }
  );

  return tailLines !== undefined ? sliceLastLines(content, tailLines) : content;
}

/** Overwrites (or creates) a text file with the given content. */
export async function writeFileContents(ref: ServerRef, filePath: string, content: string): Promise<void> {
  await ref.panel.api<void>(
    "POST",
    `/servers/${ref.identifier}/files/write`,
    content,
    { raw: true, query: { file: filePath } }
  );
}

/**
 * Uploads a local file to the server. Files over ~95 MB go straight to the SFTP fallback (Wings'
 * REST upload endpoint caps out around 100 MB). Otherwise uses the signed-URL multipart upload,
 * falling back to SFTP if that fails for any reason. Returns a human-readable summary.
 */
export async function uploadFile(
  ref: ServerRef,
  localPath: string,
  remoteDir: string = "/"
): Promise<string> {
  let stat;
  try {
    stat = await fsp.stat(localPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new PanelError(`Local file not found: ${localPath}`);
    }
    throw new PanelError(
      `Could not read local file "${localPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!stat.isFile()) {
    throw new PanelError(`Local path is not a file: ${localPath}`);
  }

  const baseName = path.basename(localPath);
  const remoteFullPath = remoteJoin(remoteDir, baseName);
  const sizeLabel = humanSize(stat.size);

  if (stat.size > SFTP_UPLOAD_THRESHOLD_BYTES) {
    await sftpTransfer(ref, "upload", localPath, remoteFullPath);
    return `Uploaded "${baseName}" (${sizeLabel}) to ${remoteFullPath} via SFTP (file exceeds the ~95 MB REST upload limit).`;
  }

  let restError: string | undefined;
  try {
    const signed = await ref.panel.api<{ attributes: { url: string } }>(
      "GET",
      `/servers/${ref.identifier}/files/upload`
    );
    const signedUrl = signed.attributes.url;
    const uploadUrl = `${signedUrl}&directory=${encodeURIComponent(remoteDir)}`;

    const fileBuffer = await fsp.readFile(localPath);
    const form = new FormData();
    form.append("files", new Blob([fileBuffer]), baseName);

    const response = await fetch(uploadUrl, { method: "POST", body: form });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PanelError(
        `Signed-URL upload failed with HTTP ${response.status}${text ? `: ${text}` : ""}`,
        response.status
      );
    }
    return `Uploaded "${baseName}" (${sizeLabel}) to ${remoteFullPath} via signed-URL upload.`;
  } catch (err) {
    restError = err instanceof Error ? err.message : String(err);
  }

  try {
    await sftpTransfer(ref, "upload", localPath, remoteFullPath);
    return `Uploaded "${baseName}" (${sizeLabel}) to ${remoteFullPath} via SFTP fallback (signed-URL upload failed: ${restError}).`;
  } catch (sftpErr) {
    const sftpMsg = sftpErr instanceof Error ? sftpErr.message : String(sftpErr);
    throw new PanelError(
      `Upload of "${baseName}" failed via both signed-URL upload and SFTP fallback. Signed-URL error: ${restError}. SFTP error: ${sftpMsg}`
    );
  }
}

/** Downloads a remote file to a local path via the panel's signed download URL. Returns a summary. */
export async function downloadFile(
  ref: ServerRef,
  remotePath: string,
  localPath: string
): Promise<string> {
  const signed = await ref.panel.api<{ attributes: { url: string } }>(
    "GET",
    `/servers/${ref.identifier}/files/download`,
    undefined,
    { query: { file: remotePath } }
  );
  const signedUrl = signed.attributes.url;

  const response = await fetch(signedUrl);
  if (!response.ok || !response.body) {
    throw new PanelError(`Download failed with HTTP ${response.status} ${response.statusText}`, response.status);
  }

  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  const nodeStream = Readable.fromWeb(response.body as any);
  await pipeline(nodeStream, createWriteStream(localPath));

  const stat = await fsp.stat(localPath);
  return `Downloaded ${remotePath} to ${localPath} (${humanSize(stat.size)}).`;
}

export interface PullResult {
  /** True once a new/grown file was actually observed in the destination directory. */
  verified: boolean;
  /** Name of the file that appeared, when verified. */
  name?: string;
  /** Size in bytes at the moment it was observed — may still be growing. */
  size?: number;
  /** How long we waited before giving up, in seconds (only meaningful when !verified). */
  waitedSeconds?: number;
}

const PULL_POLL_INTERVAL_MS = 1500;
const PULL_VERIFY_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a directory listing to name -> size, so a poll can spot both new files and growing ones. */
async function directorySizes(ref: ServerRef, dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const entry of await listFiles(ref, dir)) {
    const name = entry?.attributes?.name;
    if (typeof name === "string") sizes.set(name, Number(entry?.attributes?.size ?? 0));
  }
  return sizes;
}

/**
 * Tells the server itself to download a URL into a directory (no local round-trip), then verifies
 * that something actually landed.
 *
 * The panel's pull endpoint is fire-and-forget — it returns 204 the moment the request is accepted,
 * long before (and regardless of whether) the download succeeds. Reporting that as success made the
 * tool claim a file had been fetched when nothing ever arrived, which is worse than a loud failure.
 * So snapshot the destination first, then poll it for a new or growing entry.
 */
export async function pullUrl(
  ref: ServerRef,
  url: string,
  directory: string = "/",
  timing: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<PullResult> {
  const pollIntervalMs = timing.pollIntervalMs ?? PULL_POLL_INTERVAL_MS;
  const timeoutMs = timing.timeoutMs ?? PULL_VERIFY_TIMEOUT_MS;
  // A listing failure here shouldn't block the pull itself — fall back to an empty snapshot, which
  // just means any entry present afterwards counts as new.
  let before: Map<string, number>;
  try {
    before = await directorySizes(ref, directory);
  } catch {
    before = new Map();
  }

  await ref.panel.api<void>("POST", `/servers/${ref.identifier}/files/pull`, { url, directory });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let after: Map<string, number>;
    try {
      after = await directorySizes(ref, directory);
    } catch {
      continue;
    }
    for (const [name, size] of after) {
      const previous = before.get(name);
      if (previous === undefined || size > previous) {
        return { verified: true, name, size };
      }
    }
  }
  return { verified: false, waitedSeconds: Math.round(timeoutMs / 1000) };
}
