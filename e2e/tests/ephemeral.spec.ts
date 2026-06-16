import { test, expect, chromium } from "@playwright/test";

test("ephemeral room: peers sync live, nothing persists on reload", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();

  // A creates a Mode-A room with the Ephemeral toggle ON.
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByText(/Ephemeral — don't save anything/i).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  // The ephemeral badge confirms hello carried the flag.
  await expect(pageA.getByText(/Ephemeral · not saved/i)).toBeVisible({ timeout: 5_000 });

  // B joins FIRST so it is already connected and can receive the live clip.
  // (Ephemeral rooms have backfill forced off, so B cannot receive anything
  // it was not connected to see in real time.)
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends a clip; B is already connected so it receives it live.
  await pageA.getByRole("textbox").fill("ephemeral secret");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("ephemeral secret")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral secret")).toBeVisible({ timeout: 5_000 });

  // Reload B: an ephemeral room persists nothing, so its history is empty.
  // (Backfill is forced off for ephemeral rooms, so the relay replays nothing
  // either.) Assert the clip is gone after reload — no 60s TTL wait needed.
  await pageB.reload();
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral secret")).toHaveCount(0);

  await browser.close();
});
