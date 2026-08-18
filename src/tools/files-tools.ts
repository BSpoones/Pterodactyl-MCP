import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelError } from "../panel.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, ok, requireConfirm, wrap } from "../toolwrap.js";
import {
  downloadFile,
  humanSize,
  listFiles,
  pullUrl,
  readFileContents,
  uploadFile,
  writeFileContents,
} from "../files.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

/**
 * Rejects relative path arguments that climb out of their "root" via "..". Wings enforces the
 * server-root boundary itself, so this is not the security control — it exists so a traversal fails
 * loudly here instead of silently resolving somewhere the caller did not intend.
 */
export function assertNoTraversal(value: string, argName: string): string {
  if (value.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new PanelError(
      `"${argName}" must stay inside "root", but "${value}" contains a ".." segment. ` +
        `Pass the containing directory as "root" instead.`
    );
  }
  return value;
}

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

function entryName(entry: any): string {
  return entry?.attributes?.name ?? "";
}

function isDirectory(entry: any): boolean {
  return entry?.attributes?.is_file === false;
}

function byName(a: any, b: any): number {
  return entryName(a).localeCompare(entryName(b));
}

export function registerFilesTools(server: McpServer): void {
  server.registerTool(
    "list_files",
    {
      description:
        "List files and folders on a server at the given directory path. Directories are shown first with a trailing slash; files show human-readable size and last-modified date.",
      inputSchema: {
        server: serverArg,
        path: z.string().optional().default("/").describe('Directory to list (default "/").'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; path?: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const dir = args.path ?? "/";
      const entries = await listFiles(ref, dir);

      if (entries.length === 0) {
        return ok(`${dir} is empty.`);
      }

      const dirs = entries.filter(isDirectory).sort(byName);
      const files = entries.filter((e: any) => !isDirectory(e)).sort(byName);

      const lines: string[] = [`${dir}:`];
      for (const entry of dirs) {
        lines.push(`  ${entryName(entry)}/`);
      }
      for (const entry of files) {
        const attrs = entry.attributes ?? {};
        const size = humanSize(attrs.size ?? 0);
        const modified = attrs.modified_at ? new Date(attrs.modified_at).toISOString() : "unknown";
        lines.push(`  ${attrs.name}  ${size}  ${modified}`);
      }
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a text file's contents from a server. Refuses files over 1 MB unless tail_lines is given, in which case only the last N lines are returned.",
      inputSchema: {
        server: serverArg,
        path: z.string().describe("Absolute path of the file to read, e.g. /server.properties."),
        tail_lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("If given, return only the last N lines instead of the whole file (also lifts the 1 MB size limit)."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; path: string; tail_lines?: number; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const content = await readFileContents(ref, args.path, args.tail_lines);
      return ok(content);
    })
  );

  server.registerTool(
    "write_file",
    {
      description: "Write (overwrite or create) a text file on a server with the given content.",
      inputSchema: {
        server: serverArg,
        path: z.string().describe("Absolute path of the file to write, e.g. /server.properties."),
        content: z.string().describe("Full new content of the file."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; path: string; content: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      await writeFileContents(ref, args.path, args.content);
      return ok(`Wrote ${args.content.length} character(s) to ${args.path}.`);
    })
  );

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload a local file to the server (e.g. a plugin jar into /plugins). Files over ~95 MB automatically use SFTP.",
      inputSchema: {
        server: serverArg,
        local_path: z.string().describe("Path to the local file on this machine to upload."),
        remote_dir: z.string().optional().default("/").describe('Destination directory on the server (default "/").'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; local_path: string; remote_dir?: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const summary = await uploadFile(ref, args.local_path, args.remote_dir ?? "/");
      return ok(summary);
    })
  );

  server.registerTool(
    "download_file",
    {
      description: "Download a file from the server to a local path on this machine.",
      inputSchema: {
        server: serverArg,
        remote_path: z.string().describe("Absolute path of the file on the server to download."),
        local_path: z.string().describe("Local destination path (parent directories are created if needed)."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; remote_path: string; local_path: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const summary = await downloadFile(ref, args.remote_path, args.local_path);
      return ok(summary);
    })
  );

  server.registerTool(
    "pull_url",
    {
      description:
        "Have the SERVER itself download a file from a URL directly into its filesystem (e.g. installing a " +
        "plugin/mod jar from a download link) — no local round-trip through this machine. Waits up to 20s to " +
        "confirm a file actually landed, and says so explicitly if none did.",
      inputSchema: {
        server: serverArg,
        url: z.string().describe("URL for the server to download."),
        directory: z.string().optional().default("/").describe('Destination directory on the server (default "/").'),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; url: string; directory?: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const directory = args.directory ?? "/";
      const result = await pullUrl(ref, args.url, directory);
      if (result.verified) {
        return ok(
          `Pulled ${args.url} into ${directory} — "${result.name}" (${humanSize(result.size ?? 0)}) appeared on the server.`
        );
      }
      return ok(
        `The panel accepted the pull request for ${args.url} into ${directory}, but NO new file appeared ` +
          `there within ${result.waitedSeconds}s — treat this as failed, not pending. Common causes: the ` +
          `server cannot reach the URL, the URL returned an error page, or the destination is wrong. ` +
          `Re-check with list_files if you expect a very slow download.`
      );
    })
  );

  server.registerTool(
    "file_action",
    {
      description:
        "Perform a file/folder management action on a server: move (rename), copy, delete, mkdir, or chmod. delete is destructive and requires confirm: true.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["move", "copy", "delete", "mkdir", "chmod"]).describe("Which action to perform."),
        root: z
          .string()
          .optional()
          .default("/")
          .describe('Base directory that from/to, files, name, and file are relative to (default "/"). Used by move, delete, mkdir, chmod.'),
        from: z.string().optional().describe("move: current path (relative to root) of the file/folder."),
        to: z.string().optional().describe("move: new path (relative to root)."),
        location: z.string().optional().describe("copy: full absolute path of the file/folder to duplicate."),
        files: z
          .array(z.string())
          .optional()
          .describe("delete: paths (relative to root) to permanently delete."),
        name: z.string().optional().describe("mkdir: name of the new folder to create under root."),
        file: z.string().optional().describe("chmod: path (relative to root) of the file to change permissions on."),
        mode: z.string().optional().describe('chmod: permission mode to set, e.g. "0755".'),
        confirm: z.boolean().optional().describe("Must be true to actually perform a delete."),
        panel: panelArg,
      },
    },
    wrap(async (args: any) => {
      const ref = await resolveServer(args.server, args.panel);
      const root = args.root ?? "/";

      switch (args.action) {
        case "move": {
          if (!args.from || !args.to) {
            throw new PanelError('file_action("move") requires both "from" and "to".');
          }
          await ref.panel.api("PUT", `/servers/${ref.identifier}/files/rename`, {
            root,
            files: [{ from: args.from, to: args.to }],
          });
          return ok(`Moved/renamed ${args.from} -> ${args.to} (root ${root}).`);
        }
        case "copy": {
          if (!args.location) {
            throw new PanelError('file_action("copy") requires "location".');
          }
          await ref.panel.api("POST", `/servers/${ref.identifier}/files/copy`, { location: args.location });
          return ok(`Copied ${args.location}.`);
        }
        case "delete": {
          if (!args.files || args.files.length === 0) {
            throw new PanelError('file_action("delete") requires a non-empty "files" array.');
          }
          requireConfirm(
            args.confirm,
            `permanently delete ${args.files.length} item(s) under ${root}: ${args.files.join(", ")}`
          );
          await ref.panel.api("POST", `/servers/${ref.identifier}/files/delete`, { root, files: args.files });
          return ok(`Deleted ${args.files.length} item(s) under ${root}.`);
        }
        case "mkdir": {
          if (!args.name) {
            throw new PanelError('file_action("mkdir") requires "name".');
          }
          await ref.panel.api("POST", `/servers/${ref.identifier}/files/create-folder`, { root, name: args.name });
          return ok(`Created folder "${args.name}" under ${root}.`);
        }
        case "chmod": {
          if (!args.file || !args.mode) {
            throw new PanelError('file_action("chmod") requires both "file" and "mode".');
          }
          await ref.panel.api("POST", `/servers/${ref.identifier}/files/chmod`, {
            root,
            files: [{ file: args.file, mode: args.mode }],
          });
          return ok(`Set mode ${args.mode} on ${args.file} (root ${root}).`);
        }
        default:
          throw new PanelError(`Unknown file_action action: ${args.action}`);
      }
    })
  );

  server.registerTool(
    "archive",
    {
      description: "Compress files/folders into an archive, or decompress an existing archive, on a server.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["compress", "decompress"]).describe("Which action to perform."),
        root: z.string().optional().default("/").describe('Base directory that files/file are relative to (default "/").'),
        files: z
          .array(z.string())
          .optional()
          .describe("compress: paths (relative to root) to include in the new archive."),
        file: z.string().optional().describe("decompress: archive filename (relative to root) to extract."),
        panel: panelArg,
      },
    },
    wrap(async (args: any) => {
      const ref = await resolveServer(args.server, args.panel);
      const root = args.root ?? "/";

      if (args.action === "compress") {
        if (!args.files || args.files.length === 0) {
          throw new PanelError('archive("compress") requires a non-empty "files" array.');
        }
        for (const file of args.files) assertNoTraversal(file, "files[]");
        const response = await ref.panel.api<{ attributes?: any }>(
          "POST",
          `/servers/${ref.identifier}/files/compress`,
          { root, files: args.files }
        );
        const name = response?.attributes?.name;
        return name
          ? jsonBlock({ root, compressed: args.files, archive: name })
          : ok(`Compressed ${args.files.length} item(s) under ${root}.`);
      }

      if (args.action === "decompress") {
        if (!args.file) {
          throw new PanelError('archive("decompress") requires "file".');
        }
        assertNoTraversal(args.file, "file");
        await ref.panel.api("POST", `/servers/${ref.identifier}/files/decompress`, { root, file: args.file });
        return ok(`Decompressed ${args.file} under ${root}.`);
      }

      throw new PanelError(`Unknown archive action: ${args.action}`);
    })
  );
}
