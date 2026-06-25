import { Box, Text } from "ink";
import TextInput from "ink-text-input";
export function Composer({ value, onChange, onSubmit, over, focus = true }: { value: string; onChange: (v: string) => void; onSubmit: () => void; over: boolean; focus?: boolean }) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text color="cyan">› </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus={focus} placeholder="Type and press Enter to send" />
      </Box>
      {over && <Text color="red">Too large to send (max 32 KB).</Text>}
    </Box>
  );
}
