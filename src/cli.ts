#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  loadConfig,
  loadFileConfig,
  saveConfig,
  configPath,
  validatePanelUrl,
  validateAlias,
  panelSource,
  type PanelConfig,
} from "./config.js";
import { getPanel, invalidatePanelCache, PanelError, type PanelClient } from "./panel.js";
import { CfAccessError, CLOUDFLARED_SENTINEL, resolveCfAccessToken } from "./cfaccess.js";
import { listAllServers } from "./resolve.js";

const USAGE = `ptero-mcp — Pterodactyl MCP server CLI

Usage:
  ptero-mcp add-panel <alias> --url <panel-url> --client-key <ptlc_...> [--app-key <ptla_...>] [--default]
  ptero-mcp set-sftp <alias> --host <ip-or-hostname> [--port <n>] | --clear
  ptero-mcp set-password <alias> [--clear]
  ptero-mcp doctor [alias]

Commands:
  add-panel     Register a panel from the command line (pasted client key) and save it to config.
  set-sftp      Override the SFTP host/port for a panel whose node FQDN is behind an HTTP-only proxy.
  set-password  Store a panel's SFTP password, prompted without echo (never on the command line).
  doctor        Verify a configured panel: auth, list servers, fetch a websocket token, SFTP readiness.

Panels can also be configured entirely via PTERO_<ALIAS>_URL / PTERO_<ALIAS>_KEY environment
variables in your MCP server settings — see README.md. add-panel/doctor manage the config-file
fallback (PTERO_MCP_CONFIG), which env vars take precedence over on a per-field basis.

Run \`ptero-mcp <command> --help\` for command-specific help.
`;

const ADD_PANEL_USAGE = `Usage: ptero-mcp add-panel <alias> --url <panel-url> --client-key <ptlc_...> [options]

Registers a panel and stores a Client API key for it.

Required:
  --url <url>                 Panel base URL (must be https://, e.g. https://panel.example.com)
  --client-key <ptlc_...>      A Client API key. Create one by logging into the panel in your
                               browser and visiting "<url>/account/api" -> "Create API Key".

Optional:
  --app-key <ptla_...>        Application API key (admin-only), enables the admin_request tool.
  --sftp-host <host>          Override the SFTP host the panel advertises (see set-sftp).
  --sftp-port <port>          Override the SFTP port the panel advertises (default: panel-reported).
  --cf-access <value>         Credential for a Cloudflare Access gate in front of the panel. Use
                               "cloudflared" to mint fresh tokens via the cloudflared CLI (needs no
                               Zero Trust admin rights), or pass a literal Access JWT.
  --default                   Make this panel the default for tools that omit "panel".

Examples:
  ptero-mcp add-panel prod --url https://panel.example.com --client-key ptlc_abc123... --default
  ptero-mcp add-panel prod --url https://panel.example.com --client-key ptlc_abc123... --cf-access cloudflared
`;

const SET_SFTP_USAGE = `Usage: ptero-mcp set-sftp <alias> --host <ip-or-hostname> [--port <n>]
       ptero-mcp set-sftp <alias> --clear

Overrides the SFTP address for a panel, taking precedence over the "sftp_details" the panel API
advertises. Needed when the node's FQDN sits behind a proxy that only forwards HTTP/HTTPS —
Cloudflare's orange cloud being the usual culprit. The panel keeps reporting that hostname, but it
never completes an SSH handshake on the SFTP port, so transfers hang until they time out.

Point --host at whichever address actually accepts the connection:
  - the node's origin IP (simplest, if the SFTP port is reachable there)
  - a DNS-only ("grey cloud") hostname for the node
  - 127.0.0.1, when a Cloudflare Tunnel / SSH forwarder is listening locally

Options:
  --host <host>   Host or IP to dial instead of the panel-advertised one.
  --port <n>      Port to dial instead of the panel-advertised one (1-65535).
  --clear         Remove the override; go back to whatever the panel reports.

Example:
  ptero-mcp set-sftp prod --host 203.0.113.10 --port 2022
`;

