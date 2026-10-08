export const DEFAULT_MODEL_ID: string;
export const MODELS: {
  id: string;
  name: string;
  bytes: number;
  memoryMB: number;
}[];
export function promptCharsFor(
  id: string,
): { system: number; examples: number; exampleTurns: number } | null;
export function inspectEnvironment(): Promise<{
  supported: boolean;
  reason: string;
  engines: Record<string, { supported: boolean; reason: string }>;
}>;
export function inspectModelCaches(): Promise<{
  counts: Record<string, number>;
  bytes: Record<string, number>;
  runtimeBytes: number;
  runtimeFiles: number;
}>;
export interface AIEvent {
  event: string;
  text?: string;
  progress?: number;
}
export interface AIClient {
  request(
    action: string,
    payload?: Record<string, unknown>,
    options?: {
      onEvent?: (event: AIEvent) => void;
      firstMs?: number;
      timeoutMs?: number;
    },
  ): Promise<{ text: string }>;
  stop(): void;
}
