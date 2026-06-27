// Dedicated entrypoint for the `bun build --compile` standalone binary. The
// tsup build keeps using cli.tsx (whose argv-guard only runs main() when argv[1]
// is cli.js); in a compiled binary argv[1] is the binary name, so that guard
// stays false and main() would never run — this entry calls it explicitly.
import { main } from "./cli";

void main();
