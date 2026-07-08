import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Header } from "./components/Header";
import { ClipList } from "./components/ClipList";
import { Composer } from "./components/Composer";
import { PairScreen } from "./components/PairScreen";
import { Footer } from "./components/Footer";
import { Transfers } from "./components/Transfers";
import { copyToClipboard } from "./clipboard";
import { upsertTransfer, removeTransfer, type TransferRow } from "./file-transfers";
import { readForSend, saveBlob } from "./file-io";
import { stripTerminal } from "./sanitize-terminal";

// Mirrors the web app's 32 KB text cap (aligned to @uniclip/protocol MAX_FRAME_BYTES = 64 KB).
const MAX_TEXT_BYTES = 32 * 1024;

type Item = { id: string; text: string; ts: number; mine: boolean };
type ClientLike = {
  on: (k: string, cb: (...a: any[]) => void) => void;
  connect: () => Promise<void> | void;
  send: (t: string) => Promise<unknown> | unknown;
  sendFile: (f: { name: string; mime: string; bytes: Uint8Array }) => Promise<unknown>;
  acceptFile: (id: string) => void;
  declineFile: (id: string) => void;
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
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [offer, setOffer] = useState<{ fileId: string; name: string; size: number } | null>(null);
  const [filePrompt, setFilePrompt] = useState(false);
  const [filePath, setFilePath] = useState("");

  // Track fileId→name for progress rows.
  const names = useRef<Record<string, string>>({});
  const nameFor = (id: string) => names.current[id] ?? "file";

  // Refs to avoid stale closures in useInput (Ink re-registers the handler on
  // every render, but the effect flush may lag one tick in test environments).
  const offerRef = useRef(offer);
  const filePromptRef = useRef(filePrompt);
  const composingRef = useRef(composing);
  const itemsRef = useRef(items);
  const selectedRef = useRef(selected);
  // Accumulate file path in a ref so rapid synchronous keystrokes (e.g. in
  // tests) are captured correctly even before React batches state updates.
  const filePathAccum = useRef("");
  offerRef.current = offer;
  filePromptRef.current = filePrompt;
  composingRef.current = composing;
  itemsRef.current = items;
  selectedRef.current = selected;

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
    client.on("file-offer", (o: { fileId: string; name: string; size: number; inline: boolean }) => {
      if (o.inline) return; // engine auto-accepts inline images; we just save on receipt
      names.current[o.fileId] = o.name;
      setOffer((cur) => cur ?? { fileId: o.fileId, name: o.name, size: o.size });
    });
    client.on("file-progress", (p: { fileId: string; dir: "send" | "recv"; sent: number; total: number }) =>
      setTransfers((rows) => upsertTransfer(rows, { fileId: p.fileId, dir: p.dir, name: nameFor(p.fileId), sent: p.sent, total: p.total })),
    );
    client.on("file-received", (r: { fileId: string; blob: Blob; name: string }) => {
      names.current[r.fileId] = r.name;
      void saveBlob(process.cwd(), r.name, r.blob).then(
        (path) => { setTransfers((rows) => removeTransfer(rows, r.fileId)); setNote(`Saved ${path}`); },
        () => setNote("Could not save the received file"),
      );
    });
    client.on("file-error", (e: { fileId: string; message: string }) => {
      setTransfers((rows) => removeTransfer(rows, e.fileId));
      setNote(e.message);
    });
    client.on("file-cancel", (c: { fileId: string }) => setTransfers((rows) => removeTransfer(rows, c.fileId)));
    void client.connect();
    return () => client.disconnect();
  }, [client]);

  function doSubmitFile(path: string) {
    const trimmed = path.trim();
    filePathAccum.current = "";
    setFilePrompt(false);
    setFilePath("");
    if (!trimmed) return;
    void readForSend(trimmed).then(
      async (file) => {
        const res = (await client.sendFile(file)) as { fileId: string } | null;
        if (res) names.current[res.fileId] = file.name;
        setNote(`Sending ${file.name}…`);
      },
      (e: NodeJS.ErrnoException) => setNote(`Can't read ${trimmed}: ${e.code ?? e.message}`),
    );
  }

  // Ink's useInput handles raw mode, ANSI parsing, and cleanup automatically.
  // We read from refs so the handler always sees the current state even if the
  // effect re-registration has not flushed yet (relevant in test environments).
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

    // Offer prompt is a modal — handle it first.
    const currentOffer = offerRef.current;
    if (currentOffer) {
      if (inp === "a") { client.acceptFile(currentOffer.fileId); setOffer(null); }
      else if (inp === "d") { client.declineFile(currentOffer.fileId); setOffer(null); }
      return; // modal: swallow other keys while an offer is pending
    }

    // File-path prompt: accumulate input in the ref so rapid sync writes
    // (e.g. test loops) are captured even before React state batching flushes.
    if (filePromptRef.current) {
      if (key.escape) {
        filePathAccum.current = "";
        setFilePrompt(false);
        setFilePath("");
      } else if (key.return) {
        doSubmitFile(filePathAccum.current);
      } else if (key.backspace || key.delete) {
        filePathAccum.current = filePathAccum.current.slice(0, -1);
        setFilePath(filePathAccum.current);
      } else if (inp && !key.ctrl && !key.meta) {
        filePathAccum.current += inp;
        setFilePath(filePathAccum.current);
      }
      return; // always return — TextInput handles display only
    }

    if (composingRef.current) {
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
      setSelected((s) => Math.min(itemsRef.current.length - 1, s + 1));
      return;
    }
    if (inp === "c" || key.return) {
      const it = itemsRef.current[selectedRef.current];
      if (it)
        void copy(it.text).then((ok) =>
          setNote(ok ? "Copied to clipboard" : "Clipboard unavailable"),
        );
      return;
    }
    if (inp === "f") { setFilePrompt(true); return; }
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
      {offer ? (
        <Box paddingX={1}>
          <Text>Incoming file <Text bold>{stripTerminal(offer.name)}</Text> ({Math.ceil(offer.size / 1024)} KB) — accept [a] / decline [d]</Text>
        </Box>
      ) : filePrompt ? (
        <Box paddingX={1}>
          <Text>Send file: {filePath}<Text inverse> </Text></Text>
        </Box>
      ) : (
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={send}
          over={over}
          {...(!composing ? { focus: false } : {})}
        />
      )}
      <Transfers rows={transfers} />
      {note ? (
        <Box paddingX={1}><Text dimColor>{note}</Text></Box>
      ) : null}
      <Footer />
    </Box>
  );
}
