import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { PanelClient, PanelError } from "../src/panel.js";
import { resetCfAccessCache } from "../src/cfaccess.js";

/**
 * Cloudflare Access is a transport-level gate, so these tests run the real request path against a
 * real local HTTP server and only vary how that server answers. Faking `fetch` would prove nothing —
 * the whole failure being covered here is what fetch does with Access's redirect.
 */
interface Stub {
  url: string;
  /** Headers of the most recent request the panel received. */
  lastHeaders: () => IncomingHttpHeaders;
  requestCount: () => number;
}

const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<Stub> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");

  let headers: IncomingHttpHeaders = {};
  let count = 0;
  server.on("request", (req) => {
    headers = req.headers;
    count++;
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    lastHeaders: () => headers,
    requestCount: () => count,
  };
}

/** A panel that answers the Client API normally. */
async function workingPanel(): Promise<Stub> {
  return listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ attributes: { username: "ben" } }));
  });
}

/** The Cloudflare Access SSO login page — HTML, 200, on a different host than the panel. */
async function accessLoginPage(): Promise<Stub> {
  return listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body>Sign in to continue</body></html>");
  });
}

function panelClient(url: string, cfAccess?: string): PanelClient {
  return new PanelClient("gated", cfAccess ? { url, client_key: "ptlc_test", cf_access: cfAccess } : { url, client_key: "ptlc_test" });
}

beforeEach(() => {
  resetCfAccessCache();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.PTERO_CLOUDFLARED_PATH;
});

describe("a panel behind Cloudflare Access", () => {
  it("explains the Access gate instead of failing to parse the login page as JSON", async () => {
    // The reported bug: fetch follows Access's 302 to an HTML page, and the JSON parse blamed the
    // panel for "Unexpected token '<'" — telling the user nothing about what was actually wrong.
    const gate = await accessLoginPage();
    const panel = await listen((_req, res) => {
      res.writeHead(302, { Location: gate.url });
      res.end();
    });

    const error = await panelClient(panel.url)
      .api("GET", "/account")
      .catch((err: unknown) => err as Error);

    expect(error.message).toMatch(/Cloudflare Access/);
    expect(error.message).not.toMatch(/Unexpected token|JSON/);
  });

  it("names the fix, so the error is actionable without reading the source", async () => {
    const gate = await accessLoginPage();
    const panel = await listen((_req, res) => {
      res.writeHead(302, { Location: gate.url });
      res.end();
    });

    await expect(panelClient(panel.url).api("GET", "/account")).rejects.toThrow(/cf_access/);
  });

  it("detects the login page even when Access serves it without a redirect", async () => {
    const panel = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body>Sign in</body></html>");
    });

    await expect(panelClient(panel.url).api("GET", "/account")).rejects.toThrow(/Cloudflare Access/);
  });

  it("sends a configured token as the cf-access-token header", async () => {
    const panel = await workingPanel();

    await panelClient(panel.url, "static.access.token").api("GET", "/account");

    expect(panel.lastHeaders()["cf-access-token"]).toBe("static.access.token");
  });

  it("keeps the Pterodactyl key alongside the Access token — both gates need satisfying", async () => {
    const panel = await workingPanel();

    await panelClient(panel.url, "static.access.token").api("GET", "/account");

    expect(panel.lastHeaders()["authorization"]).toBe("Bearer ptlc_test");
  });

  it("does not retry a rejected static token, since resending it cannot help", async () => {
    const gate = await accessLoginPage();
    const panel = await listen((_req, res) => {
      res.writeHead(302, { Location: gate.url });
      res.end();
    });

    await expect(panelClient(panel.url, "expired.static.token").api("GET", "/account")).rejects.toThrow(
      /expired/
    );
    expect(panel.requestCount()).toBe(1);
  });

  it("tells the user to log in when cloudflared has no cached session for the panel", async () => {
    const panel = await workingPanel();
    // Nothing can hold a cached Access login for an ephemeral 127.0.0.1 port, so this is the
    // "configured for cloudflared but never logged in" path regardless of what the machine has.
    const client = panelClient(panel.url, "cloudflared");

    await expect(client.api("GET", "/account")).rejects.toThrow(/cloudflared access login/);
  });

  it("reports a missing cloudflared binary with the command that installs it", async () => {
    process.env.PTERO_CLOUDFLARED_PATH = "/nonexistent/cloudflared";
    const panel = await workingPanel();

    await expect(panelClient(panel.url, "cloudflared").api("GET", "/account")).rejects.toThrow(
      /not installed or not on PATH/
    );
  });
});

describe("a panel with no Access gate", () => {
  it("is unaffected — no token is minted and no header is added", async () => {
    const panel = await workingPanel();

    const account = await panelClient(panel.url).api<{ attributes: { username: string } }>("GET", "/account");

    expect(account.attributes.username).toBe("ben");
    expect(panel.lastHeaders()["cf-access-token"]).toBeUndefined();
  });

  it("still reports a genuine panel error as a PanelError, not an Access problem", async () => {
    const panel = await listen((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ detail: "This action is unauthorized." }] }));
    });

    const error = await panelClient(panel.url)
      .api("GET", "/account")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PanelError);
    expect((error as PanelError).status).toBe(403);
    expect((error as PanelError).message).toContain("This action is unauthorized.");
  });
});
