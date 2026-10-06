// Native-extension check: SVG is a vector format with an infinite canvas, so
// an SVG given the whole square viewport re-renders at that viewport and
// paints its own margins — nothing synthetic is ever added. Rasters
// (jpeg/png/webp/gif) end at their last pixel and simply letterbox over
// whatever surface they sit on. Detected via a HEAD request (same-origin,
// local services, cheap); any failure means "not svg".
export async function isSvgUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return (res.headers.get('content-type') || '').includes('svg');
  } catch (e) {
    return false;
  }
}
