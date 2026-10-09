import type { Position, CropSettings, CropRegion, CropBox } from "./types.ts";

export const clampPosition = (value: number) =>
  Math.min(100, Math.max(0, value));

export function parseCropPosition(value: unknown): Position {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(Number.isFinite)
  )
    return value.map(clampPosition) as Position;
  const match =
    typeof value === "string" &&
    value.match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  return match
    ? (match.slice(1).map((value) => clampPosition(Number(value))) as Position)
    : [50, 50];
}

export const clampCropScale = (value: number) =>
  Math.min(5, Math.max(0.25, value));
export const clampCropCenter = (value: number) =>
  Math.min(500, Math.max(-500, value));

export function cropSettings(value: unknown): CropSettings {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const settings: CropSettings = {
    position: parseCropPosition(input.position ?? value),
    scale:
      typeof input.scale === "number" && Number.isFinite(input.scale)
        ? clampCropScale(Number(input.scale))
        : 1,
  };
  if (
    Array.isArray(input.center) &&
    input.center.length === 2 &&
    input.center.every(Number.isFinite)
  ) {
    settings.center = input.center.map(clampCropCenter) as Position;
  }
  return settings;
}

// Scale 1 matches cover; larger regions include transparent space outside the source.
export function cropRegion(
  width: number,
  height: number,
  [x, y]: Position,
  scale = 1,
  center?: Position,
): CropRegion {
  const cropWidth = Math.min(width, height * 2) * scale;
  const cropHeight = cropWidth / 2;
  const w = (cropWidth / width) * 100;
  const h = (cropHeight / height) * 100;
  return {
    x: center ? center[0] - w / 2 : ((100 - w) * x) / 100,
    y: center ? center[1] - h / 2 : ((100 - h) * y) / 100,
    w,
    h,
  };
}

// Position the original image in a transparent 2:1 frame (no raster export needed).
export function cropImageStyle(region: CropRegion) {
  return {
    left: `${(-region.x / region.w) * 100}%`,
    top: `${(-region.y / region.h) * 100}%`,
    width: `${10000 / region.w}%`,
    height: `${10000 / region.h}%`,
  };
}

export function withCrop(
  crops: Record<string, CropSettings>,
  file: string,
  position: Position,
  scale = 1,
  center?: Position,
) {
  const next = { ...crops };
  if (scale === 1 && (center ?? position).every((value) => value === 50))
    delete next[file];
  else
    next[file] = {
      position: [...position],
      scale,
      ...(center ? { center: [...center] } : {}),
    };
  return next;
}

export function moveCropCenter(
  center: Position,
  dx: number,
  dy: number,
  box: CropBox,
): Position {
  return [
    clampCropCenter(center[0] + (dx / box.width) * 100),
    clampCropCenter(center[1] + (dy / box.height) * 100),
  ];
}

// Keep the opposite edge/corner fixed. Corner movement is projected onto a 2:1 diagonal.
export function resizeCrop(
  width: number,
  height: number,
  settings: CropSettings,
  dx: number,
  dy: number,
  box: CropBox,
  handle: string,
) {
  const sx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const sy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  const region = cropRegion(
    width,
    height,
    settings.position,
    settings.scale,
    settings.center,
  );
  const cw = (region.w / 100) * width,
    ch = cw / 2;
  const cx = ((region.x + region.w / 2) / 100) * width,
    cy = ((region.y + region.h / 2) / 100) * height;
  const px = (dx / box.width) * width,
    py = (dy / box.height) * height;
  const delta =
    sx && sy ? (sx * px + (sy * py) / 2) / 1.25 : sx ? sx * px : 2 * sy * py;
  const base = Math.min(width, height * 2);
  const scale = clampCropScale((cw + delta) / base);
  const nw = base * scale,
    nh = nw / 2;
  const center: Position = [
    clampCropCenter(((cx - (sx * cw) / 2 + (sx * nw) / 2) / width) * 100),
    clampCropCenter(((cy - (sy * ch) / 2 + (sy * nh) / 2) / height) * 100),
  ];
  return { scale, center };
}
