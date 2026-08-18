import { describe, it, expect } from "vitest";
import { pullUrl } from "../src/files.js";
import { assertNoTraversal } from "../src/tools/files-tools.js";
import type { ServerRef } from "../src/resolve.js";

/**
 * A ServerRef whose panel serves a scripted sequence of directory listings — one per GET
 * /files/list — so a test can describe what the destination directory looks like over time.
 * Network is the one thing worth faking here; everything else is the real code path.
 */
function refWithListings(listings: Array<Array<{ name: string; size: number }>>): ServerRef {
  let call = 0;
  const panel = {
    alias: "test",
    api: async (method: string, path: string) => {
      if (method === "POST" && path.endsWith("/files/pull")) return undefined;
      if (path.endsWith("/files/list")) {
        // Last listing repeats once exhausted, so "nothing ever arrives" is expressible.
        const listing = listings[Math.min(call, listings.length - 1)];
        call++;
        return { data: listing.map((f) => ({ attributes: { name: f.name, size: f.size } })) };
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    },
  };
  return { name: "Test Server", identifier: "abcd1234", panel } as unknown as ServerRef;
}

const fast = { pollIntervalMs: 1, timeoutMs: 30 };

describe("pullUrl", () => {
  it("reports failure when the panel accepts the request but no file ever appears", async () => {
    // The original bug: the pull endpoint returns immediately, so reporting success off the
    // back of it claimed a download that never happened.
    const ref = refWithListings([[{ name: "existing.txt", size: 10 }]]);

    const result = await pullUrl(ref, "https://example.com/thing.jar", "/mods", fast);

    expect(result.verified).toBe(false);
    expect(result.waitedSeconds).toBe(0);
  });

  it("reports the file that landed once one appears in the destination", async () => {
    const ref = refWithListings([
      [{ name: "existing.txt", size: 10 }],
      [
        { name: "existing.txt", size: 10 },
        { name: "thing.jar", size: 2048 },
      ],
    ]);

    const result = await pullUrl(ref, "https://example.com/thing.jar", "/mods", fast);

    expect(result.verified).toBe(true);
    expect(result.name).toBe("thing.jar");
    expect(result.size).toBe(2048);
  });

  it("counts an existing file that grew as a successful pull", async () => {
    // Re-pulling over an existing name adds no new entry — only the size moves.
    const ref = refWithListings([
      [{ name: "thing.jar", size: 100 }],
      [{ name: "thing.jar", size: 5000 }],
    ]);

    const result = await pullUrl(ref, "https://example.com/thing.jar", "/mods", fast);

    expect(result.verified).toBe(true);
    expect(result.name).toBe("thing.jar");
    expect(result.size).toBe(5000);
  });

  it("still pulls when the pre-flight listing fails, treating anything present as new", async () => {
    let call = 0;
    const panel = {
      alias: "test",
      api: async (method: string, path: string) => {
        if (method === "POST" && path.endsWith("/files/pull")) return undefined;
        if (path.endsWith("/files/list")) {
          call++;
          if (call === 1) throw new Error("listing blew up");
          return { data: [{ attributes: { name: "thing.jar", size: 64 } }] };
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      },
    };
    const ref = { name: "Test", identifier: "abcd1234", panel } as unknown as ServerRef;

    const result = await pullUrl(ref, "https://example.com/thing.jar", "/mods", fast);

    expect(result.verified).toBe(true);
    expect(result.name).toBe("thing.jar");
  });
});

describe("assertNoTraversal", () => {
  it("rejects a path that climbs out of its root", () => {
    expect(() => assertNoTraversal("../archive.tar.gz", "file")).toThrow(/\.\./);
    expect(() => assertNoTraversal("sub/../../etc/passwd", "file")).toThrow(/must stay inside/);
    expect(() => assertNoTraversal("sub\\..\\..\\x", "file")).toThrow(/must stay inside/);
  });

  it("allows ordinary names, including dotfiles and ones merely containing dots", () => {
    expect(assertNoTraversal("archive.tar.gz", "file")).toBe("archive.tar.gz");
    expect(assertNoTraversal("sub/dir/thing.jar", "files[]")).toBe("sub/dir/thing.jar");
    expect(assertNoTraversal(".env", "file")).toBe(".env");
    expect(assertNoTraversal("..hidden", "file")).toBe("..hidden");
  });
});
