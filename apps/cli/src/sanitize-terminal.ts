// Neutralize terminal control sequences in peer-controlled text before it is
// rendered with Ink's <Text>. Ink does not strip escape sequences itself, so
// a peer could otherwise embed e.g. an OSC-52 "set clipboard" sequence to
// hijack the victim's OS clipboard, or cursor/screen control to spoof the
// terminal. Display-only: never apply this to copied-to-clipboard or
// stored/persisted text.
//
// Order matters: strip full sequences first, then any residual control bytes.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g; // ESC [ ... final
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // ESC ] ... BEL or ST
const ESC2 = /\x1b[@-Z\\-_]/g; // two-char ESC seqs
const CTRL = /[\x00-\x1f\x7f-\x9f]/g; // residual C0/C1/DEL (incl. lone ESC)

export function stripTerminal(s: string): string {
  return s.replace(CSI, "").replace(OSC, "").replace(ESC2, "").replace(CTRL, "");
}
