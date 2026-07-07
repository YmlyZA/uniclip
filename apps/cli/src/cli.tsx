import { render } from "ink";
import { parseRoomUrl } from "@uniclip/room-code";
import { App } from "./app";
import { createRoom, makeClient } from "./session";
import { asciiQr } from "./qr";
import { parseArgs } from "./args";
import { startLanHost, joinLan } from "./lan-session";
import { parseLanToken } from "./lan-token";
import { attachDiagLog } from "./diag-log";
import { versionString } from "./version";

// Re-export so tests can import { parseArgs } from "./cli" per the task spec.
export { parseArgs } from "./args";

const USAGE = `uniclip — end-to-end-encrypted universal clipboard (CLI)

Usage:
  uniclip                     create a room (prints a QR to scan)
  uniclip <room-url>          join a room
  uniclip --lan               host an offline LAN room (no internet)
  uniclip <lan-token>         join an offline LAN room

Options:
  --relay <base>   relay base URL (env UNICLIP_RELAY, default http://localhost:3000)
  --name <name>    device name shown in the roster
  --relay-only     force relay transport (disable P2P)
  -V, --verbose    print transport diagnostics to stderr (state machine + hints)
  -h, --help       show this help
  -v, --version    show version`;

export async function main() {
  const { roomUrl: arg, relay, name, relayOnly, lan, help, version, verbose } = parseArgs(process.argv.slice(2));

  if (version) { console.log(versionString()); return; }
  if (help) { console.log(USAGE); return; }

  // Offline LAN host.
  if (lan) {
    const host = await startLanHost({ ...(name ? { deviceName: name } : {}) });
    if (verbose) attachDiagLog(host.client as any);
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
      if (verbose) console.error("[hint] ! mDNS found nothing — suspect guest/AP-isolation Wi-Fi blocking multicast.");
      process.exit(1);
    }
    if (verbose) attachDiagLog(joiner.client as any);
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
  const client = await makeClient({ roomUrl, relayOnly, ...(name ? { deviceName: name } : {}) });
  if (verbose) attachDiagLog(client);
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
