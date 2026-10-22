import { drawMark, flattenSize, type Mark, type Size } from '@/lib/media-annotate'

/**
 * Image + marks -> PNG bytes at the image's natural resolution (capped, see
 * `flattenSize`). `image` is the exact blob the annotate view shows (read
 * over IPC once: the unrooted route sends no CORS header, so drawing a served
 * <img> would taint the canvas), so the result matches what the user saw even
 * if the file changes meanwhile. Animated images flatten their first frame. createImageBitmap decodes and OffscreenCanvas.convertToBlob encodes
 * off the main thread, so a large screenshot does not freeze the UI.
 * `natural` is the <img>'s natural size, the space the marks were drawn in.
 */
export async function flattenMarked(image: Blob, natural: Size, marks: Mark[]): Promise<Uint8Array> {
  // Decode straight to the capped output size, so a huge image never has a
  // full-resolution bitmap (AnnotateView also refuses oversized headers).
  const target = flattenSize(natural)
  const bitmap = await createImageBitmap(image, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' })
  try {
    const out = { width: bitmap.width, height: bitmap.height }
    const canvas = new OffscreenCanvas(out.width, out.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(bitmap, 0, 0, out.width, out.height)
    // Marks are in <img> natural pixels; scale them onto the (capped) output.
    ctx.setTransform(out.width / Math.max(1, natural.width), 0, 0, out.height / Math.max(1, natural.height), 0, 0)
    for (const m of marks) drawMark(ctx, m)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}
