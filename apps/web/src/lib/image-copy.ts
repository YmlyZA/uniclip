/** The async Clipboard write API accepts essentially only image/png for raster
 * data (Chrome throws "Type image/jpeg not supported on write"). Anything else
 * has to be transcoded to PNG first. */
export function imageNeedsPng(type: string): boolean {
  return type !== "image/png";
}

/** Draw any decodable image blob onto an offscreen canvas and re-encode as PNG. */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (!imageNeedsPng(blob.type)) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("canvas.toBlob produced no PNG");
    return png;
  } finally {
    bitmap.close();
  }
}

/**
 * Copy an image to the system clipboard. Transcodes non-PNG blobs to PNG
 * (Chrome only writes image/png) and passes a Promise<Blob> to ClipboardItem
 * so Safari keeps the originating user gesture alive across the async
 * conversion (constructing the ClipboardItem synchronously inside the click is
 * what authorizes the write). Throws if the clipboard write is unsupported.
 */
export async function copyImageToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": toPngBlob(blob) }),
  ]);
}
