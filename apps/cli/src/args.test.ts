import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("defaults relay and takes a positional room url", () => {
    expect(parseArgs(["https://h/r/abc#sek"])).toEqual({ roomUrl: "https://h/r/abc#sek", relay: "http://localhost:3000", relayOnly: false, lan: false });
  });
  it("reads --relay and --name", () => {
    const a = parseArgs(["--relay", "https://relay.example", "--name", "Laptop"]);
    expect(a.relay).toBe("https://relay.example");
    expect(a.name).toBe("Laptop");
    expect(a.roomUrl).toBeUndefined();
  });
  it("defaults relayOnly to false and parses --relay-only", () => {
    expect(parseArgs(["https://h/r/abc#sek"]).relayOnly).toBe(false);
    const a = parseArgs(["--relay-only", "https://h/r/abc#sek"]);
    expect(a.relayOnly).toBe(true);
    expect(a.roomUrl).toBe("https://h/r/abc#sek");
  });
  it("parses --lan (default false)", () => {
    expect(parseArgs(["--lan"]).lan).toBe(true);
    expect(parseArgs([]).lan).toBe(false);
  });
});
