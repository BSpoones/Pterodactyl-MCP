import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizeRemotePath,
  formatBytes,
  expandHome,
  hostKeyFingerprint,
  hostEntryKey,
  compareHostKey,
  parseKnownHosts,
  knownHostsPath,
} from "../src/sftp.js";

describe("normalizeRemotePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeRemotePath("foo\\bar\\baz.txt")).toBe("foo/bar/baz.txt");
  });

  it("leaves already-POSIX paths untouched", () => {
    expect(normalizeRemotePath("/home/container/server.jar")).toBe("/home/container/server.jar");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRemotePath("  /data/plugins  ")).toBe("/data/plugins");
  });

  it("defaults empty input to root", () => {
    expect(normalizeRemotePath("")).toBe("/");
    expect(normalizeRemotePath("   ")).toBe("/");
  });
});

describe("formatBytes", () => {
  it("formats bytes below 1024 with no decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("adds one decimal place for small values in a larger unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes and gigabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("returns 'unknown size' for invalid input", () => {
    expect(formatBytes(-1)).toBe("unknown size");
    expect(formatBytes(NaN)).toBe("unknown size");
  });
});

describe("expandHome", () => {
  it("expands a bare ~ to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("expands ~/ prefixed paths", () => {
    expect(expandHome("~/.ptero-mcp/id_ed25519_prod")).toBe(join(homedir(), ".ptero-mcp", "id_ed25519_prod"));
  });

  it("leaves absolute paths without a ~ prefix untouched", () => {
    expect(expandHome("C:\\keys\\id_ed25519")).toBe("C:\\keys\\id_ed25519");
  });
});

describe("knownHostsPath", () => {
  it("resolves under the home directory as known_hosts.json", () => {
    expect(knownHostsPath()).toBe(join(homedir(), ".ptero-mcp", "known_hosts.json"));
  });
});

describe("hostKeyFingerprint (SFTP TOFU)", () => {
  it("is deterministic for the same key bytes", () => {
    const key = Buffer.from("ssh-ed25519 AAAAfake-key-bytes", "utf-8");
    expect(hostKeyFingerprint(key)).toBe(hostKeyFingerprint(Buffer.from(key)));
  });

  it("differs for different key bytes", () => {
    const a = Buffer.from("key-a", "utf-8");
    const b = Buffer.from("key-b", "utf-8");
    expect(hostKeyFingerprint(a)).not.toBe(hostKeyFingerprint(b));
  });

  it("returns a base64-looking string (sha256/base64 is 44 chars incl. padding)", () => {
    const fp = hostKeyFingerprint(Buffer.from("some-host-key"));
    expect(fp).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(fp.length).toBe(44);
  });
});

describe("hostEntryKey", () => {
  it("joins host and port with a colon", () => {
    expect(hostEntryKey("node1.example.com", 2022)).toBe("node1.example.com:2022");
  });

  it("distinguishes different ports on the same host", () => {
    expect(hostEntryKey("node1.example.com", 2022)).not.toBe(hostEntryKey("node1.example.com", 22));
  });
});

describe("compareHostKey", () => {
  it("reports 'new' when there is no stored fingerprint", () => {
    expect(compareHostKey(undefined, "abc123==")).toEqual({ status: "new" });
  });

  it("reports 'match' when the stored fingerprint equals the computed one", () => {
    expect(compareHostKey("abc123==", "abc123==")).toEqual({ status: "match" });
  });

  it("reports 'mismatch' with the stored value when fingerprints differ", () => {
    expect(compareHostKey("old-fingerprint==", "new-fingerprint==")).toEqual({
      status: "mismatch",
      stored: "old-fingerprint==",
    });
  });
});

describe("parseKnownHosts", () => {
  it("parses a valid known_hosts.json object", () => {
    const raw = JSON.stringify({ "node1.example.com:2022": "abc123==" });
    expect(parseKnownHosts(raw)).toEqual({ "node1.example.com:2022": "abc123==" });
  });

  it("returns an empty object for corrupt/non-JSON content rather than throwing", () => {
    expect(parseKnownHosts("{not json")).toEqual({});
  });

  it("returns an empty object for a JSON array or primitive", () => {
    expect(parseKnownHosts("[1,2,3]")).toEqual({});
    expect(parseKnownHosts("42")).toEqual({});
    expect(parseKnownHosts('"just a string"')).toEqual({});
  });

  it("drops non-string values and prototype-polluting keys", () => {
    const raw = '{"good:22":"fingerprint==","bad:22":123,"__proto__":"evil"}';
    expect(parseKnownHosts(raw)).toEqual({ "good:22": "fingerprint==" });
  });
});
