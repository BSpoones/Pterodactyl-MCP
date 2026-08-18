import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPanel, allPanels, invalidatePanelCache } from "../src/panel.js";
import { PanelError } from "../src/panel.js";

describe("panel cache auto-invalidation (picks up config file changes without a restart)", () => {
  let dir: string;
  let configFile: string;
  let originalConfigEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptero-mcp-cache-test-"));
    configFile = join(dir, "config.json");
    originalConfigEnv = process.env.PTERO_MCP_CONFIG;
    process.env.PTERO_MCP_CONFIG = configFile;
    invalidatePanelCache();
  });

  afterEach(() => {
    if (originalConfigEnv === undefined) delete process.env.PTERO_MCP_CONFIG;
    else process.env.PTERO_MCP_CONFIG = originalConfigEnv;
    invalidatePanelCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no panels while the config file is absent, then sees a newly-created file with no explicit invalidate call", () => {
    // First call with no config file at all: builds (and caches) an empty panel set.
    expect(() => getPanel()).toThrow(PanelError);
    expect(() => getPanel()).toThrow(/No panels are configured/);
    expect(allPanels()).toEqual([]);

    // A separate process (or the user editing the file by hand) creates the config file now.
    writeFileSync(
      configFile,
      JSON.stringify({
        default_panel: "prod",
        panels: { prod: { url: "https://panel.example.com", client_key: "ptlc_abc123" } },
      })
    );

    // No invalidatePanelCache() call here — the missing -> exists transition must be detected on
    // its own via the config file's stat, exactly like a long-lived MCP server would need to.
    const panel = getPanel();
    expect(panel.alias).toBe("prod");
    expect(panel.baseUrl).toBe("https://panel.example.com");
    expect(allPanels().map((p) => p.alias)).toEqual(["prod"]);
  });

  it("picks up an edited config file (added panel) without an explicit invalidate call", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ panels: { prod: { url: "https://panel.example.com", client_key: "ptlc_abc123" } } })
    );
    expect(getPanel("prod").baseUrl).toBe("https://panel.example.com");
    expect(allPanels().map((p) => p.alias)).toEqual(["prod"]);

    // Simulate a different process running `add-panel` to register a second panel.
    writeFileSync(
      configFile,
      JSON.stringify({
        panels: {
          prod: { url: "https://panel.example.com", client_key: "ptlc_abc123" },
          bloom: { url: "https://panel.bloom.host", client_key: "ptlc_def456" },
        },
      })
    );

    const aliases = allPanels()
      .map((p) => p.alias)
      .sort();
    expect(aliases).toEqual(["bloom", "prod"]);
  });

  it("keeps using the cache when the config file is untouched between calls", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ panels: { prod: { url: "https://panel.example.com", client_key: "ptlc_abc123" } } })
    );
    const first = getPanel("prod");
    const second = getPanel("prod");
    // Same PanelClient instance both times -> proves the cache wasn't needlessly rebuilt.
    expect(second).toBe(first);
  });
});
