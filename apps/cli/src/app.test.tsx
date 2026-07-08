import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./app";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Ink renders asynchronously, and vitest runs test files in parallel — on a
// loaded CI runner (2 cores) the React→Ink render flush can take well over
// vi.waitFor's 1000ms default, intermittently failing render assertions. Poll
// with a generous bound (still under the 5s test timeout so a genuine hang
// surfaces the real assertion, not an opaque timeout).
const waitForRender = (fn: () => void | Promise<void>) =>
  vi.waitFor(fn, { timeout: 4000, interval: 50 });

// Minimal fake UniclipClient: capture handlers, let the test drive events.
function fakeClient() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: (k: string, cb: Function) => ((handlers[k] ||= []).push(cb)),
    emit: (k: string, ...a: unknown[]) => (handlers[k] || []).forEach((f) => f(...a)),
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ msgId: "x", ts: 1, queued: false })),
    sendFile: vi.fn(async () => ({ fileId: "f1", chunkCount: 1 })),
    acceptFile: vi.fn(),
    declineFile: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe("App", () => {
  it("appends a clip row when the client emits 'clip'", async () => {
    const client = fakeClient();
    const { lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("clip", "hello from peer", 123, "m1");
    // Poll the rendered frame: one setTimeout(0) tick is not always enough for
    // React's state update to flush through Ink's renderer under CI load.
    await waitForRender(() => expect(lastFrame()).toContain("hello from peer"));
  });

  it("removes a clip row when the client emits 'delete' for its msgId", async () => {
    const client = fakeClient();
    const { lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("clip", "delete me", 123, "m-del");
    await waitForRender(() => expect(lastFrame()).toContain("delete me"));
    client.emit("delete", "m-del");
    await waitForRender(() => expect(lastFrame()).not.toContain("delete me"));
  });

  it("copies the selected clip to the clipboard on 'c'", async () => {
    const client = fakeClient();
    const copy = vi.fn(async () => true);
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} copy={copy} />);
    await tick();
    client.emit("clip", "copy me", 1, "m1");
    await waitForRender(() => expect(lastFrame()).toContain("copy me")); // ensure the row rendered before navigating
    stdin.write("\x1B"); // Esc → switch from composing to list-navigation
    await tick();
    stdin.write("c");   // copy selected
    await tick();
    expect(copy).toHaveBeenCalledWith("copy me");
  });

  it("connects on mount", async () => {
    const client = fakeClient();
    render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    expect(client.connect).toHaveBeenCalled();
  });

  it("opens the send-file prompt on 'f' and calls sendFile with the typed path's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uniclip-app-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "x.txt"), "hello");
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    stdin.write("\x1B");                 // Esc → navigate mode
    await tick();
    stdin.write("f");                    // open the send-file prompt
    await tick();
    await waitForRender(() => expect(lastFrame()).toContain("Send file"));
    for (const ch of join(dir, "x.txt")) stdin.write(ch); // type the path
    await tick();
    stdin.write("\r");                   // submit
    await waitForRender(() => expect(client.sendFile).toHaveBeenCalled());
    expect(client.sendFile).toHaveBeenCalledTimes(1); // single input handler — no double-submit in a real pty
    const arg = (client.sendFile.mock.calls as unknown as Array<[{ name: string; bytes: Uint8Array }]>)[0]![0];
    expect(arg.name).toBe("x.txt");
    expect(Buffer.from(arg.bytes).toString("utf8")).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows an accept/decline prompt for a non-inline offer and accepts on 'a'", async () => {
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("file-offer", { fileId: "f1", name: "doc.pdf", mime: "application/pdf", size: 2048, chunkCount: 1, hash: "h", inline: false });
    await waitForRender(() => expect(lastFrame()).toContain("doc.pdf"));
    expect(lastFrame()).toMatch(/accept/i);
    stdin.write("a");
    await waitForRender(() => expect(client.acceptFile).toHaveBeenCalledWith("f1"));
  });

  it("declines a non-inline offer on 'd'", async () => {
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("file-offer", { fileId: "f2", name: "big.zip", mime: "application/zip", size: 4096, chunkCount: 1, hash: "h", inline: false });
    await waitForRender(() => expect(lastFrame()).toContain("big.zip"));
    stdin.write("d");
    await waitForRender(() => expect(client.declineFile).toHaveBeenCalledWith("f2"));
    expect(client.acceptFile).not.toHaveBeenCalled();
  });

  it("does NOT show a prompt for an inline offer (engine auto-accepts)", async () => {
    const client = fakeClient();
    const { lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("file-offer", { fileId: "f3", name: "pic.png", mime: "image/png", size: 1024, chunkCount: 1, hash: "h", inline: true });
    await tick();
    await tick();
    expect(lastFrame()).not.toMatch(/accept/i);
    expect(lastFrame()).not.toContain("pic.png");
    expect(client.acceptFile).not.toHaveBeenCalled();
    expect(client.declineFile).not.toHaveBeenCalled();
  });

  it("saves a received file into the cwd (sanitized) on file-received", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uniclip-recv-"));
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const client = fakeClient();
    render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    await tick();
    client.emit("file-received", { fileId: "f1", blob: new Blob([new Uint8Array([1, 2, 3])]), name: "../escape.bin", mime: "application/octet-stream" });
    await waitForRender(() => expect(readdirSync(dir)).toContain("escape.bin")); // traversal stripped
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});