const SET_PASSWORD_USAGE = `Usage: ptero-mcp set-password <alias>
       ptero-mcp set-password <alias> --clear

Stores a panel account password for a panel, used **only** as SFTP auth when no SSH key is
configured. Never used to log into the panel itself — panel access is always API-key based.

The password is read from an interactive prompt with echo disabled, so it never appears on screen,
in your shell history, or in the output of whatever launched this. There is deliberately no
--password flag: anything passed as an argument ends up in history and process listings.

Prefer an SSH key where the panel supports it (the sftp_setup tool): a key only unlocks SFTP,
whereas an account password also unlocks the panel account itself.

Options:
  --clear   Remove the stored password for this panel.

Example:
  ptero-mcp set-password prod
`;

const DOCTOR_USAGE = `Usage: ptero-mcp doctor [alias]

Checks a configured panel (or every configured panel, if alias is omitted):
  - resolves a Cloudflare Access token, if the panel is configured to need one
  - authenticates against the Client API and prints the account username
  - lists servers visible to the key
  - fetches a console websocket token for the first server (does not connect)
  - reports SFTP readiness (ssh key on file, password on file, or neither)

Exits with status 1 if any panel fails authentication.
`;

function fail(message: string): never {
  throw new PanelError(message);
}

function describeError(err: unknown): string {
  return err instanceof PanelError ? err.message : err instanceof Error ? err.message : String(err);
}

/** True when a failure came from the Cloudflare Access gate rather than from the panel itself. */
function isAccessFailure(err: unknown): boolean {
  return err instanceof CfAccessError || (err instanceof PanelError && err.message.includes("Cloudflare Access"));
}

function normalizePanelUrl(input: string): string {
  const result = validatePanelUrl(input);
  if (!result.ok) {
    return fail(`--url ${result.error}`);
  }
  return result.url;
}

async function countServers(panel: PanelClient): Promise<number> {
  return (await listAllServers(panel.alias)).length;
}

/** Parses a --port/--sftp-port value, failing with a clear message rather than silently storing NaN. */
function parsePort(raw: string): number {
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Port must be an integer between 1 and 65535 (got "${raw}").`);
  }
  return port;
}

/**
 * Reads a secret from the terminal without echoing it, so it never reaches the screen, the shell's
 * history, or a scrollback buffer — the whole reason this exists instead of a --password flag.
 * Rejects rather than silently reading a pipe, since a non-TTY caller would have had to put the
 * secret on a command line to get here.
 */
function promptSecret(label: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(
      new PanelError(
        "set-password needs an interactive terminal to read the password without echoing it. Run it " +
          "directly in a shell rather than through a pipe or a tool that captures output."
      )
    );
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        // Ctrl-C / Ctrl-D — an explicit cancel, not an empty password.
        if (char === "\u0003" || char === "\u0004") {
          return finish(new PanelError("Cancelled — nothing was written."));
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    stdin.on("data", onData);
  });
}

async function cmdSetPassword(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      clear: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(SET_PASSWORD_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  if (!aliasArg) {
    fail("set-password requires a panel alias, e.g. `ptero-mcp set-password prod`");
  }
  const aliasResult = validateAlias(aliasArg);
  if (!aliasResult.ok) {
    fail(aliasResult.error);
  }
  const alias = aliasResult.alias;

  // The file layer, not the env-overlaid view — saving the merged config would copy any
  // env-var-only secrets from other panels onto disk as a side effect.
  const cfg = loadFileConfig();
  const panel = cfg.panels[alias];
  if (!panel) {
    fail(
      `No panel named "${alias}" in ${configPath()} — run \`ptero-mcp add-panel ${alias} --url ... --client-key ...\` first.`
    );
  }

  if (values.clear) {
    if (panel.password === undefined) {
      console.log(`"${alias}" had no stored password — nothing to clear.`);
      return;
    }
    delete panel.password;
    saveConfig(cfg);
    invalidatePanelCache();
    console.log(`Removed the stored SFTP password for "${alias}".`);
    return;
  }

  const password = await promptSecret(`SFTP password for "${alias}" (not shown): `);
  if (!password) {
    fail("No password entered — nothing was written. Use --clear to remove a stored password.");
  }

  panel.password = password;
  saveConfig(cfg);
  invalidatePanelCache();

  console.log(`Stored an SFTP password for "${alias}" in ${configPath()} (owner-only permissions).`);
  console.log(`Run \`ptero-mcp doctor ${alias}\` to confirm SFTP now reports an auth method.`);
}

