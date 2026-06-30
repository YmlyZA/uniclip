import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("defaults relay and takes a positional room url", () => {
    expect(parseArgs(["https://h/r/abc#sek"])).toEqual({ roomUrl: "https://h/r/abc#sek", relay: "http://localhost:3000", relayOnly: false, lan: false, help: false, version: false, verbose: false });
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
  it("parses --help/-h and --version/-v (default false)", () => {
    expect(parseArgs([]).help).toBe(false);
    expect(parseArgs([]).version).toBe(false);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });
  it("parses --verbose and -V", () => {
    expect(parseArgs(["--verbose"]).verbose).toBe(true);
    expect(parseArgs(["-V"]).verbose).toBe(true);
    expect(parseArgs([]).verbose).toBe(false);
  });
});
