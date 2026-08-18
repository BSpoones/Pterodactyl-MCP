# Pterodactyl-MCP

An MCP server that gives Claude full control of your Pterodactyl panels: power, live console (WebSocket with history replay), files, SFTP, backups, schedules, databases, allocations, subusers, startup vars, and an admin API escape hatch. Multi-panel aware — tools resolve servers by name across every panel you've added.

## Setup

**1. Build** (Node 22+):

```
npm install
npm run build
```

**2. Create a Client API key.** Log into your panel in a browser, go to **`<your-panel-url>/account/api`**, and click **Create API Key**. This is your `ptlc_...` key — it acts as you, scoped to whatever servers your account can see. Repeat per panel if you use more than one.

**3. Register the MCP server with your panel(s) as environment variables.** This is the primary, recommended way to configure panels — no CLI flags or files to manage. Each panel is declared with two env vars: `PTERO_<ALIAS>_URL` and `PTERO_<ALIAS>_KEY`, where `<ALIAS>` is whatever short name you want to refer to that panel by (e.g. `PROD`, `BLOOM`).

Using the Claude Code CLI:

```
claude mcp add --scope user pterodactyl -e PTERO_PROD_URL=https://panel.example.com -e PTERO_PROD_KEY=ptlc_XXXX -e PTERO_DEFAULT_PANEL=prod -- node /path/to/Pterodactyl-MCP/dist/server.js
```


Add more panels by repeating the pattern with a different alias, e.g. `PTERO_BLOOM_URL` / `PTERO_BLOOM_KEY`. Aliases are lowercased automatically and must otherwise look like `[a-z0-9][a-z0-9_-]*`.

**Env var naming convention:**

| Suffix | Field | Required? |
|---|---|---|
| `PTERO_<ALIAS>_URL` | Panel base URL (must be `https://`, or `http://` for `localhost`/`127.0.0.1`) | Yes |
| `PTERO_<ALIAS>_KEY` | Client API key (`ptlc_...`) | Yes |
| `PTERO_<ALIAS>_APP_KEY` | Application API key (`ptla_...`), **admin-only** | No — enables the `admin_request` tool for that panel |
| `PTERO_<ALIAS>_SSH_KEY` | Path to an SFTP private key file | No — normally written by the `sftp_setup` tool |
| `PTERO_<ALIAS>_PASSWORD` | Panel account password, used **only** as an SFTP auth fallback | No — never used for panel login |
| `PTERO_<ALIAS>_CF_ACCESS` | Cloudflare Access credential: `cloudflared`, or a literal Access JWT | No — only for panels behind Cloudflare Access |

Plus one server-wide variable: `PTERO_DEFAULT_PANEL` sets which panel alias tools use when they omit `panel` and more than one panel is configured.

**4. Verify:**

```
node dist/cli.js doctor
```

Checks each configured panel: key auth, server visibility, console token, SFTP readiness, and prints whether each panel came from env vars or the config-file fallback (see below).

New Claude sessions can then do things like:

> "upload build.jar to the lobby server's /plugins and restart it, then watch the console for errors"

### Optional: config-file fallback

If you'd rather not put keys in your MCP settings, `ptero-mcp add-panel` writes panels to a local config file instead (`%USERPROFILE%\.ptero-mcp\config.json` by default, override with `PTERO_MCP_CONFIG`):

```
node dist/cli.js add-panel prod --url https://panel.example.com --client-key ptlc_XXXX --default
```

Env vars and the config file can be used together — for any given panel alias, env vars win on a per-field basis, so you can, for example, keep a panel's URL/key in the config file but override its `app_key` via an env var without touching the file. The config file is also where `sftp_setup` and `add-panel` write to on disk; it's created with restrictive permissions (owner-only on Windows/Unix).

## Panels behind Cloudflare Access

If a panel is fronted by Cloudflare Access (Zero Trust), the API key alone gets you nowhere: Access
intercepts at the edge and answers every API call with a redirect to your SSO login page, so the
request never reaches Pterodactyl. The symptom is a tool failing on HTML it expected to be JSON.

You don't need Zero Trust admin rights to fix this. `cloudflared` has an end-user login flow that
mints tokens scoped to *you*, honouring whatever policy already grants your account access:

```
winget install --id Cloudflare.cloudflared          # or brew install cloudflared
cloudflared access login https://panel.example.com  # completes your normal SSO in a browser
```

Then mark the panel as gated — `"cloudflared"` tells the MCP to ask the CLI for a fresh token per
request, caching it until just before it expires:

```
node dist/cli.js add-panel prod --url https://panel.example.com --client-key ptlc_XXXX --cf-access cloudflared
```

or `PTERO_PROD_CF_ACCESS=cloudflared`, or `"cf_access": "cloudflared"` in the panel's config entry.

This survives token rotation without intervention, and keeps the token out of your config file. When
the cached login eventually expires, tools fail with the exact `cloudflared access login` command to
re-run rather than a parse error.

`cf_access` also accepts a literal Access JWT (e.g. the `CF_Authorization` cookie copied from your
browser's devtools) if you can't install `cloudflared`. That token expires with your SSO session and
has to be replaced by hand, so prefer the CLI. Set `PTERO_CLOUDFLARED_PATH` if `cloudflared` lives
somewhere off your `PATH`.

A Zero Trust admin can instead issue a **service token** and add a policy allowing it, or bypass
Access for `/api/*` — but neither is needed for the setup above.

## SFTP (optional, for files >100 MB or bulk transfers)

Ask Claude to run `sftp_setup` for a panel. Key mode generates an ed25519 key, registers it with your panel account via the API, and stores it under `~/.ptero-mcp/` — no password ever stored. Prefer this where the panel supports it (Pterodactyl 1.11+): a key only unlocks SFTP, whereas an account password also unlocks the panel account.

For panels without key support, store a password instead:

```
node dist/cli.js set-password <alias>
```

This prompts with echo disabled, so the password never reaches your screen, your shell history, or the output of whatever launched it. There is deliberately no `--password` flag — an argument would land in both history and process listings. `--clear` removes a stored password. It must be run in a real terminal; it refuses to read from a pipe rather than accept a secret that had to be passed as an argument to get there.

`PTERO_<ALIAS>_PASSWORD` and a hand-added `"password": "..."` in the config entry both still work. Note that env var names cannot contain hyphens, so a panel whose alias has one (e.g. `my-panel`) can only take a password via the config file or `set-password` — `PTERO_MY_PANEL_PASSWORD` would silently define a *separate* `my_panel` panel.

The first time Claude connects over SFTP to a given host:port, it remembers the server's host key in `~/.ptero-mcp/known_hosts.json` (trust-on-first-use). If that host key ever changes unexpectedly on a later connection, the tool refuses to connect rather than silently trusting a possibly-different machine — see the error message for how to clear the stored entry if the change was expected (e.g. the node was reinstalled).

## Notes

- Auth is **API-key only** by design — no panel passwords are used or stored for login.
- Destructive tools (`reinstall_server`, `backup_restore`, deletes) refuse to run without `confirm: true`.
- Tools accept an optional `panel` arg (alias) — omit it and servers resolve by unique name match across all panels.
- 29 tools total; run `node scripts/smoke.mjs` to list them.
- Unit tests: `npm test`.
