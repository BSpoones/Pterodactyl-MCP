import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerPowerTools } from "./tools/power.js";
import { registerConsoleTools } from "./tools/console-tools.js";
import { registerFilesTools } from "./tools/files-tools.js";
import { registerSftpTools } from "./tools/sftp-tools.js";
import { registerManagementTools } from "./tools/management.js";

// CRITICAL: never console.log in this process — stdout is the MCP JSON-RPC channel.
// Use console.error for any diagnostic output.

async function main(): Promise<void> {
  const server = new McpServer({ name: "pterodactyl", version: "0.1.0" });

  registerMetaTools(server);
  registerPowerTools(server);
  registerConsoleTools(server);
  registerFilesTools(server);
  registerSftpTools(server);
  registerManagementTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting ptero-mcp server:", err);
  process.exit(1);
});
