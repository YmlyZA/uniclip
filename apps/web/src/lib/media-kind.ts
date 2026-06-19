export type MediaKind = "image" | "video" | "audio" | "openable" | "file";

// Types a browser will render inline in a new tab (its native viewer) but that
// we don't embed a player for. Kept narrow on purpose; everything else is a
// plain download.
const OPENABLE_EXACT = new Set(["application/pdf", "application/json"]);

/**
 * How a received file should be surfaced: image/video/audio get an inline
 * preview/player, "openable" gets an Open-in-new-tab button (the browser
 * previews it), and "file" is download-only. This makes previewable types
 * behave like images instead of forcing a download that iOS Safari just
 * previews anyway.
 */
export function mediaKind(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || OPENABLE_EXACT.has(mime)) return "openable";
  return "file";
}
