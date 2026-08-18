import { describe, it, expect } from "vitest";
import { humanSize, sliceLastLines, splitRemotePath, remoteJoin } from "../src/files.js";

describe("humanSize", () => {
  it("formats bytes under 1024 as whole B", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1023)).toBe("1023 B");
  });

  it("formats KB with two decimals under 10, one decimal at/above 10", () => {
    expect(humanSize(1024)).toBe("1.00 KB");
    expect(humanSize(1536)).toBe("1.50 KB");
    expect(humanSize(10 * 1024)).toBe("10.0 KB");
  });

  it("formats MB and GB", () => {
    expect(humanSize(1024 * 1024)).toBe("1.00 MB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(humanSize(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });

  it("treats negative or non-finite input as 0 B", () => {
    expect(humanSize(-5)).toBe("0 B");
    expect(humanSize(NaN)).toBe("0 B");
  });
});

describe("sliceLastLines", () => {
  it("returns the last N lines when content has more lines than N", () => {
    const content = "a\nb\nc\nd\ne";
    expect(sliceLastLines(content, 2)).toBe("d\ne");
  });

  it("returns the whole content when N exceeds the line count", () => {
    const content = "a\nb";
    expect(sliceLastLines(content, 10)).toBe("a\nb");
  });

  it("returns an empty string for n <= 0", () => {
    expect(sliceLastLines("a\nb\nc", 0)).toBe("");
    expect(sliceLastLines("a\nb\nc", -1)).toBe("");
  });

  it("preserves a trailing newline as an empty trailing segment", () => {
    const content = "a\nb\nc\n";
    expect(sliceLastLines(content, 2)).toBe("c\n");
  });

  it("handles single-line content", () => {
    expect(sliceLastLines("only line", 5)).toBe("only line");
  });
});

describe("splitRemotePath", () => {
  it("splits an absolute path into dir and name", () => {
    expect(splitRemotePath("/plugins/foo.jar")).toEqual({ dir: "/plugins", name: "foo.jar" });
  });

  it("treats a root-level file as dir '/'", () => {
    expect(splitRemotePath("/server.properties")).toEqual({ dir: "/", name: "server.properties" });
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(splitRemotePath("\\plugins\\foo.jar")).toEqual({ dir: "/plugins", name: "foo.jar" });
  });

  it("assumes a leading slash when omitted", () => {
    expect(splitRemotePath("plugins/foo.jar")).toEqual({ dir: "/plugins", name: "foo.jar" });
  });

  it("handles nested directories", () => {
    expect(splitRemotePath("/a/b/c/d.txt")).toEqual({ dir: "/a/b/c", name: "d.txt" });
  });
});

describe("remoteJoin", () => {
  it("joins a directory and filename with a forward slash", () => {
    expect(remoteJoin("/plugins", "foo.jar")).toBe("/plugins/foo.jar");
  });

  it("handles a root directory without double slashes", () => {
    expect(remoteJoin("/", "foo.jar")).toBe("/foo.jar");
  });

  it("normalizes backslashes in the directory (Windows local paths must not leak through)", () => {
    expect(remoteJoin("\\plugins\\sub", "foo.jar")).toBe("/plugins/sub/foo.jar");
  });

  it("assumes a leading slash when the directory omits one", () => {
    expect(remoteJoin("plugins", "foo.jar")).toBe("/plugins/foo.jar");
  });

  it("collapses a trailing slash on the directory", () => {
    expect(remoteJoin("/plugins/", "foo.jar")).toBe("/plugins/foo.jar");
  });
});
