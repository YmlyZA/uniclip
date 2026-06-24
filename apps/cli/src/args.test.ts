import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("defaults relay and takes a positional room url", () => {
    expect(parseArgs(["https://h/r/abc#sek"])).toEqual({ roomUrl: "https://h/r/abc#sek", relay: "http://localhost:3000" });
  });
  it("reads --relay and --name", () => {
    const a = parseArgs(["--relay", "https://relay.example", "--name", "Laptop"]);
    expect(a.relay).toBe("https://relay.example");
    expect(a.name).toBe("Laptop");
    expect(a.roomUrl).toBeUndefined();
  });
});
