import { deriveKey } from "@uniclip/crypto";
import { MODE_B_SALT, type ParsedRoom } from "@uniclip/room-code";

/**
 * The single source of truth for turning a parsed room into its AES key.
 * Mode A derives from the URL-fragment secret (relay never sees it); Mode B
 * derives from the routingId the server already knows. This MUST match the
 * relay's Mode-B derivation, or peers cannot decrypt each other.
 */
export function deriveRoomKey(room: ParsedRoom): Promise<CryptoKey> {
  return room.mode === "A"
    ? deriveKey({ secret: room.secret, salt: room.routingId })
    : deriveKey({ secret: room.routingId, salt: MODE_B_SALT });
}
