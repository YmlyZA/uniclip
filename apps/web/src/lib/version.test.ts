import { describe, expect, it } from "vitest";
import { formatVersion, updateLabel, releasesUrl } from "./version";

describe("formatVersion", () => {
  it("includes the git sha unless it is 'dev'", () => {
    expect(formatVersion({ version: "0.1.0", gitSha: "a730078" })).toBe("v0.1.0 (a730078)");
    expect(formatVersion({ version: "0.1.0", gitSha: "dev" })).toBe("v0.1.0");
    expect(formatVersion({ version: "0.1.0", gitSha: "" })).toBe("v0.1.0");
  });
});

describe("updateLabel", () => {
  it("is null unless an update is available, else names the latest with a v prefix", () => {
    expect(updateLabel({ updateAvailable: false, latest: "v0.2.0" })).toBeNull();
    expect(updateLabel({ updateAvailable: true, latest: null })).toBeNull();
    expect(updateLabel({ updateAvailable: true, latest: "v0.2.0" })).toBe("Update available: v0.2.0");
    expect(updateLabel({ updateAvailable: true, latest: "0.2.0" })).toBe("Update available: v0.2.0");
  });
});

describe("releasesUrl", () => {
  it("defaults to the uniclip repo", () => {
    expect(releasesUrl()).toBe("https://github.com/YmlyZA/uniclip/releases");
    expect(releasesUrl("fork/x")).toBe("https://github.com/fork/x/releases");
  });
});
