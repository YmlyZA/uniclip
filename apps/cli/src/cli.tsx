import { render } from "ink";
import { parseRoomUrl } from "@uniclip/room-code";
import { App } from "./app";
import { createRoom, makeClient } from "./session";
import { asciiQr } from "./qr";
import { parseArgs } from "./args";
import { startLanHost, joinLan } from "./lan-session";
import { parseLanToken } from "./lan-token";

// Re-export so tests can import { parseArgs } from "./cli" per the task spec.
export { parseArgs } from "./args";

async function main() {
  const { roomUrl: arg, relay, name, relayOnly, lan } = parseArgs(process.argv.slice(2));

  // Offline LAN host.
  if (lan) {
    const host = await startLanHost({ ...(name ? { deviceName: name } : {}) });
    const qr = await asciiQr(host.token);
    const { waitUntilExit } = render(
      <App client={host.client as any} roomUrl={host.roomUrl} qr={qr} onExit={() => host.dispose()} />,
    );
    await waitUntilExit();
    return;
  }

  // Offline LAN join (scanned/pasted token).
  if (arg && parseLanToken(arg)) {
    let joiner;
    try {
      joiner = await joinLan(arg, { ...(name ? { deviceName: name } : {}) });
    } catch (e) {
      console.error(`Couldn't find that room on this network: ${(e as Error).message}`);
      console.error("Make sure both devices are on the same Wi-Fi/LAN.");
      process.exit(1);
    }
    const { waitUntilExit } = render(
      <App client={joiner.client as any} roomUrl={joiner.roomUrl} qr="" onExit={() => joiner.dispose()} />,
    );
    await waitUntilExit();
    return;
  }
  // …existing relay-connected path (create-or-join via the public relay) unchanged below…

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
