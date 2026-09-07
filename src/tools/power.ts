import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelError } from "../panel.js";
import { assertWriteAllowed } from "../policy.js";
import { resolveServer, type ServerRef } from "../resolve.js";
import { confirmLiveArg, jsonBlock, ok, wrap } from "../toolwrap.js";
import { runAndCapture } from "../console.js";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

async function pollForState(ref: ServerRef, targetStates: string[]): Promise<{ state: string; elapsedMs: number }> {
  const start = Date.now();
  for (;;) {
    const resp = await ref.panel.api<{ attributes: any }>("GET", `/servers/${ref.identifier}/resources`);
    const state = resp.attributes?.current_state as string | undefined;
    const elapsedMs = Date.now() - start;
    if (state && targetStates.includes(state)) {
      return { state, elapsedMs };
    }
    if (elapsedMs >= POLL_TIMEOUT_MS) {
      return { state: state ?? "unknown", elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export function registerPowerTools(server: McpServer): void {
  server.registerTool(
    "power",
    {
      description:
        "Send a power action (start, stop, restart, kill) to a server. With wait: true, polls resource state every 3s (up to 120s) until the server reaches the expected end state, then reports the final state and elapsed time. " +
        "Refused on LIVE servers without confirm_live - a restart drops every player on the box.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["start", "stop", "restart", "kill"]).describe("Power signal to send."),
        wait: z.boolean().optional().default(false).describe("If true, poll until the server reaches the target state (or 120s timeout)."),
        confirm_live: confirmLiveArg,
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; action: "start" | "stop" | "restart" | "kill"; wait?: boolean; confirm_live?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      assertWriteAllowed(ref, { tool: "power", action: args.action, confirmLive: args.confirm_live });
      await ref.panel.api("POST", `/servers/${ref.identifier}/power`, { signal: args.action });

      if (!args.wait) {
        return ok(`Sent "${args.action}" to ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
      }

      const targetStates = args.action === "start" || args.action === "restart" ? ["running"] : ["offline"];
      const { state, elapsedMs } = await pollForState(ref, targetStates);
      const reached = targetStates.includes(state);
      return jsonBlock({
        server: ref.name,
        identifier: ref.identifier,
        panel: ref.panel.alias,
        action: args.action,
        final_state: state,
        reached_target: reached,
        elapsed_seconds: Math.round(elapsedMs / 1000),
      });
    })
  );

  server.registerTool(
    "send_command",
    {
      description:
        "Send a console command to a running server. If capture_seconds > 0, opens the console WebSocket " +
        "first, then sends the command, and returns just the output it produced (no history replay) — the " +
        "cheapest way to read a command's answer. The server must be running; a 502/409 response usually " +
        "means it is offline. Refused on LIVE servers without confirm_live.",
      inputSchema: {
        server: serverArg,
        command: z.string().describe("The console command to send, exactly as typed in-game/in-console."),
        capture_seconds: z
          .number()
          .optional()
          .default(0)
          .describe("If > 0, capture this many seconds of console output produced after sending the command."),
        confirm_live: confirmLiveArg,
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; command: string; capture_seconds?: number; confirm_live?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      assertWriteAllowed(ref, { tool: "send_command", confirmLive: args.confirm_live });
      const captureSeconds = args.capture_seconds ?? 0;

      if (captureSeconds > 0) {
        const result = await runAndCapture(ref, args.command, captureSeconds);
        return jsonBlock(result);
      }

      try {
        await ref.panel.api("POST", `/servers/${ref.identifier}/command`, { command: args.command });
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

      return ok(`Sent command to ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );
}
