import { describe, expect, it } from "vitest";
import { formatLanToken, parseLanToken } from "./lan-token";

describe("lan-token", () => {
  it("round-trips routingId + secret", () => {
    const t = formatLanToken({ routingId: "abc123", secret: "sekretsekretsekret" });
    expect(t).toBe("uniclip+lan://abc123#sekretsekretsekret");
    expect(parseLanToken(t)).toEqual({ routingId: "abc123", secret: "sekretsekretsekret" });
  });
  it("returns null for a normal https room URL (routes to the relay path instead)", () => {
    expect(parseLanToken("https://uniclip.app/r/abc123#sek")).toBeNull();
  });
  it("returns null for garbage and for a token with no secret", () => {
    expect(parseLanToken("not a url")).toBeNull();
    expect(parseLanToken("uniclip+lan://abc123")).toBeNull();
    expect(parseLanToken("uniclip+lan://#secret")).toBeNull(); // empty routingId
  });
});
