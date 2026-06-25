import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readForSend, safeFilename, uniquePath, saveBlob } from "./file-io";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uniclip-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("safeFilename", () => {
  it("reduces traversal / absolute / separator names to a bare basename", () => {
    expect(safeFilename("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeFilename("/etc/passwd")).toBe("passwd");
    expect(safeFilename("a\\b\\evil.txt")).toBe("evil.txt");
    expect(safeFilename("plain.png")).toBe("plain.png");
    expect(safeFilename(".npmrc")).toBe("npmrc");
    expect(safeFilename(".bashrc")).toBe("bashrc");
  });
  it("falls back to 'file' for empty / dot-only names", () => {
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename("/")).toBe("file");
    expect(safeFilename("")).toBe("file");
  });
});

describe("uniquePath", () => {
  it("suffixes a colliding name before the extension", () => {
    const d = tmp();
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a.txt"));
    writeFileSync(join(d, "a.txt"), "x");
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a (1).txt"));
    writeFileSync(join(d, "a (1).txt"), "x");
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a (2).txt"));
  });
});

describe("readForSend", () => {
  it("reads a file into name + mime + bytes", async () => {
    const d = tmp();
    writeFileSync(join(d, "hello.txt"), "hi there");
    const f = await readForSend(join(d, "hello.txt"));
    expect(f.name).toBe("hello.txt");
    expect(f.mime).toBe("text/plain");
    expect(Buffer.from(f.bytes).toString("utf8")).toBe("hi there");
  });
  it("rejects a missing file", async () => {
    await expect(readForSend(join(tmp(), "nope.txt"))).rejects.toBeTruthy();
  });
});

describe("saveBlob", () => {
  it("writes a Blob under a sanitized, collision-safe name and returns the path", async () => {
    const d = tmp();
    const p1 = await saveBlob(d, "../evil.bin", new Blob([new Uint8Array([1, 2, 3])]));
    expect(p1).toBe(join(d, "evil.bin"));
    expect([...readFileSync(p1)]).toEqual([1, 2, 3]);
    const p2 = await saveBlob(d, "evil.bin", new Blob([new Uint8Array([9])]));
    expect(p2).toBe(join(d, "evil (1).bin")); // collision-suffixed
    expect(existsSync(p2)).toBe(true);
  });
});
