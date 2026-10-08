import type { ChatMessage } from "./chat-transcript.js";
export function momoSupportsAI(id: string): boolean;
export function momoCalendarQuery(text: string): string | null;
export function momoPromptPlan(options: {
  history: ChatMessage[];
  text: string;
  fixedChars: number;
  memories: { id: string; text: string }[];
  excerpts: { id: string; text: string }[];
}): {
  messages: { role: string; content: string }[];
  memories: { id: string; text: string }[];
  excerpts: { id: string; text: string }[];
  fixedChars: number;
  historyChars: number;
  referenceChars: number;
  promptChars: number;
  droppedTurns: number;
  fits: boolean;
};
