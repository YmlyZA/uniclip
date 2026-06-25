import { test, expect, chromium } from "@playwright/test";

test("offline send queues, shows pending, and flushes on reconnect", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });

  // Patch WebSocket before any page loads so we can enumerate and close instances.
  await ctxA.addInitScript(() => {
    const OrigWS = window.WebSocket;
    const tracked: WebSocket[] = [];
    class PatchedWS extends OrigWS {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        tracked.push(this);
      }
    }
    (window as unknown as Record<string, unknown>).__closeRelayWS = () => {
      // Close only the relay WS (port 3000), not Vite HMR (port 5173).
      for (const ws of tracked) {
        const url = ws.url ?? "";
        if (
          url.includes(":3000") &&
          (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ) {
          ws.close();
        }
      }
    };
    window.WebSocket = PatchedWS;
  });

  const pageA = await ctxA.newPage();

  // A creates a normal (non-ephemeral) Mode-A room.
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // B joins so it can receive the flushed clip later.
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Force A offline. ORDER MATTERS: close the live relay WS *while still online*
  // first, THEN go offline.
  //   - setOffline alone does not drop an already-open WebSocket in Chromium (it
  //     only blocks new connections), so an explicit close is required to make the
  //     client enter "reconnecting".
  //   - Closing AFTER going offline is racy: the WS closing handshake can't
  //     complete over a dead network, so Chromium delays the `onclose` event
  //     (until an internal timeout), intermittently pushing the "Reconnecting"
  //     pill past the assertion below. Closing while online fires `onclose`
  //     promptly → the client emits "reconnecting" deterministically.
  //   - The client's first reconnect attempt is ~1s out (Backoff baseMs 1000), so
  //     setOffline (applied in <100ms) lands well before it and blocks the
  //     reconnect — the client stays reconnecting instead of re-establishing.
  await pageA.evaluate(() => {
    (window as unknown as Record<string, () => void>).__closeRelayWS?.();
  });
  await ctxA.setOffline(true);
  // Status-pill shows "Reconnecting" once the relay WS drops.
  await expect(pageA.getByText(/Reconnecting/i)).toBeVisible({ timeout: 10_000 });

  // Type while offline → optimistic item with a Queued marker, nothing delivered.
  await pageA.getByRole("textbox").fill("sent while offline");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("sent while offline")).toBeVisible({ timeout: 5_000 });
  await expect(pageA.getByText(/Queued/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("sent while offline")).toHaveCount(0);

  // Back online → client reconnects, flushes the queue on hello.
  await ctxA.setOffline(false);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 15_000 });

  // B receives the flushed clip, and A's pending marker clears.
  // Check B first with a generous timeout — network propagation from relay to B is
  // async relative to A's "sent" event firing.
  await expect(pageB.getByText("sent while offline")).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText(/Queued/i)).toHaveCount(0, { timeout: 5_000 });

  await browser.close();
});
