/** Upstream schema v1, kept separate from the official Nexon KR schema v2 feed. */
export interface CalendarEvent {
  id: string;
  title: string;
  category: string;
  all_day: boolean;
  start: string;
  end?: string | null;
  status: string;
  description?: string;
  source_url?: string;
  images?: Record<string, string>;
  servers?: string[];
}
export interface CalendarBundle {
  schema_version: 1;
  events: CalendarEvent[];
}
export interface LaneSegment {
  startPos: number;
  endPos: number;
  lane?: number;
}
export type Position = [number, number];
export interface CropSettings {
  position: Position;
  scale: number;
  center?: Position;
}
export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CropBox {
  width: number;
  height: number;
}
