import { Box, Text } from "ink";
import type { TransferRow } from "../file-transfers";

const pct = (sent: number, total: number) => (total > 0 ? Math.floor((sent / total) * 100) : 0);

export function Transfers({ rows }: { rows: TransferRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((r) => (
        <Text key={r.fileId} dimColor>
          {r.dir === "send" ? "↑" : "↓"} {r.name} {pct(r.sent, r.total)}%
        </Text>
      ))}
    </Box>
  );
}
