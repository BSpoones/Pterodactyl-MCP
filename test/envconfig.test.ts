import { describe, it, expect } from "vitest";
import { loadEnvPanels, validateAlias } from "../src/config.js";

describe("loadEnvPanels", () => {
  it("parses a basic PTERO_<ALIAS>_URL / PTERO_<ALIAS>_KEY pair", () => {
    const result = loadEnvPanels({
      PTERO_PROD_URL: "https://panel.example.com",
      PTERO_PROD_KEY: "ptlc_abc123",
    });
    expect(result.warnings).toEqual([]);
    expect(result.panels.prod).toEqual({ url: "https://panel.example.com", client_key: "ptlc_abc123" });
  });

  it("lowercases the alias derived from the env var name", () => {
    const result = loadEnvPanels({
      PTERO_PROD_URL: "https://panel.example.com",
      PTERO_PROD_KEY: "ptlc_abc123",
    });
    expect(Object.keys(result.panels)).toEqual(["prod"]);
  });

  it("parses PTERO_<ALIAS>_APP_KEY as alias + app_key, NOT alias_app + key (longest-suffix-first)", () => {
    const result = loadEnvPanels({
      PTERO_BLOOM_URL: "https://panel.bloom.host",
      PTERO_BLOOM_KEY: "ptlc_def456",
      PTERO_BLOOM_APP_KEY: "ptla_admin789",
    });
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.panels)).toEqual(["bloom"]);
    expect(result.panels.bloom).toEqual({
      url: "https://panel.bloom.host",
      client_key: "ptlc_def456",
      app_key: "ptla_admin789",
    });
    // Specifically must NOT create a "bloom_app" alias with a client_key field.
    expect(result.panels.bloom_app).toBeUndefined();
  });

  it("parses PTERO_<ALIAS>_SSH_KEY and PTERO_<ALIAS>_PASSWORD without colliding with _KEY", () => {
    const result = loadEnvPanels({
      PTERO_HOME_URL: "https://panel.home.lan",
      PTERO_HOME_KEY: "ptlc_home1",
      PTERO_HOME_SSH_KEY: "/home/user/.ptero-mcp/id_ed25519_home",
      PTERO_HOME_PASSWORD: "hunter2",
    });
    expect(result.warnings).toEqual([]);
    expect(result.panels.home).toEqual({
      url: "https://panel.home.lan",
      client_key: "ptlc_home1",
      ssh_key: "/home/user/.ptero-mcp/id_ed25519_home",
      password: "hunter2",
    });
  });

  it("ignores env vars that are not PTERO_-prefixed or don't match a recognized suffix", () => {
    const result = loadEnvPanels({
      PATH: "/usr/bin",
      PTERO_MYSTERY: "value-with-no-suffix",
      SOME_OTHER_VAR: "x",
    });
    expect(result.panels).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("skips the reserved PTERO_MCP_CONFIG var without treating it as a panel", () => {
    const result = loadEnvPanels({
      PTERO_MCP_CONFIG: "C:\\some\\path\\config.json",
    });
    expect(result.panels).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("reads PTERO_DEFAULT_PANEL and lowercases it, without treating it as a panel", () => {
    const result = loadEnvPanels({
      PTERO_DEFAULT_PANEL: "PROD",
    });
    expect(result.defaultPanel).toBe("prod");
    expect(result.panels).toEqual({});
  });

  it("warns (but does not throw) on an invalid alias and skips that env var", () => {
    const result = loadEnvPanels({
      "PTERO_BAD ALIAS_URL": "https://panel.example.com",
    });
    // "BAD ALIAS" contains a space, which fails the alias regex.
    expect(result.panels).toEqual({});
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/not a valid panel alias/);
  });

  it("rejects __proto__ as an alias derived from env vars", () => {
    const result = loadEnvPanels({
      PTERO___proto___URL: "https://panel.example.com",
    });
    expect(result.panels).toEqual({});
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/reserved name/);
  });

  it("still returns a panel with only a URL (no key), warning what's missing", () => {
    const result = loadEnvPanels({
      PTERO_LONELY_URL: "https://panel.example.com",
    });
    expect(result.panels.lonely).toEqual({ url: "https://panel.example.com" });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/PTERO_LONELY_KEY/);
  });

  it("still returns a panel with only a key (no URL), warning what's missing", () => {
    const result = loadEnvPanels({
      PTERO_LONELY_KEY: "ptlc_xyz",
    });
    expect(result.panels.lonely).toEqual({ url: "", client_key: "ptlc_xyz" });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/PTERO_LONELY_URL/);
  });

  it("skips a panel URL that fails validatePanelUrl (e.g. non-https, non-local), without a redundant 'missing URL' warning", () => {
    const result = loadEnvPanels({
      PTERO_INSECURE_URL: "http://panel.example.com",
      PTERO_INSECURE_KEY: "ptlc_abc",
    });
    expect(result.panels.insecure).toEqual({ url: "", client_key: "ptlc_abc" });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/https/i);
  });

  it("allows http:// for localhost panels", () => {
    const result = loadEnvPanels({
      PTERO_LOCAL_URL: "http://localhost:8080",
      PTERO_LOCAL_KEY: "ptlc_local",
    });
    expect(result.panels.local).toEqual({ url: "http://localhost:8080", client_key: "ptlc_local" });
    expect(result.warnings).toEqual([]);
  });

  it("handles multiple independent panels in one env block", () => {
    const result = loadEnvPanels({
      PTERO_PROD_URL: "https://panel.example.com",
      PTERO_PROD_KEY: "ptlc_abc",
      PTERO_BLOOM_URL: "https://panel.bloom.host",
      PTERO_BLOOM_KEY: "ptlc_def",
      PTERO_BLOOM_APP_KEY: "ptla_admin",
      PTERO_DEFAULT_PANEL: "prod",
    });
    expect(Object.keys(result.panels).sort()).toEqual(["bloom", "prod"]);
    expect(result.defaultPanel).toBe("prod");
    expect(result.warnings).toEqual([]);
  });
});

