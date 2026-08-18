import { describe, it, expect } from "vitest";
import {
  parseWsMessage,
  splitConsoleLines,
  formatStateLine,
  tailLines,
  CappedLineBuffer,
} from "../src/console.js";

describe("parseWsMessage", () => {
  it("parses a well-formed event/args message", () => {
    expect(parseWsMessage('{"event":"console output","args":["Server started"]}')).toEqual({
      event: "console output",
      args: ["Server started"],
    });
  });

  it("defaults args to [] when omitted", () => {
    expect(parseWsMessage('{"event":"auth success"}')).toEqual({ event: "auth success", args: [] });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseWsMessage("not json")).toBeUndefined();
  });

  it("returns undefined when event is missing or not a string", () => {
    expect(parseWsMessage('{"args":["x"]}')).toBeUndefined();
    expect(parseWsMessage('{"event":42}')).toBeUndefined();
  });

  it("returns undefined for non-object JSON (numbers, null, bare strings)", () => {
    expect(parseWsMessage("42")).toBeUndefined();
    expect(parseWsMessage("null")).toBeUndefined();
    expect(parseWsMessage('"just a string"')).toBeUndefined();
  });

  it("passes through multi-arg payloads (e.g. stats)", () => {
    expect(parseWsMessage('{"event":"status","args":["running","extra"]}')).toEqual({
      event: "status",
      args: ["running", "extra"],
    });
  });
});

describe("splitConsoleLines", () => {
  it("returns a single-element array for a line with no newlines", () => {
    expect(splitConsoleLines("hello world")).toEqual(["hello world"]);
  });

  it("splits on \\n, \\r\\n, and bare \\r", () => {
    expect(splitConsoleLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("formatStateLine", () => {
  it("formats HH:MM:SS with zero-padding", () => {
    expect(formatStateLine(new Date(2026, 0, 1, 3, 4, 5), "running")).toBe("03:04:05 running");
  });

  it("does not truncate double-digit components", () => {
    expect(formatStateLine(new Date(2026, 0, 1, 23, 59, 9), "offline")).toBe("23:59:09 offline");
  });

  it("handles midnight", () => {
    expect(formatStateLine(new Date(2026, 0, 1, 0, 0, 0), "starting")).toBe("00:00:00 starting");
  });
});

describe("tailLines", () => {
  it("returns the last n lines of newline-joined text", () => {
    expect(tailLines(["a", "b", "c", "d", "e"].join("\n"), 2)).toEqual(["d", "e"]);
  });

  it("returns all lines when n exceeds the total count", () => {
    expect(tailLines(["a", "b"].join("\n"), 100)).toEqual(["a", "b"]);
  });

  it("returns an empty array for empty text", () => {
    expect(tailLines("", 10)).toEqual([]);
  });

  it("clamps a non-positive or fractional n up to at least 1 (rounded)", () => {
    expect(tailLines(["a", "b", "c"].join("\n"), 0)).toEqual(["c"]);
    expect(tailLines(["a", "b", "c"].join("\n"), 1.6)).toEqual(["b", "c"]);
  });
});

describe("CappedLineBuffer", () => {
  it("joins pushed lines with newlines and is not truncated under the cap", () => {
    const buf = new CappedLineBuffer(1024);
    buf.push("line one");
    buf.push("line two");
    expect(buf.text).toBe("line one\nline two");
    expect(buf.truncated).toBe(false);
  });

  it("drops the oldest lines and sets truncated once the byte cap is exceeded", () => {
    const buf = new CappedLineBuffer(20); // small cap to force eviction deterministically
    buf.push("aaaaaaaaaa"); // 10 bytes + 1 newline = 11
    buf.push("bbbbbbbbbb"); // running total 22 > 20 -> evicts "aaaaaaaaaa"
    buf.push("cccccccccc"); // running total again over cap -> evicts "bbbbbbbbbb"

    expect(buf.truncated).toBe(true);
    expect(buf.all).not.toContain("aaaaaaaaaa");
    expect(buf.all).not.toContain("bbbbbbbbbb");
    expect(buf.all).toContain("cccccccccc");
    expect(buf.text.endsWith("cccccccccc")).toBe(true);
  });

  it("keeps at least the most recent line even if it alone exceeds the cap", () => {
    const buf = new CappedLineBuffer(5);
    buf.push("this single line is much longer than the cap");
    expect(buf.all).toEqual(["this single line is much longer than the cap"]);
  });

  it("uses the default 64 KB cap when none is supplied", () => {
    const buf = new CappedLineBuffer();
    for (let i = 0; i < 2000; i++) buf.push(`line ${i} `.padEnd(80, "x"));
    expect(buf.truncated).toBe(true);
    // Whatever remains must still fit comfortably within the 64 KB budget (plus the one
    // allowed oversized straggler, which doesn't apply here since lines are uniform size).
    expect(Buffer.byteLength(buf.text, "utf8")).toBeLessThanOrEqual(64 * 1024 + 100);
  });
});
