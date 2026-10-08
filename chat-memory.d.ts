import type { Memory } from "./chat-transcript.js";
export function selectMemories(
  memories: Memory[],
  options: { roomId: string; query: string },
): { id: string; text: string }[];
export function selectExcerpts(
  excerpts: { id: string; text: string }[],
  options: { currentId?: string; recentIds?: string[] },
): { id: string; text: string }[];
export function filterMemories(memories: Memory[], query: string): Memory[];
