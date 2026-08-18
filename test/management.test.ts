import { describe, it, expect } from "vitest";
import { formatBytes, parseJsonBody } from "../src/tools/management.js";
import { PanelError } from "../src/panel.js";

describe("formatBytes", () => {
  it("formats sub-1KB values in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB with one decimal under 10", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats larger values with no decimal at/above 10", () => {
    expect(formatBytes(15 * 1024)).toBe("15 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("returns 'unknown' for negative or non-finite values", () => {
    expect(formatBytes(-1)).toBe("unknown");
    expect(formatBytes(NaN)).toBe("unknown");
  });
});

describe("parseJsonBody", () => {
  it("parses valid JSON", () => {
    expect(parseJsonBody('{"email":"a@b.com"}')).toEqual({ email: "a@b.com" });
  });

  it("throws a PanelError with a clear message on invalid JSON", () => {
    expect(() => parseJsonBody("{not json")).toThrow(PanelError);
    expect(() => parseJsonBody("{not json")).toThrow(/not valid JSON/);
  });
});
