import { useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useApp, useStdin } from "ink";
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
  const { stdin } = useStdin();
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

  // Keep a ref to composing/items/selected so the stdin handler sees current values
  const stateRef = useRef({ composing, items, selected, input });
  stateRef.current = { composing, items, selected, input };

  // Register client handlers and connect synchronously (useLayoutEffect fires during commit)
  useLayoutEffect(() => {
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

  // Register keyboard handler synchronously via useLayoutEffect + raw stdin
  useLayoutEffect(() => {
    if (!stdin) return;
    const handleData = (data: string | Buffer) => {
      const ch = typeof data === "string" ? data : data.toString("utf8");
      const ESC = "\x1B";
      const isEscape = ch === ESC;
      const isCtrlC = ch === "\x03";
      const isReturn = ch === "\r" || ch === "\n";
      const isUp = ch === "\x1B[A";
      const isDown = ch === "\x1B[B";

      const { composing: c, items: its, selected: sel, input: inp } = stateRef.current;

      if (isCtrlC) {
        onExit();
        app.exit();
        return;
      }

      if (c) {
        // composing mode — only handle Esc; typing is handled by TextInput
        if (isEscape) setComposing(false);
        return;
      }

      // list-navigation mode
      if (ch === "q") {
        onExit();
        app.exit();
        return;
      }
      if (isEscape) {
        setComposing(true);
        return;
      }
      if (isUp) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (isDown) {
        setSelected((s) => Math.min(its.length - 1, s + 1));
        return;
      }
      if (ch === "c" || isReturn) {
        const it = its[sel];
        if (it)
          void copy(it.text).then((ok) =>
            setNote(ok ? "Copied to clipboard" : "Clipboard unavailable"),
          );
      }
    };

    stdin.on("data", handleData);
    return () => {
      stdin.off("data", handleData);
    };
  }, [stdin, app, onExit, copy]);

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
