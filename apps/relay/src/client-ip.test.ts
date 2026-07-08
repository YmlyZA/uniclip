import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

describe("clientIp", () => {
  it("returns the single hop as-is", () => {
    expect(clientIp("1.2.3.4")).toBe("1.2.3.4");
  });

  it("returns the LAST hop (trusted proxy), not the spoofable first", () => {
    expect(clientIp("9.9.9.9, 10.0.0.1")).toBe("10.0.0.1");
  });

  it("returns the last of three hops", () => {
    expect(clientIp("a, b, c")).toBe("c");
  });

  it("falls back to \"unknown\" for undefined", () => {
    expect(clientIp(undefined)).toBe("unknown");
  });

  it("falls back to \"unknown\" for an empty string", () => {
    expect(clientIp("")).toBe("unknown");
  });

  it("trims extra whitespace around hops", () => {
    expect(clientIp("  9.9.9.9  ,   10.0.0.1  ")).toBe("10.0.0.1");
  });
});
