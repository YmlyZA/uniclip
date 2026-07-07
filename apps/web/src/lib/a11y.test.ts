import { describe, expect, it } from "vitest";
import { statusAriaLabel } from "./a11y";

describe("statusAriaLabel", () => {
  it("appends the transport only when connected", () => {
    expect(statusAriaLabel("connected", "p2p")).toBe("Connected · Direct (P2P)");
    expect(statusAriaLabel("connected", "relay")).toBe("Connected · Relayed");
  });
  it("names the non-connected states without transport", () => {
    expect(statusAriaLabel("connecting", "relay")).toBe("Connecting");
    expect(statusAriaLabel("reconnecting", "p2p")).toBe("Reconnecting");
    expect(statusAriaLabel("disconnected", "relay")).toBe("Offline");
  });
});
