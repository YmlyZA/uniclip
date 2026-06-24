import { render } from "ink";
import { parseRoomUrl } from "@uniclip/room-code";
import { App } from "./app";
import { createRoom, makeClient } from "./session";
import { asciiQr } from "./qr";
import { parseArgs } from "./args";

// Re-export so tests can import { parseArgs } from "./cli" per the task spec.
export { parseArgs } from "./args";

async function main() {
  const { roomUrl: arg, relay, name, relayOnly } = parseArgs(process.argv.slice(2));
  let roomUrl: string;
  if (arg) {
    if (!parseRoomUrl(arg)) {
      console.error("Invalid room URL. Expected https://host/r/<id>#<secret>");
      process.exit(1);
    }
    roomUrl = arg;
  } else {
    try {
      ({ roomUrl } = await createRoom(relay));
    } catch (e) {
      console.error(`Could not create a room on ${relay}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const qr = await asciiQr(roomUrl);
  const client = makeClient({ roomUrl, relayOnly, ...(name ? { deviceName: name } : {}) });
  const { waitUntilExit } = render(
    <App
      client={client as any}
      roomUrl={roomUrl}
      qr={qr}
      onExit={() => client.disconnect()}
    />,
  );
  await waitUntilExit();
}

// Only run when executed as the bin entry (never during tests or imports).
if (process.argv[1] && /cli\.(tsx|js)$/.test(process.argv[1])) {
  void main();
}
