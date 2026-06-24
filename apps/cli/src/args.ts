/** Pure argv parser — no side effects, safe to import in tests. */
export function parseArgs(argv: string[]): { roomUrl?: string; relay: string; name?: string; relayOnly: boolean } {
  let roomUrl: string | undefined;
  let relay = process.env.UNICLIP_RELAY ?? "http://localhost:3000";
  let name: string | undefined;
  let relayOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--relay") { relay = argv[++i] ?? relay; }
    else if (a === "--name") { name = argv[++i]; }
    else if (a === "--relay-only") { relayOnly = true; }
    else if (!a.startsWith("-")) { roomUrl = a; }
  }
  return {
    ...(roomUrl !== undefined ? { roomUrl } : {}),
    relay,
    ...(name !== undefined ? { name } : {}),
    relayOnly,
  };
}
