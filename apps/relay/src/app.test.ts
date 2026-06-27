import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";

describe("GET /setup.sh", () => {
  it("serves a templated /setup.sh with the request host + checksums", async () => {
    const root = mkdtempSync(join(tmpdir(), "uniclip-root-"));
    mkdirSync(join(root, "dl"), { recursive: true });
    const A = "a".repeat(64),
      B = "b".repeat(64);
    writeFileSync(
      join(root, "dl", "checksums.txt"),
      `${A}  uniclip-linux-x64\n${B}  uniclip-darwin-arm64\n`,
    );
    const app = buildApp({ roomCount: () => 0, staticRoot: root });
    const res = await app.request("/setup.sh", { headers: { host: "myhost:3000" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shell");
    const body = await res.text();
    // The base is templated in as the validated shell var (Task 3's single-
    // interpolation design); the download path goes through "$BASE/dl/".
    expect(body).toContain('BASE="http://myhost:3000"');
    expect(body).toContain(A);
    expect(body).toContain(B);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 400 for a Host header with shell-injection characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "uniclip-root-"));
    mkdirSync(join(root, "dl"), { recursive: true });
    writeFileSync(join(root, "dl", "checksums.txt"), "");
    const app = buildApp({ roomCount: () => 0, staticRoot: root });
    const res = await app.request("/setup.sh", {
      headers: { host: 'evil.com"; rm -rf $HOME; echo "' },
    });
    expect(res.status).toBe(400);
    rmSync(root, { recursive: true, force: true });
  });
});
