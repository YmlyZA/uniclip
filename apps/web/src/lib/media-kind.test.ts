import { describe, expect, it } from "vitest";
import { mediaKind } from "./media-kind";

describe("mediaKind", () => {
  it("classifies media browsers can play inline", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("image/jpeg")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/mpeg")).toBe("audio");
  });
  it("classifies docs a browser can open in a tab", () => {
    expect(mediaKind("application/pdf")).toBe("openable");
    expect(mediaKind("text/plain")).toBe("openable");
    expect(mediaKind("text/csv")).toBe("openable");
  });
  it("falls back to a plain file for opaque binaries", () => {
    expect(mediaKind("application/zip")).toBe("file");
    expect(mediaKind("application/octet-stream")).toBe("file");
    expect(mediaKind("")).toBe("file");
  });
});
