import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Header } from "./components/Header";
import { ClipList } from "./components/ClipList";
import { Composer } from "./components/Composer";
import { PairScreen } from "./components/PairScreen";
import { Footer } from "./components/Footer";
import { copyToClipboard } from "./clipboard";

const MAX_TEXT_BYTES = 32 * 1024;

type Item = { id: string; text: string; ts: number; mine: boolean };
type ClientLike = {
  on: (k: string, cb: (...a: any[]) => void) => void;
  connect: () => Promise<void> | void;
  send: (t: string) => Promise<unknown> | unknown;
  disconnect: () => void;
};

export function App({
  client,
  roomUrl,
  qr,
  onExit,
  copy = copyToClipboard,
}: {
  client: ClientLike;
  roomUrl: string;
  qr: string;
  onExit: () => void;
  copy?: (t: string) => Promise<boolean>;
}) {
  const app = useApp();
  const routingId = (() => {
    try {
      return new URL(roomUrl).pathname.split("/r/")[1] ?? "?";
    } catch {
      return "?";
    }
  })();
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("connecting");
  const [peerCount, setPeerCount] = useState(1);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [composing, setComposing] = useState(true);
  const [note, setNote] = useState("");

  // Register client handlers and connect on mount; disconnect on unmount.
  useEffect(() => {
    client.on("status", (s: string) =>
      setStatus(s === "connected" ? "secure channel" : s),
    );
    client.on("transport", (t: string) =>
      setStatus(t === "p2p" ? "direct" : "secure channel"),
    );
    client.on("peer", (n: number) => setPeerCount(n));
    client.on("clip", (text: string, ts: number, msgId: string) =>
      setItems((prev) => [...prev, { id: msgId, text, ts, mine: false }]),
    );
    client.on("error", (e: { message: string }) => setNote(e.message));
    void client.connect();
    return () => client.disconnect();
  }, [client]);

  // Ink's useInput handles raw mode, ANSI parsing, and cleanup automatically.
  useInput((inp, key) => {
    const quit = () => {
      client.disconnect();
      onExit();
      app.exit();
    };

    if (key.ctrl && inp === "c") {
      quit();
      return;
    }

    if (composing) {
      // In compose mode only intercept Esc; everything else goes to TextInput.
      if (key.escape) setComposing(false);
      return;
    }

    // Navigate mode
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(items.length - 1, s + 1));
      return;
    }
    if (inp === "c" || key.return) {
      const it = items[selected];
      if (it)
        void copy(it.text).then((ok) =>
          setNote(ok ? "Copied to clipboard" : "Clipboard unavailable"),
        );
      return;
    }
    if (key.escape) {
      setComposing(true);
      return;
    }
    if (inp === "q") {
      quit();
      return;
    }
  });

  const over = Buffer.byteLength(input, "utf8") > MAX_TEXT_BYTES;

  function send() {
    const text = input.trim();
    if (!text || over) return;
    const msgId = `local-${Date.now()}-${items.length}`;
    setItems((prev) => [...prev, { id: msgId, text, ts: Date.now(), mine: true }]);
    void client.send(text);
    setInput("");
  }

  const paired = peerCount >= 2 || items.length > 0;

  return (
    <Box flexDirection="column">
      <Header routingId={routingId} status={status} peerCount={peerCount} />
      {!paired ? (
        <PairScreen roomUrl={roomUrl} qr={qr} />
      ) : (
        <ClipList items={items} selected={selected} />
      )}
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={send}
        over={over}
        {...(!composing ? { focus: false } : {})}
      />
      {note ? (
        <Box paddingX={1}>
          <Text dimColor>{note}</Text>
        </Box>
      ) : null}
      <Footer />
    </Box>
  );
}
