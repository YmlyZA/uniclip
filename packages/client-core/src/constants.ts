// Single in-band data channel label shared by both peers.
export const DATACHANNEL_LABEL = "uniclip";
// If P2P has not opened within this window of a peer being present, stay on the
// relay (no error). A later peer-join re-arms the attempt.
export const P2P_CONNECT_TIMEOUT_MS = 8_000;
