import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveServer } from "../resolve.js";
import { sftpSetup, sftpTransfer } from "../sftp.js";
import { ok, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

export function registerSftpTools(server: McpServer): void {
  server.registerTool(
    "sftp_transfer",
    {
      description:
        "Transfer files/directories over SFTP. Use for large files (>100 MB) or bulk/recursive transfers; upload_file handles small files more simply.",
      inputSchema: {
        server: serverArg,
        direction: z.enum(["upload", "download"]).describe('Transfer direction: "upload" (local -> remote) or "download" (remote -> local).'),
        local_path: z.string().describe("Local filesystem path (file or directory) to upload from, or to download into."),
        remote_path: z
          .string()
          .describe("Remote path on the server (POSIX-style, forward slashes) to upload to, or to download from."),
        panel: panelArg,
      },
    },
    wrap(
      async (args: {
        server: string;
        direction: "upload" | "download";
        local_path: string;
        remote_path: string;
        panel?: string;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const summary = await sftpTransfer(ref, args.direction, args.local_path, args.remote_path);
        return ok(summary);
      }
    )
  );

  server.registerTool(
    "sftp_setup",
    {
      description:
        "One-time SFTP setup for a panel: generates an SSH key and registers it with your account (key mode), or verifies password auth. Run before first sftp_transfer.",
      inputSchema: {
        panel: z.string().describe("Panel alias to set up SFTP for."),
        mode: z
          .enum(["key", "password"])
          .default("key")
          .describe(
            'Setup mode: "key" generates and registers an ed25519 SSH key (recommended, no stored password needed); "password" verifies the panel account password already in config works for SFTP.'
          ),
      },
    },
    wrap(async (args: { panel: string; mode?: "key" | "password" }) => {
      const summary = await sftpSetup(args.panel, args.mode ?? "key");
      return ok(summary);
    })
  );
}
