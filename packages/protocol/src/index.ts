import { z } from "zod";

export const MAX_FRAME_BYTES = 64 * 1024;

export const PROTOCOL_VERSION = 1;

// Binary transfer (Phase 2 v0.2). CHUNK_BYTES is sized so a base64+JSON frame
// stays under MAX_FRAME_BYTES; the rest are engine tunables.
export const CHUNK_BYTES = 32 * 1024;
export const INLINE_IMAGE_MAX = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const CREDIT_WINDOW = 32;
export const ACK_INTERVAL = 16;
export const STALL_TIMEOUT_MS = 30_000;

// ULID: 26 chars, Crockford alphabet (no I, L, O, U)
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const Base64 = z.string().regex(/^[A-Za-z0-9+/=]+$/);

export const ClipboardFrameSchema = z
  .object({
    type: z.literal("clip"),
    msgId: z.string().regex(ULID_REGEX),
    iv: Base64,
    ciphertext: Base64,
    ts: z.number().int().nonnegative(),
  })
  .strict();

export type ClipboardFrame = z.infer<typeof ClipboardFrameSchema>;

export const DeleteFrameSchema = z
  .object({
    type: z.literal("delete"),
    msgId: z.string().regex(ULID_REGEX),
  })
  .strict();

export type DeleteFrame = z.infer<typeof DeleteFrameSchema>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const FileOfferSchema = z
  .object({
    type: z.literal("file-offer"),
    fileId: z.string().regex(ULID_REGEX),
    name: z.string().max(255),
    mime: z.string().max(255),
    size: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    hash: Sha256Hex,
    inline: z.boolean(),
  })
  .strict();

export const FileAcceptSchema = z
  .object({ type: z.literal("file-accept"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileDeclineSchema = z
  .object({ type: z.literal("file-decline"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileChunkSchema = z
  .object({
    type: z.literal("file-chunk"),
    fileId: z.string().regex(ULID_REGEX),
    index: z.number().int().nonnegative(),
    isFinal: z.boolean(),
    iv: Base64,
    ciphertext: Base64,
  })
  .strict();

export const FileAckSchema = z
  .object({ type: z.literal("file-ack"), fileId: z.string().regex(ULID_REGEX), upTo: z.number().int().nonnegative() })
  .strict();

export const FileCompleteSchema = z
  .object({ type: z.literal("file-complete"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileCancelSchema = z
  .object({ type: z.literal("file-cancel"), fileId: z.string().regex(ULID_REGEX), reason: z.string().max(120) })
  .strict();

// WebRTC signaling (Phase 3 v0.3). Opaque to the relay — fanned out, never
// buffered. `from` is a per-connection random peer id carried on signaling
// frames for peer identity / future use; it is NOT used for politeness
// tiebreaking (politeness is role-only: responder = polite). The relay neither
// assigns nor validates it. `candidate` is a JSON-serialized
// RTCIceCandidateInit, or "" for end-of-candidates.
export const ICE_SERVERS: { urls: string }[] = [{ urls: "stun:stun.l.google.com:19302" }];

export const SdpFrameSchema = z
  .object({
    type: z.literal("sdp"),
    from: z.string().max(64),
    description: z
      .object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(16 * 1024) })
      .strict(),
  })
  .strict();

export const IceFrameSchema = z
  .object({
    type: z.literal("ice"),
    from: z.string().max(64),
    candidate: z.string().max(4096),
  })
  .strict();

// WebRTC identity announce (reconnect hardening). Opaque to the relay (fanned
// out, never buffered). The larger `from` becomes the sole data-channel
// initiator, making role assignment deterministic across any reconnect order.
export const RtcHelloSchema = z
  .object({ type: z.literal("rtc-hello"), from: z.string().max(64) })
  .strict();

// Encrypted device-presence announce (named roster). Opaque to the relay
// (fanned out, never buffered). Plaintext under `ciphertext` is
// JSON {id,name}, encrypted with the room key under AAD `presence:${routingId}`.
export const PresenceFrameSchema = z
  .object({ type: z.literal("presence"), iv: Base64, ciphertext: Base64 })
  .strict();

export const HelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    roomId: z.string(),
    peerCount: z.number().int().nonnegative(),
    serverTime: z.number().int().nonnegative(),
    // Whether this room backfills recent clips to late joiners. Always false
    // for Mode B (the relay only buffers ciphertext it cannot decrypt).
    backfill: z.boolean(),
    // Ephemeral rooms: no device persists history and items auto-expire on
    // screen. Optional-with-default so a new client tolerates an old relay's
    // hello (which lacks the field) during a rolling deploy.
    ephemeral: z.boolean().optional().default(false),
    // Wire protocol version; lets an old client reject newer frames gracefully.
    protocolVersion: z.number().int().optional().default(PROTOCOL_VERSION),
  })
  .strict();

export const PeerJoinedFrameSchema = z
  .object({
    type: z.literal("peer-joined"),
    peerCount: z.number().int().nonnegative(),
  })
  .strict();

export const PeerLeftFrameSchema = z
  .object({
    type: z.literal("peer-left"),
    peerCount: z.number().int().nonnegative(),
  })
  .strict();

export const ErrorCode = z.enum([
  "ROOM_EXPIRED",
  "RATE_LIMIT",
  "TOO_LARGE",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string(),
  })
  .strict();

export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloFrameSchema,
  PeerJoinedFrameSchema,
  PeerLeftFrameSchema,
  ClipboardFrameSchema,
  DeleteFrameSchema,
  ErrorFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
  SdpFrameSchema,
  IceFrameSchema,
  RtcHelloSchema,
  PresenceFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  ClipboardFrameSchema,
  DeleteFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
  SdpFrameSchema,
  IceFrameSchema,
  RtcHelloSchema,
  PresenceFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// WS close codes (private range 4000–4999 per RFC 6455)
export const CLOSE_CODES = {
  ROOM_NOT_FOUND: 4404,
  RATE_LIMIT: 4429,
  TOO_LARGE: 4413,
  ROOM_EXPIRED: 4410,
} as const;
