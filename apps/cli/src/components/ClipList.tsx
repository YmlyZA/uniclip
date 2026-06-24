import { Box, Text } from "ink";
type Item = { id: string; text: string; ts: number; mine: boolean };
export function ClipList({ items, selected }: { items: Item[]; selected: number }) {
  if (items.length === 0) return <Box paddingY={1}><Text dimColor>No clips yet — type below to send.</Text></Box>;
  return (
    <Box flexDirection="column" paddingY={1}>
      {items.map((it, i) => (
        <Box key={it.id}>
          <Text {...(i === selected ? { color: "cyan" as const } : {})}>{i === selected ? "❯ " : "  "}</Text>
          <Text dimColor>{it.mine ? "you" : "peer"} </Text>
          <Text wrap="truncate-end">{it.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
