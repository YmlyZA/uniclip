import { Box, Text } from "ink";
export function Header({ routingId, status, peerCount }: { routingId: string; status: string; peerCount: number }) {
  return (
    <Box justifyContent="space-between" borderStyle="round" paddingX={1}>
      <Text>uniclip · <Text color="cyan">{routingId}</Text> · Mode A</Text>
      <Text color={status === "secure channel" ? "green" : "yellow"}>{status} · {peerCount} {peerCount === 1 ? "device" : "devices"}</Text>
    </Box>
  );
}
