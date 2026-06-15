import { z } from "zod";

export const MAX_FRAME_BYTES = 64 * 1024;

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

export const HelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    roomId: z.string(),
    peerCount: z.number().int().nonnegative(),
    serverTime: z.number().int().nonnegative(),
    // Whether this room backfills recent clips to late joiners. Always false
    // for Mode B (the relay only buffers ciphertext it cannot decrypt).
    backfill: z.boolean(),
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
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  ClipboardFrameSchema,
  DeleteFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// WS close codes (private range 4000–4999 per RFC 6455)
export const CLOSE_CODES = {
  ROOM_NOT_FOUND: 4404,
  RATE_LIMIT: 4429,
  TOO_LARGE: 4413,
} as const;
