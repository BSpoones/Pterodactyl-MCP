import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveServer } from "../resolve.js";
import { ok, wrap } from "../toolwrap.js";
import { consoleTail, consoleWatch, type ConsoleResult } from "../console.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

function countLines(output: string): number {
  return output.length === 0 ? 0 : output.split("\n").length;
}

/** Renders a ConsoleResult as plain text: a one-line header, optional state-change section, then output. */
function formatResult(header: string, result: ConsoleResult): string {
  const parts: string[] = [header];
  if (result.truncated) {
    parts.push("(buffer was capped at 64 KB — showing only the most recent output)");
  }
  if (result.states.length > 0) {
    parts.push("", "State changes:", ...result.states, "", "Console output:");
  }
  parts.push(result.output.length > 0 ? result.output : "(no output captured)");
  return parts.join("\n");
}

export function registerConsoleTools(server: McpServer): void {
  server.registerTool(
    "console_tail",
    {
      description:
        "Read recent console output/history from a server (instant — replays the log buffer). Use for diagnosing crashes, checking boot progress, reading errors.",
      inputSchema: {
        server: serverArg,
        lines: z.number().optional().default(100).describe("Number of most recent console lines to return."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; lines?: number; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const result = await consoleTail(ref, args.lines ?? 100);
      const actualLines = countLines(result.output);
      const header = `— last ${actualLines} line${actualLines === 1 ? "" : "s"} from ${ref.name} (${ref.identifier}) —`;
      return ok(formatResult(header, result));
    })
  );

  server.registerTool(
    "console_watch",
    {
      description:
        "Watch live console output for N seconds; also reports power-state changes. Returns ONLY output " +
        "produced during the window — no history replay, so a short watch stays cheap. Use console_tail for " +
        "what already happened, and this to see what happens next (e.g. right after a restart).",
      inputSchema: {
        server: serverArg,
        seconds: z.number().min(1).max(120).describe("How many seconds to watch the live console (clamped to 1-120)."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; seconds: number; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const result = await consoleWatch(ref, args.seconds);
      const clampedSeconds = Math.min(120, Math.max(1, Math.round(args.seconds)));
      const header = `— ${clampedSeconds}s console watch of ${ref.name} (${ref.identifier}) —`;
      return ok(formatResult(header, result));
    })
  );
}
