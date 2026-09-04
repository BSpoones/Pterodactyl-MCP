import { z } from "zod";
import path from "node:path";
import fsp from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listFiles, uploadFile, humanSize } from "../files.js";
import { withLiveConfirmed } from "../live.js";
import { runAndCapture } from "../console.js";
import { resolveServer, type ServerRef } from "../resolve.js";
import { jsonBlock, wrap } from "../toolwrap.js";

/**
 * One call for a jar deploy, because doing it by hand is six calls and two of them get skipped.
 *
 * The skipped ones cost real time: on 26 Aug a jar sat unpulled for 80 minutes because nobody
 * checked it had landed, and on 27 Aug a "restarted, running" report was disproved by
 * decompiling the live jar. So this uploads, removes the stale copy, restarts, and then PROVES
 * the new file is on disk with the right size before it reports success.
 */

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;

/** "plugin-scaling-groups-core-1.2.3.jar" -> "plugin-scaling-groups-core" */
function jarPrefix(fileName: string): string {
  return fileName.replace(/\.jar$/i, "").replace(/-\d.*$/, "");
}

async function waitForRunning(ref: ServerRef): Promise<{ state: string; elapsedMs: number }> {
  const start = Date.now();
  for (;;) {
    const resp = await ref.panel.api<{ attributes: any }>("GET", `/servers/${ref.identifier}/resources`);
    const state = resp.attributes?.current_state as string | undefined;
    const elapsedMs = Date.now() - start;
    if (state === "running") return { state, elapsedMs };
    if (elapsedMs >= POLL_TIMEOUT_MS) return { state: state ?? "unknown", elapsedMs };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    "deploy_jar",
    {
      description:
        "Deploy a plugin/mod jar to a server in one call: upload it, delete the stale copy of the " +
        "same jar, restart, wait for running, then VERIFY the new file is on disk at the right size " +
        "and report any errors from the console. Replaces the six-call upload/move/delete/restart/" +
        "check/tail sequence, and closes the 'restarted but the jar never landed' failure. Refuses " +
        "live servers unless confirm_live is passed.",
      inputSchema: {
        server: z.string().describe('Server reference: "alias:name-or-id", an 8-char identifier, or a unique name substring.'),
        local_jar: z.string().describe("Absolute path to the built jar on this machine."),
        mods_dir: z.string().optional().describe('Remote directory, default "/mods". Cobblemon Islands uses /mods/synx.'),
        restart: z.boolean().optional().describe("Restart after upload. Default true - a jar does not load until restart."),
        watch_seconds: z.number().optional().describe("Seconds of console to capture after boot, for errors. Default 8."),
        keep_stale: z.boolean().optional().describe("Skip deleting the previous version of the same jar. Default false."),
        confirm_live: z.boolean().optional().describe("Required to write to a LIVE server. Only pass this when the user has just said so in this turn."),
        panel: z.string().optional(),
      },
    },
    wrap(async (args: any) =>
      withLiveConfirmed(args.confirm_live, async () => {
        const ref = await resolveServer(args.server, args.panel);
        const modsDir: string = args.mods_dir ?? "/mods";
        const localJar: string = args.local_jar;
        const newName = path.basename(localJar);
        const prefix = jarPrefix(newName);

        const local = await fsp.stat(localJar).catch(() => null);
        if (!local || !local.isFile()) throw new Error(`local jar not found: ${localJar}`);

        const before = await listFiles(ref, modsDir);
        const stale = before
          .map((f: any) => f.attributes ?? f)
          .filter((f: any) => f.is_file && /\.jar$/i.test(f.name))
          .filter((f: any) => jarPrefix(f.name) === prefix && f.name !== newName)
          .map((f: any) => f.name);

        const steps: string[] = [];
        await uploadFile(ref, localJar, modsDir);
        steps.push(`uploaded ${newName} (${humanSize(local.size)}) to ${modsDir}`);

        if (stale.length && !args.keep_stale) {
          await ref.panel.api("POST", `/servers/${ref.identifier}/files/delete`, {
            root: modsDir,
            files: stale,
          });
          steps.push(`deleted stale: ${stale.join(", ")}`);
        } else if (stale.length) {
          steps.push(`kept stale (keep_stale): ${stale.join(", ")}`);
        }

        let restarted: { state: string; elapsedMs: number } | null = null;
        if (args.restart !== false) {
          await ref.panel.api("POST", `/servers/${ref.identifier}/power`, { signal: "restart" });
          restarted = await waitForRunning(ref);
          steps.push(`restart -> ${restarted.state} in ${Math.round(restarted.elapsedMs / 1000)}s`);
        }

        // Verification, not assumption: the file must be there, at the right size.
        const after = await listFiles(ref, modsDir);
        const landed = after
          .map((f: any) => f.attributes ?? f)
          .find((f: any) => f.name === newName);
        const sizeMatches = Boolean(landed && Number(landed.size) === local.size);
        const stillStale = after
          .map((f: any) => f.attributes ?? f)
          .filter((f: any) => stale.includes(f.name))
          .map((f: any) => f.name);

        let consoleTail: string[] = [];
        let errors: string[] = [];
        if (args.restart !== false && restarted?.state === "running") {
          const captured = await runAndCapture(ref, "list", Number(args.watch_seconds ?? 8));
          const lines = String(captured.output ?? "")
            .split(String.fromCharCode(10))
            .map((l) => l.trim())
            .filter(Boolean);
          consoleTail = lines.slice(-12);
          errors = lines.filter((l) => /ERROR|Exception|Caused by|FAILED/i.test(l)).slice(-8);
        }

        const ok = Boolean(landed) && sizeMatches && stillStale.length === 0 && errors.length === 0;
        return jsonBlock({
          ok,
          server: `${ref.name} (${ref.identifier}) on ${ref.panel.alias}`,
          jar: newName,
          steps,
          verified: {
            present: Boolean(landed),
            remoteSize: landed?.size ?? null,
            localSize: local.size,
            sizeMatches,
            staleRemaining: stillStale,
          },
          consoleErrors: errors,
          consoleTail,
          note: ok
            ? "jar is on disk at the expected size, server is running, no console errors in the window"
            : "NOT proven - read verified/consoleErrors before claiming this deployed",
        });
      }),
    ),
  );
}
