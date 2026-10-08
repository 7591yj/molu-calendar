export const clampPosition = value => Math.min(100, Math.max(0, value));

export function parseCropPosition(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value.map(clampPosition);
  const match = typeof value === 'string' && value.match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  return match ? match.slice(1).map(value => clampPosition(Number(value))) : [50, 50];
}

export const clampCropScale = value => Math.min(5, Math.max(0.25, value));
export const clampCropCenter = value => Math.min(500, Math.max(-500, value));

export function cropSettings(value) {
  const settings = {
    position: parseCropPosition(value?.position ?? value),
    scale: Number.isFinite(value?.scale) ? clampCropScale(value.scale) : 1,
  };
  if (Array.isArray(value?.center) && value.center.length === 2 && value.center.every(Number.isFinite)) {
    settings.center = value.center.map(clampCropCenter);
  }
  return settings;
}

// Scale 1 matches cover; larger regions include transparent space outside the source.
export function cropRegion(width, height, [x, y], scale = 1, center) {
  const cropWidth = Math.min(width, height * 2) * scale;
  const cropHeight = cropWidth / 2;
  const w = cropWidth / width * 100;
  const h = cropHeight / height * 100;
  return { x: center ? center[0] - w / 2 : (100 - w) * x / 100, y: center ? center[1] - h / 2 : (100 - h) * y / 100, w, h };
}

// Position the original image in a transparent 2:1 frame (no raster export needed).
export function cropImageStyle(region) {
  return { left: `${-region.x / region.w * 100}%`, top: `${-region.y / region.h * 100}%`, width: `${10000 / region.w}%`, height: `${10000 / region.h}%` };
}

export function withCrop(crops, file, position, scale = 1, center) {
  const next = { ...crops };
  if (scale === 1 && (center ?? position).every(value => value === 50)) delete next[file];
  else next[file] = { position: [...position], scale, ...(center ? { center: [...center] } : {}) };
  return next;
}

export function moveCropCenter(center, dx, dy, box) {
  return [clampCropCenter(center[0] + dx / box.width * 100), clampCropCenter(center[1] + dy / box.height * 100)];
}

// Keep the opposite edge/corner fixed. Corner movement is projected onto a 2:1 diagonal.
export function resizeCrop(width, height, settings, dx, dy, box, handle) {
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const region = cropRegion(width, height, settings.position, settings.scale, settings.center);
  const cw = region.w / 100 * width, ch = cw / 2;
  const cx = (region.x + region.w / 2) / 100 * width, cy = (region.y + region.h / 2) / 100 * height;
  const px = dx / box.width * width, py = dy / box.height * height;
  const delta = sx && sy ? (sx * px + sy * py / 2) / 1.25 : sx ? sx * px : 2 * sy * py;
  const base = Math.min(width, height * 2);
  const scale = clampCropScale((cw + delta) / base);
  const nw = base * scale, nh = nw / 2;
  const center = [
    clampCropCenter((cx - sx * cw / 2 + sx * nw / 2) / width * 100),
    clampCropCenter((cy - sy * ch / 2 + sy * nh / 2) / height * 100),
  ];
  return { scale, center };
}
