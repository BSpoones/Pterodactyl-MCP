import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPanel, PanelError } from "../panel.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, ok, requireConfirm, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

const confirmArg = z.boolean().optional().default(false);

/** Formats a byte count as a human-readable size (B/KB/MB/GB). Exported for unit testing. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Parses a JSON-encoded request body string for admin_request, throwing a clear PanelError on invalid JSON. */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new PanelError(
      `"body" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function requireArg<T>(value: T | undefined, argName: string, action: string): T {
  if (value === undefined || value === null || (typeof value === "string" && value.length === 0)) {
    throw new PanelError(`"${argName}" is required for action "${action}"`);
  }
  return value;
}

function linesOrNone(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

export function registerManagementTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // backups
  // ---------------------------------------------------------------------
  server.registerTool(
    "backups",
    {
      description:
        "Manage server backups. Actions: list (name, uuid, size, created, locked, successful), " +
        "create (optional name), delete (requires confirm: true), lock (toggle lock protection on a backup), " +
        "download_url (get a signed download URL for a completed backup).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["list", "create", "delete", "lock", "download_url"]).describe("Which backup operation to perform."),
        name: z.string().optional().describe("Backup name (create only, optional)."),
        backup_uuid: z.string().optional().describe("Backup UUID (required for delete, lock, download_url)."),
        confirm: confirmArg.describe("Must be true to delete a backup."),
      },
    },
    wrap(
      async (args: {
        server: string;
        panel?: string;
        action: "list" | "create" | "delete" | "lock" | "download_url";
        name?: string;
        backup_uuid?: string;
        confirm?: boolean;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/backups`;

        switch (args.action) {
          case "list": {
            const resp = await ref.panel.api<{ data: Array<{ attributes: any }> }>("GET", base);
            const lines = (resp.data ?? []).map((entry) => {
              const a = entry.attributes ?? {};
              return `${a.name || "(unnamed)"} — ${a.uuid} — ${formatBytes(a.bytes ?? 0)} — created ${a.created_at} — locked:${Boolean(a.is_locked)} — successful:${Boolean(a.is_successful)}`;
            });
            return ok(linesOrNone(lines));
          }
          case "create": {
            const body: Record<string, unknown> = {};
            if (args.name) body.name = args.name;
            const resp = await ref.panel.api<{ attributes: any }>("POST", base, body);
            const a = resp.attributes ?? {};
            return jsonBlock({
              uuid: a.uuid,
              name: a.name,
              bytes: a.bytes,
              created_at: a.created_at,
              is_locked: a.is_locked,
              is_successful: a.is_successful,
            });
          }
          case "delete": {
            const uuid = requireArg(args.backup_uuid, "backup_uuid", "delete");
            requireConfirm(args.confirm, `permanently delete backup ${uuid} for server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${uuid}`);
            return ok(`Deleted backup ${uuid} for ${ref.name}.`);
          }
          case "lock": {
            const uuid = requireArg(args.backup_uuid, "backup_uuid", "lock");
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${uuid}/lock`);
            const locked = resp?.attributes?.is_locked;
            return ok(
              locked !== undefined
                ? `Backup ${uuid} lock toggled — is_locked: ${locked}.`
                : `Backup ${uuid} lock toggled.`
            );
          }
          case "download_url": {
            const uuid = requireArg(args.backup_uuid, "backup_uuid", "download_url");
            const resp = await ref.panel.api<{ attributes: { url: string } }>("GET", `${base}/${uuid}/download`);
            return ok(`Download URL for backup ${uuid} (expires soon): ${resp.attributes?.url}`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // backup_restore
  // ---------------------------------------------------------------------
  server.registerTool(
    "backup_restore",
    {
      description:
        "Restore a backup onto this server. WARNING: if truncate is true, ALL current files on the server are " +
        "DELETED before the backup contents are restored. Requires confirm: true.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        backup_uuid: z.string().describe("UUID of the backup to restore."),
        truncate: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, DELETES all current files on the server before restoring. Default false (merge over existing files)."),
        confirm: confirmArg.describe("Must be true to perform the restore."),
      },
    },
    wrap(
      async (args: { server: string; panel?: string; backup_uuid: string; truncate?: boolean; confirm?: boolean }) => {
        const ref = await resolveServer(args.server, args.panel);
        const truncate = args.truncate ?? false;
        requireConfirm(
          args.confirm,
          truncate
            ? `restore backup ${args.backup_uuid} onto ${ref.name}, DELETING ALL CURRENT FILES first (truncate=true)`
            : `restore backup ${args.backup_uuid} onto ${ref.name} (merging over existing files)`
        );
        await ref.panel.api("POST", `/servers/${ref.identifier}/backups/${args.backup_uuid}/restore`, { truncate });
        return ok(`Restore of backup ${args.backup_uuid} initiated for ${ref.name} (truncate: ${truncate}).`);
      }
    )
  );

  // ---------------------------------------------------------------------
  // databases
  // ---------------------------------------------------------------------
  server.registerTool(
    "databases",
    {
      description:
        "Manage server databases. Actions: list (name, host, username, connection string — password never shown), " +
        "create (database name + remote, default remote '%' — response includes the generated password once), " +
        "rotate_password (database_id — response includes the new password once), delete (database_id, requires confirm: true).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["list", "create", "rotate_password", "delete"]).describe("Which database operation to perform."),
        database: z.string().optional().describe("Database name (create only)."),
        remote: z.string().optional().describe('Allowed connection host/wildcard (create only). Default "%".'),
        database_id: z.string().optional().describe("Database ID (required for rotate_password, delete)."),
        confirm: confirmArg.describe("Must be true to delete a database."),
      },
    },
    wrap(
      async (args: {
        server: string;
        panel?: string;
        action: "list" | "create" | "rotate_password" | "delete";
        database?: string;
        remote?: string;
        database_id?: string;
        confirm?: boolean;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/databases`;

        switch (args.action) {
          case "list": {
            // A panel with no database host configured for the node answers this endpoint with a bare
            // 500 rather than an empty list, which reads as "this tool is broken" instead of "there is
            // nothing here to list". Re-throw with the likely cause attached.
            let resp: { data: Array<{ attributes: any }> };
            try {
              resp = await ref.panel.api<{ data: Array<{ attributes: any }> }>("GET", base);
            } catch (err) {
              if (err instanceof PanelError && err.status === 500) {
                throw new PanelError(
                  `Panel "${ref.panel.alias}" returned 500 listing databases for ${ref.name}. That usually means ` +
                    `no database host is configured for this node (an admin sets one up in the panel's admin area), ` +
                    `not that the request was malformed. Original error: ${err.message}`
                );
              }
              throw err;
            }
            const lines = (resp.data ?? []).map((entry) => {
              const a = entry.attributes ?? {};
              const host = a.host ?? {};
              return `${a.name} — id:${a.id} — ${a.username}@${host.address}:${host.port} — connection: ${a.username}@${host.address}:${host.port}/${a.name}`;
            });
            return ok(linesOrNone(lines));
          }
          case "create": {
            const database = requireArg(args.database, "database", "create");
            const resp = await ref.panel.api<{ attributes: any }>("POST", base, {
              database,
              remote: args.remote ?? "%",
            });
            const a = resp.attributes ?? {};
            const host = a.host ?? {};
            const password = a.relationships?.password?.attributes?.password;
            return jsonBlock({
              id: a.id,
              name: a.name,
              username: a.username,
              host,
              password: password ?? "(not returned by panel — check the panel UI)",
            });
          }
          case "rotate_password": {
            const id = requireArg(args.database_id, "database_id", "rotate_password");
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${id}/rotate-password`);
            const a = resp.attributes ?? {};
            const password = a.relationships?.password?.attributes?.password;
            return jsonBlock({
              id: a.id,
              name: a.name,
              username: a.username,
              password: password ?? "(not returned by panel — check the panel UI)",
            });
          }
          case "delete": {
            const id = requireArg(args.database_id, "database_id", "delete");
            requireConfirm(args.confirm, `permanently delete database ${id} for server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${id}`);
            return ok(`Deleted database ${id} for ${ref.name}.`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // schedules
  // ---------------------------------------------------------------------
  server.registerTool(
    "schedules",
    {
      description:
        "Manage server task schedules (cron-like automation). Actions: list, view (schedule + its tasks + next run), " +
        "create/update (name, minute/hour/day_of_week/day_of_month/month cron fields as strings default '*', is_active, only_when_online), " +
        "delete (requires confirm: true), execute (run now), " +
        "add_task/update_task/delete_task (schedule_id, task_action: command|power|backup, payload — the command text, the power signal, " +
        "or ignored for backup, time_offset in seconds, task_id for update_task/delete_task). delete_task requires confirm: true.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z
          .enum(["list", "view", "create", "update", "delete", "execute", "add_task", "update_task", "delete_task"])
          .describe("Which schedule operation to perform."),
        schedule_id: z.string().optional().describe("Schedule ID (required for all actions except list/create)."),
        name: z.string().optional().describe("Schedule name (create/update)."),
        minute: z.string().optional().describe('Cron minute field (create/update). Default "*".'),
        hour: z.string().optional().describe('Cron hour field (create/update). Default "*".'),
        day_of_week: z.string().optional().describe('Cron day-of-week field (create/update). Default "*".'),
        day_of_month: z.string().optional().describe('Cron day-of-month field (create/update). Default "*".'),
        month: z.string().optional().describe('Cron month field (create/update). Default "*".'),
        is_active: z.boolean().optional().describe("Whether the schedule is active (create/update)."),
        only_when_online: z.boolean().optional().describe("Only run this schedule while the server is online (create/update)."),
        task_action: z.enum(["command", "power", "backup"]).optional().describe("Task type (add_task, or update_task to change it)."),
        payload: z
          .string()
          .optional()
          .describe("Task payload: the console command for 'command', the power signal for 'power', ignored for 'backup'."),
        time_offset: z.number().int().optional().describe("Seconds to wait after the previous task before running this one."),
        task_id: z.string().optional().describe("Task ID (required for update_task, delete_task)."),
        confirm: confirmArg.describe("Must be true to delete a schedule or a task."),
      },
    },
    wrap(
      async (args: {
        server: string;
        panel?: string;
        action: "list" | "view" | "create" | "update" | "delete" | "execute" | "add_task" | "update_task" | "delete_task";
        schedule_id?: string;
        name?: string;
        minute?: string;
        hour?: string;
        day_of_week?: string;
        day_of_month?: string;
        month?: string;
        is_active?: boolean;
        only_when_online?: boolean;
        task_action?: "command" | "power" | "backup";
        payload?: string;
        time_offset?: number;
        task_id?: string;
        confirm?: boolean;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/schedules`;

        function formatSchedule(a: any): string {
          const cron = a.cron ?? {};
          return `#${a.id} "${a.name}" — active:${Boolean(a.is_active)} online_only:${Boolean(a.only_when_online)} — cron: ${cron.minute ?? "*"} ${cron.hour ?? "*"} ${cron.day_of_month ?? "*"} ${a.month ?? cron.month ?? "*"} ${cron.day_of_week ?? "*"} — last_run:${a.last_run_at ?? "never"} next_run:${a.next_run_at ?? "n/a"}`;
        }

        function formatTask(a: any): string {
          return `  task #${a.id} seq:${a.sequence_id} action:${a.action} payload:"${a.payload ?? ""}" offset:${a.time_offset}s continue_on_failure:${Boolean(a.continue_on_failure)}`;
        }

        switch (args.action) {
          case "list": {
            const resp = await ref.panel.api<{ data: Array<{ attributes: any }> }>("GET", base);
            const lines = (resp.data ?? []).map((entry) => formatSchedule(entry.attributes ?? {}));
            return ok(linesOrNone(lines));
          }
          case "view": {
            const id = requireArg(args.schedule_id, "schedule_id", "view");
            const resp = await ref.panel.api<{ attributes: any }>("GET", `${base}/${id}`, undefined, {
              query: { include: "tasks" },
            });
            const a = resp.attributes ?? {};
            const tasks = a.relationships?.tasks?.data ?? [];
            const lines = [formatSchedule(a), ...tasks.map((t: any) => formatTask(t.attributes ?? {}))];
            return ok(lines.join("\n"));
          }
          case "create": {
            const name = requireArg(args.name, "name", "create");
            const body = {
              name,
              minute: args.minute ?? "*",
              hour: args.hour ?? "*",
              day_of_week: args.day_of_week ?? "*",
              day_of_month: args.day_of_month ?? "*",
              month: args.month ?? "*",
              is_active: args.is_active ?? true,
              only_when_online: args.only_when_online ?? false,
            };
            const resp = await ref.panel.api<{ attributes: any }>("POST", base, body);
            return jsonBlock(resp.attributes);
          }
          case "update": {
            const id = requireArg(args.schedule_id, "schedule_id", "update");
            const existingResp = await ref.panel.api<{ attributes: any }>("GET", `${base}/${id}`);
            const existing = existingResp.attributes ?? {};
            const cron = existing.cron ?? {};
            const body = {
              name: args.name ?? existing.name,
              minute: args.minute ?? cron.minute ?? "*",
              hour: args.hour ?? cron.hour ?? "*",
              day_of_week: args.day_of_week ?? cron.day_of_week ?? "*",
              day_of_month: args.day_of_month ?? cron.day_of_month ?? "*",
              month: args.month ?? "*",
              is_active: args.is_active ?? existing.is_active ?? true,
              only_when_online: args.only_when_online ?? existing.only_when_online ?? false,
            };
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${id}`, body);
            return jsonBlock(resp.attributes);
          }
          case "delete": {
            const id = requireArg(args.schedule_id, "schedule_id", "delete");
            requireConfirm(args.confirm, `permanently delete schedule ${id} (and its tasks) for server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${id}`);
            return ok(`Deleted schedule ${id} for ${ref.name}.`);
          }
          case "execute": {
            const id = requireArg(args.schedule_id, "schedule_id", "execute");
            await ref.panel.api("POST", `${base}/${id}/execute`);
            return ok(`Triggered immediate execution of schedule ${id} for ${ref.name}.`);
          }
          case "add_task": {
            const id = requireArg(args.schedule_id, "schedule_id", "add_task");
            const taskAction = requireArg(args.task_action, "task_action", "add_task");
            const body = {
              action: taskAction,
              payload: args.payload ?? "",
              time_offset: args.time_offset ?? 0,
              continue_on_failure: false,
            };
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${id}/tasks`, body);
            return jsonBlock(resp.attributes);
          }
          case "update_task": {
            const id = requireArg(args.schedule_id, "schedule_id", "update_task");
            const taskId = requireArg(args.task_id, "task_id", "update_task");
            const scheduleResp = await ref.panel.api<{ attributes: any }>("GET", `${base}/${id}`, undefined, {
              query: { include: "tasks" },
            });
            const tasks = scheduleResp.attributes?.relationships?.tasks?.data ?? [];
            const existingTask = tasks.find((t: any) => String(t.attributes?.id) === String(taskId))?.attributes ?? {};
            const body = {
              action: args.task_action ?? existingTask.action,
              payload: args.payload ?? existingTask.payload ?? "",
              time_offset: args.time_offset ?? existingTask.time_offset ?? 0,
              continue_on_failure: existingTask.continue_on_failure ?? false,
            };
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${id}/tasks/${taskId}`, body);
            return jsonBlock(resp.attributes);
          }
          case "delete_task": {
            const id = requireArg(args.schedule_id, "schedule_id", "delete_task");
            const taskId = requireArg(args.task_id, "task_id", "delete_task");
            requireConfirm(args.confirm, `permanently delete task ${taskId} from schedule ${id} for server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${id}/tasks/${taskId}`);
            return ok(`Deleted task ${taskId} from schedule ${id} for ${ref.name}.`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // allocations
  // ---------------------------------------------------------------------
  server.registerTool(
    "allocations",
    {
      description:
        "Manage server network allocations (ip:port pairs). Actions: list (ip, port, primary flag, notes), " +
        "create (auto-assigns a new allocation from the node's available pool), set_primary (allocation_id), " +
        "set_note (allocation_id + note), delete (allocation_id, requires confirm: true).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["list", "create", "set_primary", "set_note", "delete"]).describe("Which allocation operation to perform."),
        allocation_id: z.string().optional().describe("Allocation ID (required for set_primary, set_note, delete)."),
        note: z.string().optional().describe("Note text (set_note only)."),
        confirm: confirmArg.describe("Must be true to delete an allocation."),
      },
    },
    wrap(
      async (args: {
        server: string;
        panel?: string;
        action: "list" | "create" | "set_primary" | "set_note" | "delete";
        allocation_id?: string;
        note?: string;
        confirm?: boolean;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/network/allocations`;

        switch (args.action) {
          case "list": {
            const resp = await ref.panel.api<{ data: Array<{ attributes: any }> }>("GET", base);
            const lines = (resp.data ?? []).map((entry) => {
              const a = entry.attributes ?? {};
              return `${a.ip}:${a.port}${a.ip_alias ? ` (alias ${a.ip_alias})` : ""} — id:${a.id} — primary:${Boolean(a.is_default)} — notes:${a.notes ?? "(none)"}`;
            });
            return ok(linesOrNone(lines));
          }
          case "create": {
            const resp = await ref.panel.api<{ attributes: any }>("POST", base);
            const a = resp.attributes ?? {};
            return jsonBlock({ id: a.id, ip: a.ip, port: a.port, ip_alias: a.ip_alias, is_default: a.is_default, notes: a.notes });
          }
          case "set_primary": {
            const id = requireArg(args.allocation_id, "allocation_id", "set_primary");
            await ref.panel.api("POST", `${base}/${id}/primary`);
            return ok(`Allocation ${id} set as primary for ${ref.name}.`);
          }
          case "set_note": {
            const id = requireArg(args.allocation_id, "allocation_id", "set_note");
            const note = requireArg(args.note, "note", "set_note");
            await ref.panel.api("POST", `${base}/${id}`, { notes: note });
            return ok(`Updated note on allocation ${id} for ${ref.name}.`);
          }
          case "delete": {
            const id = requireArg(args.allocation_id, "allocation_id", "delete");
            requireConfirm(args.confirm, `remove allocation ${id} from server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${id}`);
            return ok(`Deleted allocation ${id} for ${ref.name}.`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // subusers
  // ---------------------------------------------------------------------
  server.registerTool(
    "subusers",
    {
      description:
        "Manage server subusers (additional accounts with scoped access to this server). Actions: list, " +
        "create (email + permissions array), update (subuser_uuid + permissions array), delete (subuser_uuid, requires confirm: true). " +
        "Common permission strings: control.console, control.start, control.stop, control.restart, " +
        "file.read, file.read-content, file.create, file.update, file.delete, file.archive, file.sftp, " +
        "backup.create, backup.read, backup.delete, backup.restore, allocation.read, startup.read, startup.update, " +
        "database.read, database.create, schedule.read, schedule.create, websocket.connect.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["list", "create", "update", "delete"]).describe("Which subuser operation to perform."),
        email: z.string().optional().describe("Email address to invite as a subuser (create only)."),
        permissions: z.array(z.string()).optional().describe("Permission strings to grant (create/update)."),
        subuser_uuid: z.string().optional().describe("Subuser UUID (required for update, delete)."),
        confirm: confirmArg.describe("Must be true to delete a subuser."),
      },
    },
    wrap(
      async (args: {
        server: string;
        panel?: string;
        action: "list" | "create" | "update" | "delete";
        email?: string;
        permissions?: string[];
        subuser_uuid?: string;
        confirm?: boolean;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/users`;

        switch (args.action) {
          case "list": {
            const resp = await ref.panel.api<{ data: Array<{ attributes: any }> }>("GET", base);
            const lines = (resp.data ?? []).map((entry) => {
              const a = entry.attributes ?? {};
              return `${a.email ?? a.username} — uuid:${a.uuid} — permissions: ${(a.permissions ?? []).join(", ") || "(none)"}`;
            });
            return ok(linesOrNone(lines));
          }
          case "create": {
            const email = requireArg(args.email, "email", "create");
            const permissions = requireArg(args.permissions, "permissions", "create");
            const resp = await ref.panel.api<{ attributes: any }>("POST", base, { email, permissions });
            const a = resp.attributes ?? {};
            return jsonBlock({ uuid: a.uuid, email: a.email, permissions: a.permissions });
          }
          case "update": {
            const uuid = requireArg(args.subuser_uuid, "subuser_uuid", "update");
            const permissions = requireArg(args.permissions, "permissions", "update");
            const resp = await ref.panel.api<{ attributes: any }>("POST", `${base}/${uuid}`, { permissions });
            const a = resp.attributes ?? {};
            return jsonBlock({ uuid: a.uuid, email: a.email, permissions: a.permissions });
          }
          case "delete": {
            const uuid = requireArg(args.subuser_uuid, "subuser_uuid", "delete");
            requireConfirm(args.confirm, `remove subuser ${uuid} from server ${ref.name}`);
            await ref.panel.api("DELETE", `${base}/${uuid}`);
            return ok(`Deleted subuser ${uuid} for ${ref.name}.`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // startup
  // ---------------------------------------------------------------------
  server.registerTool(
    "startup",
    {
      description:
        "View or change server startup variables. Actions: list (variable name, env key, current value, default, editable flag, " +
        "and the resolved startup command preview), set (key + value → updates one environment variable).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["list", "set"]).describe("Which startup operation to perform."),
        key: z.string().optional().describe("Environment variable key (set only), e.g. SERVER_JARFILE."),
        value: z.string().optional().describe("New value for the variable (set only)."),
      },
    },
    wrap(
      async (args: { server: string; panel?: string; action: "list" | "set"; key?: string; value?: string }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/servers/${ref.identifier}/startup`;

        switch (args.action) {
          case "list": {
            const resp = await ref.panel.api<{ data: Array<{ attributes: any }>; meta?: { startup_command?: string } }>(
              "GET",
              base
            );
            const lines = (resp.data ?? []).map((entry) => {
              const a = entry.attributes ?? {};
              return `${a.name} [${a.env_variable}] = ${a.server_value ?? "(unset)"} — default: ${a.default_value ?? "(none)"} — editable:${Boolean(a.is_editable)}`;
            });
            const command = resp.meta?.startup_command;
            const header = command ? [`Startup command: ${command}`] : [];
            return ok(linesOrNone([...header, ...lines]));
          }
          case "set": {
            const key = requireArg(args.key, "key", "set");
            const value = requireArg(args.value, "value", "set");
            const resp = await ref.panel.api<{ attributes: any }>("PUT", `${base}/variable`, { key, value });
            const a = resp?.attributes ?? {};
            return ok(`Set ${key} = ${a.server_value ?? value} for ${ref.name}.`);
          }
        }
      }
    )
  );

  // ---------------------------------------------------------------------
  // server_settings
  // ---------------------------------------------------------------------
  server.registerTool(
    "server_settings",
    {
      description:
        "Change basic server settings. Actions: rename (value = new server name), " +
        "set_docker_image (value = new docker image tag to run the server with).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        action: z.enum(["rename", "set_docker_image"]).describe("Which setting to change."),
        value: z.string().describe("New value: the server name for rename, or the docker image for set_docker_image."),
      },
    },
    wrap(async (args: { server: string; panel?: string; action: "rename" | "set_docker_image"; value: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      switch (args.action) {
        case "rename": {
          await ref.panel.api("POST", `/servers/${ref.identifier}/settings/rename`, { name: args.value });
          return ok(`Renamed ${ref.name} to "${args.value}".`);
        }
        case "set_docker_image": {
          await ref.panel.api("PUT", `/servers/${ref.identifier}/settings/docker-image`, { docker_image: args.value });
          return ok(`Set docker image for ${ref.name} to "${args.value}".`);
        }
      }
    })
  );

  // ---------------------------------------------------------------------
  // reinstall_server
  // ---------------------------------------------------------------------
  server.registerTool(
    "reinstall_server",
    {
      description:
        "Wipe and re-run the egg install script for this server. This can delete server files depending on the egg's " +
        "install script and will take the server offline during reinstall. Requires confirm: true.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
        confirm: confirmArg.describe("Must be true to reinstall."),
      },
    },
    wrap(async (args: { server: string; panel?: string; confirm?: boolean }) => {
      const ref = await resolveServer(args.server, args.panel);
      requireConfirm(args.confirm, `wipe and re-run the egg install script for server ${ref.name}`);
      await ref.panel.api("POST", `/servers/${ref.identifier}/settings/reinstall`);
      return ok(`Reinstall triggered for ${ref.name}.`);
    })
  );

  // ---------------------------------------------------------------------
  // admin_request
  // ---------------------------------------------------------------------
  server.registerTool(
    "admin_request",
    {
      description:
        "Raw Pterodactyl Application (admin) API escape hatch — requires an app_key configured for the panel. " +
        "For admin operations not covered by other tools: managing users, nodes, eggs, creating/deleting servers.",
      inputSchema: {
        panel: z.string().describe("Panel alias (required) — must have an app_key configured."),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method for the Application API call."),
        path: z.string().describe('Application API path, must start with "/", e.g. "/users", "/servers", "/nodes".'),
        body: z.string().optional().describe('Optional JSON-encoded request body, e.g. \'{"email":"a@b.com"}\'.'),
      },
    },
    wrap(async (args: { panel: string; method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: string }) => {
      if (!args.path.startsWith("/") || args.path.includes("://")) {
        throw new PanelError(
          `"path" must start with "/" and be a relative Application API path, e.g. "/users" (got "${args.path}")`
        );
      }
      const parsedBody = args.body !== undefined ? parseJsonBody(args.body) : undefined;
      const panel = getPanel(args.panel);
      const response = await panel.appApi(args.method, args.path, parsedBody);
      return jsonBlock(response ?? { status: "ok (no content)" });
    })
  );
}
