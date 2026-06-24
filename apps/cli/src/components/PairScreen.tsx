import { Box, Text } from "ink";
export function PairScreen({ roomUrl, qr }: { roomUrl: string; qr: string }) {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold>Scan to pair, or open this link on another device:</Text>
      <Text color="cyan">{roomUrl}</Text>
      <Box marginTop={1}><Text>{qr}</Text></Box>
      <Text dimColor>Waiting for another device…</Text>
    </Box>
  );
}
