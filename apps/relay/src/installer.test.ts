import { afterAll, describe, expect, it } from "vitest";
import { renderSetupScript } from "./installer";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// NOTE: In-process node:http servers are not reachable by curl spawned from sh
// in this macOS sandbox (subprocess → in-process TCP is blocked). We instead
// start the file server as an external Bun subprocess (Bun.spawn), write its
// port to a file, wait, then drive the sh installer against it. All three
// behavioral assertions are preserved: syntax-valid, install+verify, reject-mismatch.

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uniclip-inst-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const hostArtifact = () => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `uniclip-${os}-${arch}`;
};

/** Spin up a file-serving Bun subprocess; returns { port, proc } */
async function startFileServer(serveDir: string): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn> }> {
  const portFile = join(serveDir, ".port");
  const serverSrc = `
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const dir = ${JSON.stringify(serveDir)};
const srv = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const p = join(dir, new URL(req.url).pathname.replace(/^\\/+/, ""));
    if (existsSync(p)) return new Response(readFileSync(p));
    return new Response("nope", { status: 404 });
  }
});
writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
`;
  const srcFile = join(serveDir, ".srv.ts");
  writeFileSync(srcFile, serverSrc);
  const proc = Bun.spawn(["bun", srcFile], { stderr: "pipe" });

  const deadline = Date.now() + 5000;
  while (!existsSync(portFile) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  if (!existsSync(portFile)) throw new Error("File server did not start in time");
  const port = parseInt(readFileSync(portFile, "utf8").trim(), 10);
  return { port, proc };
}

describe("renderSetupScript", () => {
  it("embeds the base URL and the checksums; is valid POSIX sh", () => {
    const s = renderSetupScript({ base: "http://h:3000", checksums: { "uniclip-linux-x64": "abc" } });
    // The (validated) base is embedded once as a shell var and the download
    // path goes through it, so the artifact is fetched from "<base>/dl/...".
    expect(s).toContain(`BASE="http://h:3000"`);
    expect(s).toContain("$BASE/dl/");
    expect(s).toContain("abc");
    // sh syntax check (no execution)
    const f = join(tmp(), "s.sh"); writeFileSync(f, s);
    expect(() => execFileSync("sh", ["-n", f])).not.toThrow();
  });

  it("rejects an unsafe base URL (shell-injection guard)", () => {
    expect(() => renderSetupScript({ base: 'http://h" ; rm -rf $HOME ; echo "', checksums: {} })).toThrow();
    expect(() => renderSetupScript({ base: "http://h:3000", checksums: {} })).not.toThrow(); // valid host:port still ok
  });

  it("downloads, checksum-verifies, and installs the host-platform binary", async () => {
    // A fake 'binary' = a tiny shell script that echoes a marker.
    const serveDir = tmp();
    const dl = join(serveDir, "dl"); mkdirSync(dl, { recursive: true });
    const artifact = hostArtifact();
    const fakeBin = "#!/bin/sh\necho INSTALLED_OK\n";
    writeFileSync(join(dl, artifact), fakeBin);
    const sum = createHash("sha256").update(fakeBin).digest("hex");

    // Serve serveDir over http via an external Bun subprocess (avoids macOS
    // sandbox that blocks subprocess→in-process TCP connections via curl).
    const { port, proc } = await startFileServer(serveDir);
    try {
      const home = tmp();
      const script = renderSetupScript({ base: `http://127.0.0.1:${port}`, checksums: { [artifact]: sum } });
      const sf = join(tmp(), "setup.sh"); writeFileSync(sf, script);
      execFileSync("sh", [sf], { env: { ...process.env, HOME: home }, stdio: "pipe" });
      const installed = join(home, ".local", "bin", "uniclip");
      expect(existsSync(installed)).toBe(true);
      expect(execFileSync(installed, [], { encoding: "utf8" })).toContain("INSTALLED_OK");
    } finally {
      proc.kill();
    }
  });

  it("rejects a checksum mismatch (also catches the SPA-HTML fallback)", async () => {
    const serveDir = tmp();
    mkdirSync(join(serveDir, "dl"), { recursive: true });
    const artifact = hostArtifact();
    writeFileSync(join(serveDir, "dl", artifact), "#!/bin/sh\necho HI\n");

    const { port, proc } = await startFileServer(serveDir);
    try {
      const home = tmp();
      const script = renderSetupScript({ base: `http://127.0.0.1:${port}`, checksums: { [artifact]: "deadbeef" } });
      const sf = join(tmp(), "setup.sh"); writeFileSync(sf, script);
      expect(() => execFileSync("sh", [sf], { env: { ...process.env, HOME: home }, stdio: "pipe" })).toThrow();
      expect(existsSync(join(home, ".local", "bin", "uniclip"))).toBe(false);
    } finally {
      proc.kill();
    }
  });
});