async function cmdSetSftp(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      clear: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(SET_SFTP_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  if (!aliasArg) {
    fail("set-sftp requires a panel alias, e.g. `ptero-mcp set-sftp prod --host 203.0.113.10`");
  }
  const aliasResult = validateAlias(aliasArg);
  if (!aliasResult.ok) {
    fail(aliasResult.error);
  }
  const alias = aliasResult.alias;

  const cfg = loadConfig();
  const panel = cfg.panels[alias];
  if (!panel) {
    fail(`No panel named "${alias}" in ${configPath()} — run \`ptero-mcp add-panel ${alias} --url ... --client-key ...\` first.`);
  }

  if (values.clear) {
    delete panel.sftp_host;
    delete panel.sftp_port;
    saveConfig(cfg);
    invalidatePanelCache();
    console.log(`Cleared the SFTP override for "${alias}" — it will use whatever the panel advertises.`);
    return;
  }

  if (!values.host && !values.port) {
    fail("set-sftp requires --host <ip-or-hostname> and/or --port <n>, or --clear to remove the override.");
  }

  if (values.host) panel.sftp_host = values.host.trim();
  if (values.port) panel.sftp_port = parsePort(values.port);

  saveConfig(cfg);
  invalidatePanelCache();

  console.log(
    `SFTP override for "${alias}": ${panel.sftp_host ?? "(panel-advertised host)"}:` +
      `${panel.sftp_port ?? "(panel-advertised port)"}`
  );
  console.log(`Run \`ptero-mcp doctor ${alias}\` to confirm the address accepts a connection.`);
}

async function cmdAddPanel(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "client-key": { type: "string" },
      "app-key": { type: "string" },
      "sftp-host": { type: "string" },
      "sftp-port": { type: "string" },
      "cf-access": { type: "string" },
      default: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(ADD_PANEL_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  if (!aliasArg) {
    fail("add-panel requires an alias, e.g. `ptero-mcp add-panel prod --url https://panel.example.com --client-key ptlc_...`");
  }
  const aliasResult = validateAlias(aliasArg);
  if (!aliasResult.ok) {
    fail(aliasResult.error);
  }
  const alias = aliasResult.alias;
  if (!values.url) {
    fail("add-panel requires --url <panel-url>. Run `ptero-mcp add-panel --help` for details.");
  }

  const url = normalizePanelUrl(values.url);

  if (!values["client-key"]) {
    fail(
      `add-panel requires --client-key ptlc_... — create one by logging into the panel in your browser, ` +
        `visiting "${url}/account/api", and clicking "Create API Key". Then re-run: ` +
        `ptero-mcp add-panel ${alias} --url ${url} --client-key ptlc_...`
    );
  }

  const cfg = loadConfig();
  const merged: PanelConfig = { ...(cfg.panels[alias] ?? {}), url, client_key: values["client-key"] };
  if (values["app-key"]) merged.app_key = values["app-key"];
  if (values["sftp-host"]) merged.sftp_host = values["sftp-host"].trim();
  if (values["sftp-port"]) merged.sftp_port = parsePort(values["sftp-port"]);
  if (values["cf-access"]) merged.cf_access = values["cf-access"].trim();

  cfg.panels[alias] = merged;
  if (values.default) cfg.default_panel = alias;

  saveConfig(cfg);
  invalidatePanelCache();

  console.log(`Saved panel "${alias}" -> ${url} (${configPath()})`);

  let count: number;
  try {
    count = await countServers(getPanel(alias));
  } catch (err) {
    throw new PanelError(`Panel "${alias}" config was saved, but verification failed: ${describeError(err)}`);
  }
  console.log(`Verified: client key works — ${count} server(s) visible on "${alias}".`);
  if (values.default) {
    console.log(`"${alias}" is now the default panel.`);
  }
}

interface DoctorServer {
  identifier: string;
  name: string;
}

async function doctorPanel(alias: string): Promise<boolean> {
  let panel: PanelClient;
  try {
    panel = getPanel(alias);
  } catch (err) {
    console.log(`  ✖ config: ${describeError(err)}`);
    return true;
  }
  console.log(`  panel url: ${panel.baseUrl || "(not set)"}`);
  const source = panelSource(alias);
  const sourceLabel =
    source === "both" ? "environment variable(s) + config file (env wins per-field)" :
    source === "env" ? "environment variable(s)" :
    source === "file" ? "config file" :
    "(unknown)";
  console.log(`  source: ${sourceLabel}`);

  if (panel.cfg.cf_access === CLOUDFLARED_SENTINEL) {
    try {
      await resolveCfAccessToken(panel.cfg.cf_access, panel.baseUrl);
      console.log("  ✔ cloudflare access: cloudflared supplied a token");
    } catch (err) {
      // Every later check would fail identically at the edge, so stop here rather than repeat the
      // same Access error three more times under labels that imply unrelated causes.
      console.log(`  ✖ cloudflare access: ${describeError(err)}`);
      console.log("  - auth, servers, websocket: skipped (blocked by Cloudflare Access)");
      return true;
    }
  } else if (panel.cfg.cf_access) {
    console.log('  ✔ cloudflare access: static token configured (expires without warning — prefer "cloudflared")');
  }

  let authOk = false;
  try {
    const account = await panel.api<{ attributes: { username?: string; email?: string } }>("GET", "/account");
    const attrs = account.attributes;
    console.log(`  ✔ auth: logged in as ${attrs.username ?? attrs.email ?? "(unknown)"}`);
    authOk = true;
  } catch (err) {
    // A rejected Access token is not a client_key problem — the key never reached the panel.
    const hint = isAccessFailure(err) ? "" : " — check client_key, or re-run add-panel.";
    console.log(`  ✖ auth: ${describeError(err)}${hint}`);
  }

  let servers: DoctorServer[] = [];
  try {
    const list = await listAllServers(panel.alias);
    servers = list.map((s) => ({ identifier: s.attributes.identifier, name: s.attributes.name }));
    const names = servers.length > 0 ? ` — ${servers.map((s) => s.name).join(", ")}` : "";
    console.log(`  ✔ servers: ${servers.length} visible${names}`);
  } catch (err) {
    console.log(`  ✖ servers: ${describeError(err)}`);
  }

  if (servers.length > 0) {
    const first = servers[0]!;
    try {
      const ws = await panel.api<{ data: { token?: string; socket?: string } }>(
        "GET",
        `/servers/${first.identifier}/websocket`
      );
      if (ws.data.token) {
        console.log(`  ✔ websocket: console token OK (${first.name})`);
      } else {
        console.log(`  ✖ websocket: response had no token (${first.name})`);
      }
    } catch (err) {
      console.log(`  ✖ websocket: ${describeError(err)}`);
    }
  } else {
    console.log("  - websocket: skipped (no servers)");
  }

  const panelCfg = panel.cfg;
  if (panelCfg.ssh_key && existsSync(panelCfg.ssh_key)) {
    console.log(`  ✔ sftp: ssh key present (${panelCfg.ssh_key})`);
  } else if (panelCfg.password) {
    console.log("  ✔ sftp: password available for fallback auth");
  } else {
    console.log("  ✖ sftp: no ssh key or password configured — run sftp_setup, or add a password to the panel config.");
  }

  return !authOk;
}

async function cmdDoctor(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });

  if (values.help) {
    console.log(DOCTOR_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  const cfg = loadConfig();
  const aliases = aliasArg ? [aliasArg] : Object.keys(cfg.panels);

  if (aliases.length === 0) {
    fail(
      "No panels configured yet — set PTERO_<ALIAS>_URL / PTERO_<ALIAS>_KEY environment variables in your MCP " +
        "server settings (see README.md), or run `ptero-mcp add-panel` to use the config-file fallback."
    );
  }

  let anyFailed = false;
  for (const alias of aliases) {
    console.log(`\n=== ${alias} ===`);
    const failed = await doctorPanel(alias);
    if (failed) anyFailed = true;
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "add-panel":
      await cmdAddPanel(rest);
      return;
    case "set-sftp":
      await cmdSetSftp(rest);
      return;
    case "set-password":
      await cmdSetPassword(rest);
      return;
    case "doctor":
      await cmdDoctor(rest);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  if (err instanceof PanelError) {
    console.error(err.message);
  } else {
    console.error("Fatal error:", err);
  }
  process.exitCode = 1;
});
