import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./app";

// Minimal fake UniclipClient: capture handlers, let the test drive events.
function fakeClient() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: (k: string, cb: Function) => ((handlers[k] ||= []).push(cb)),
    emit: (k: string, ...a: unknown[]) => (handlers[k] || []).forEach((f) => f(...a)),
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ msgId: "x", ts: 1, queued: false })),
    disconnect: vi.fn(),
  };
}

describe("App", () => {
  it("appends a clip row when the client emits 'clip'", async () => {
    const client = fakeClient();
    const { lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    client.emit("clip", "hello from peer", 123, "m1");
    await Promise.resolve();
    expect(lastFrame()).toContain("hello from peer");
  });

  it("copies the selected clip to the clipboard on 'c'", async () => {
    const client = fakeClient();
    const copy = vi.fn(async () => true);
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} copy={copy} />);
    client.emit("clip", "copy me", 1, "m1");
    await Promise.resolve();
    stdin.write(""); // Esc → switch from composing to list-navigation
    stdin.write("c");           // copy selected
    await Promise.resolve();
    expect(copy).toHaveBeenCalledWith("copy me");
  });

  it("connects on mount", () => {
    const client = fakeClient();
    render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    expect(client.connect).toHaveBeenCalled();
  });
});
