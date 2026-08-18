import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, configPath } from "../src/config.js";
import { stripAnsi } from "../src/console.js";
import { PanelError } from "../src/panel.js";

describe("config", () => {
  let dir: string;
  let originalConfigEnv: string | undefined;
  let originalMyEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptero-mcp-test-"));
    originalConfigEnv = process.env.PTERO_MCP_CONFIG;
    originalMyEnv = process.env.MCP_TEST_INTERPOLATION_SECRET;
    process.env.PTERO_MCP_CONFIG = join(dir, "config.json");
  });

  afterEach(() => {
    if (originalConfigEnv === undefined) delete process.env.PTERO_MCP_CONFIG;
    else process.env.PTERO_MCP_CONFIG = originalConfigEnv;
    if (originalMyEnv === undefined) delete process.env.MCP_TEST_INTERPOLATION_SECRET;
    else process.env.MCP_TEST_INTERPOLATION_SECRET = originalMyEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("configPath honors PTERO_MCP_CONFIG", () => {
    expect(configPath()).toBe(join(dir, "config.json"));
  });

  it("loadConfig returns {panels: {}} when the file is missing", () => {
    expect(loadConfig()).toEqual({ panels: {} });
  });

  it("round-trips a saved config", () => {
    saveConfig({ default_panel: "prod", panels: { prod: { url: "https://panel.example.com" } } });
    const loaded = loadConfig();
    expect(loaded.default_panel).toBe("prod");
    expect(loaded.panels.prod?.url).toBe("https://panel.example.com");
  });

  it("normalizes a trailing slash off panel URLs", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ panels: { prod: { url: "https://panel.example.com/" } } })
    );
    const loaded = loadConfig();
    expect(loaded.panels.prod?.url).toBe("https://panel.example.com");
  });

  it("interpolates ${ENV_VAR} placeholders in string values", () => {
    process.env.MCP_TEST_INTERPOLATION_SECRET = "ptlc_secret123";
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        panels: {
          prod: { url: "https://panel.example.com", client_key: "${MCP_TEST_INTERPOLATION_SECRET}" },
        },
      })
    );
    const loaded = loadConfig();
    expect(loaded.panels.prod?.client_key).toBe("ptlc_secret123");
  });

  it("leaves unmatched ${ENV_VAR} placeholders unresolved rather than throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        panels: { prod: { url: "https://panel.example.com", client_key: "${TOTALLY_UNSET_VAR}" } },
      })
    );
    const loaded = loadConfig();
    expect(loaded.panels.prod?.client_key).toBe("${TOTALLY_UNSET_VAR}");
  });
});

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mHello\x1b[0m World")).toBe("Hello World");
  });

  it("removes multiple sequences in one string", () => {
    expect(stripAnsi("\x1b[1;32mA\x1b[0m\x1b[1;34mB\x1b[0m")).toBe("AB");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain console output")).toBe("plain console output");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("Loading\x1b[2K\x1b[1Gdone")).toBe("Loadingdone");
  });
});

describe("PanelError", () => {
  it("carries status and detail alongside the message", () => {
    const err = new PanelError("Panel returned 422: bad input", 422, "bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PanelError");
    expect(err.message).toBe("Panel returned 422: bad input");
    expect(err.status).toBe(422);
    expect(err.detail).toBe("bad input");
  });

  it("allows status/detail to be omitted", () => {
    const err = new PanelError("something went wrong");
    expect(err.status).toBeUndefined();
    expect(err.detail).toBeUndefined();
  });
});