describe("validateAlias", () => {
  it("accepts a simple lowercase alias unchanged", () => {
    expect(validateAlias("prod")).toEqual({ ok: true, alias: "prod" });
  });

  it("lowercases a mixed-case alias", () => {
    expect(validateAlias("Prod")).toEqual({ ok: true, alias: "prod" });
  });

  it("accepts digits, underscores, and hyphens", () => {
    expect(validateAlias("my-panel_2")).toEqual({ ok: true, alias: "my-panel_2" });
  });

  it("rejects an empty string", () => {
    const result = validateAlias("");
    expect(result.ok).toBe(false);
  });

  it("rejects an alias containing a slash (path traversal risk)", () => {
    const result = validateAlias("foo/bar");
    expect(result.ok).toBe(false);
  });

  it("rejects an alias containing '..' segments", () => {
    const result = validateAlias("../../etc");
    expect(result.ok).toBe(false);
  });

  it("rejects an alias containing whitespace", () => {
    const result = validateAlias("bad alias");
    expect(result.ok).toBe(false);
  });

  it("rejects __proto__", () => {
    const result = validateAlias("__proto__");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved/i);
  });

  it("rejects constructor", () => {
    const result = validateAlias("constructor");
    expect(result.ok).toBe(false);
  });

  it("rejects prototype", () => {
    const result = validateAlias("prototype");
    expect(result.ok).toBe(false);
  });

  it("rejects __proto__ regardless of casing", () => {
    const result = validateAlias("__PROTO__");
    expect(result.ok).toBe(false);
  });

  it("rejects an alias longer than 64 characters", () => {
    const result = validateAlias("a".repeat(65));
    expect(result.ok).toBe(false);
  });

  it("accepts an alias exactly 64 characters long", () => {
    const alias = "a".repeat(64);
    expect(validateAlias(alias)).toEqual({ ok: true, alias });
  });
});
