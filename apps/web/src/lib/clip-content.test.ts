import { describe, expect, it } from "vitest";
import { clipSegments, firstUrl, matchesQuery } from "./clip-content";

describe("clipSegments", () => {
  it("splits text around an http(s) URL", () => {
    expect(clipSegments("see https://a.com/x now")).toEqual([
      { type: "text", value: "see " },
      { type: "url", value: "https://a.com/x" },
      { type: "text", value: " now" },
    ]);
  });
  it("returns a single text segment when there is no URL", () => {
    expect(clipSegments("no url here")).toEqual([{ type: "text", value: "no url here" }]);
  });
  it("excludes trailing sentence punctuation from the URL", () => {
    expect(clipSegments("go to https://a.com.")).toEqual([
      { type: "text", value: "go to " },
      { type: "url", value: "https://a.com" },
      { type: "text", value: "." },
    ]);
  });
  it("does NOT linkify javascript:/data: schemes", () => {
    expect(clipSegments("javascript:alert(1)")).toEqual([{ type: "text", value: "javascript:alert(1)" }]);
  });
});

describe("firstUrl", () => {
  it("returns the first http(s) URL or null", () => {
    expect(firstUrl("a https://x.io b https://y.io")).toBe("https://x.io");
    expect(firstUrl("none here")).toBeNull();
  });
});

describe("matchesQuery", () => {
  it("is case-insensitive and true for an empty query", () => {
    expect(matchesQuery("Hello World", "world")).toBe(true);
    expect(matchesQuery("Hello", "zzz")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });
});
