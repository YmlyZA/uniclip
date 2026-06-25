import { describe, expect, it } from "vitest";
import { mimeForName } from "./mime";

describe("mimeForName", () => {
  it("maps known extensions (case-insensitive)", () => {
    expect(mimeForName("a.png")).toBe("image/png");
    expect(mimeForName("a.JPG")).toBe("image/jpeg");
    expect(mimeForName("notes.txt")).toBe("text/plain");
    expect(mimeForName("doc.pdf")).toBe("application/pdf");
  });
  it("defaults unknown / extensionless to octet-stream", () => {
    expect(mimeForName("blob")).toBe("application/octet-stream");
    expect(mimeForName("a.zzz")).toBe("application/octet-stream");
  });
});
