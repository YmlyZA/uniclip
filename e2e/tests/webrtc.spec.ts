import { test, expect, chromium } from "@playwright/test";

test("clip travels and the Direct badge appears over WebRTC", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await pageB.goto(roomUrl);

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Both peers present → WebRTC should connect via Chromium loopback ICE.
  await expect(pageA.getByTestId("transport")).toHaveText("Direct", { timeout: 15_000 });

  await pageA.getByRole("textbox").fill("hello over p2p");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("hello over p2p")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});

test("falls back to Relayed and still delivers when P2P is forced off", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  // ?forceRelay=1 makes room.svelte build the client with iceServers:[] and skip
  // arming the PeerLink (see Step 2). Append before the #fragment so the secret
  // is preserved: insert the query on the path portion.
  const relayUrl = roomUrl.replace("#", "?forceRelay=1#");
  await pageA.goto(relayUrl);
  await pageB.goto(relayUrl);

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageA.getByTestId("transport")).toHaveText("Relayed", { timeout: 10_000 });

  await pageA.getByRole("textbox").fill("hello over relay");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("hello over relay")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});
