import type { AIClient } from "./local-ai.js";
export const localAISession: EventTarget & {
  notice: string;
  notify(): void;
  ready: boolean;
  busy: boolean;
  momoEnabled: boolean;
  modelId: string;
  save(patch: { momoEnabled?: boolean }): boolean;
  run<T>(owner: string, task: (client: AIClient) => Promise<T>): Promise<T>;
  cancel(owner: string): boolean;
};
