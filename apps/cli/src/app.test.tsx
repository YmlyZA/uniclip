import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./app";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

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
    await tick();
    client.emit("clip", "hello from peer", 123, "m1");
    // Poll the rendered frame: one setTimeout(0) tick is not always enough for
    // React's state update to flush through Ink's renderer under CI load.
    await vi.waitFor(() => expect(lastFrame()).toContain("hello from peer"));
  });

  it("copies the selected clip to the clipboard on 'c'", async () => {
    const client = fakeClient();
    const copy = vi.fn(async () => true);
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} copy={copy} />);
    await tick();
    client.emit("clip", "copy me", 1, "m1");
    await vi.waitFor(() => expect(lastFrame()).toContain("copy me")); // ensure the row rendered before navigating
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
});
