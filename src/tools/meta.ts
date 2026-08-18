import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allPanels, getPanel } from "../panel.js";
import { CLOUDFLARED_SENTINEL } from "../cfaccess.js";
import { loadConfig, panelSource } from "../config.js";
import { listAllServers, resolveServer } from "../resolve.js";
import { jsonBlock, wrap } from "../toolwrap.js";

function humanizeUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Reports how a panel satisfies a Cloudflare Access gate, without ever echoing a literal token. */
function describeCfAccess(cfAccess: string | undefined): "none" | "cloudflared" | "static-token" {
  if (!cfAccess) return "none";
  return cfAccess === CLOUDFLARED_SENTINEL ? "cloudflared" : "static-token";
}

const panelArg = z.string().optional().describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "list_panels",
    {
      description:
        "List configured Pterodactyl panels (alias, base URL, source, whether client/application API keys are set, and how any Cloudflare Access gate is satisfied). Never prints the actual key or token values. Optionally restrict to a single panel alias.",
      inputSchema: {
        panel: panelArg,
      },
    },
    wrap(async (args: { panel?: string }) => {
      const cfg = loadConfig();
      const clients = args.panel !== undefined ? [getPanel(args.panel)] : allPanels();
      const result = clients.map((client) => ({
        alias: client.alias,
        url: client.baseUrl,
        source: panelSource(client.alias) ?? "unknown",
        is_default: cfg.default_panel === client.alias,
        has_client_key: Boolean(client.cfg.client_key),
        has_app_key: Boolean(client.cfg.app_key),
        cf_access: describeCfAccess(client.cfg.cf_access),
      }));
      return jsonBlock(result);
    })
  );

  server.registerTool(
    "list_servers",
    {
      description:
        "List servers visible to the configured API key(s). Optionally restrict to one panel by alias. Returns name, identifier, node, and status for each server.",
      inputSchema: {
        panel: panelArg,
      },
    },
    wrap(async (args: { panel?: string }) => {
      const servers = await listAllServers(args.panel);
      const result = servers.map((s) => ({
        panel: s.panel,
        name: s.attributes.name,
        identifier: s.attributes.identifier,
        node: s.attributes.node,
        status: s.attributes.status ?? (s.attributes.is_suspended ? "suspended" : "unknown"),
      }));
      return jsonBlock(result);
    })
  );

  server.registerTool(
    "server_info",
    {
      description:
        "Get detailed info for one server: name, identifier, uuid, node, status, SFTP connection details, resource limits, docker image, and startup invocation. Resolves the server by alias-qualified id, short identifier, UUID, or a unique (case-insensitive) name substring.",
      inputSchema: {
        server: z
          .string()
          .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const response = await ref.panel.api<{ attributes: any }>("GET", `/servers/${ref.identifier}`);
      const attrs = response.attributes;
      return jsonBlock({
        panel: ref.panel.alias,
        name: attrs.name,
        identifier: attrs.identifier,
        uuid: attrs.uuid,
        node: attrs.node,
        status: attrs.status,
        sftp_details: attrs.sftp_details,
        limits: attrs.limits,
        docker_image: attrs.docker_image,
        invocation: attrs.invocation,
      });
    })
  );

  server.registerTool(
    "server_resources",
    {
      description:
        "Get live resource usage for a server: power state, CPU percent, memory used/limit (MB), disk used (MB), and humanized uptime.",
      inputSchema: {
        server: z
          .string()
          .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const [infoResp, resResp] = await Promise.all([
        ref.panel.api<{ attributes: any }>("GET", `/servers/${ref.identifier}`),
        ref.panel.api<{ attributes: any }>("GET", `/servers/${ref.identifier}/resources`),
      ]);
      const limits = infoResp.attributes.limits ?? {};
      const resAttrs = resResp.attributes ?? {};
      const usage = resAttrs.resources ?? {};
      const memoryUsedMb = Math.round((usage.memory_bytes ?? 0) / 1024 / 1024);
      const diskUsedMb = Math.round((usage.disk_bytes ?? 0) / 1024 / 1024);
      return jsonBlock({
        panel: ref.panel.alias,
        name: ref.name,
        identifier: ref.identifier,
        state: resAttrs.current_state,
        cpu_percent: usage.cpu_absolute ?? 0,
        memory_used_mb: memoryUsedMb,
        memory_limit_mb: limits.memory ?? null,
        disk_used_mb: diskUsedMb,
        disk_limit_mb: limits.disk ?? null,
        uptime: humanizeUptime(usage.uptime ?? 0),
      });
    })
  );

  server.registerTool(
    "activity_log",
    {
      description: "Get the 25 most recent activity log entries for a server (event, actor, timestamp).",
      inputSchema: {
        server: z
          .string()
          .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const response = await ref.panel.api<{ data: Array<{ attributes: any }> }>(
        "GET",
        `/servers/${ref.identifier}/activity`
      );
      const entries = (response.data ?? []).map((entry) => {
        const attrs = entry.attributes ?? {};
        const actor =
          attrs.relationships?.actor?.attributes?.username ??
          attrs.relationships?.actor?.attributes?.email ??
          attrs.actor ??
          "system";
        return {
          event: attrs.event,
          actor,
          timestamp: attrs.timestamp ?? attrs.created_at,
        };
      });
      entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return jsonBlock(entries.slice(0, 25));
    })
  );
}
