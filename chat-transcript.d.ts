export interface ChatMessage {
  id: string;
  me: boolean;
  text: string;
  time: string;
  status: string;
  speakerType: string;
  sourceKind: string;
  createdAt: number | null;
}
export interface Memory {
  id: string;
  roomId: string;
  text: string;
  sourceMessageId: string | null;
  enabled: boolean;
  expiresAt: number | null;
}
export interface RoomCache {
  roomId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  userMessageCount: number;
}
export interface Summary {
  roomId: string;
  last: ChatMessage;
  userMessageCount: number;
}
export class ChatTranscript {
  static open(options?: {
    legacyRaw?: string | null;
    onBlocked?: () => void;
  }): Promise<ChatTranscript>;
  close(): void;
  load(id: string): Promise<RoomCache>;
  loadOlder(id: string): Promise<RoomCache | null>;
  cached(id: string): RoomCache | null;
  append(
    id: string,
    message: {
      id?: string;
      speakerType: string;
      text: string;
      sourceKind: string;
      createdAt?: number;
      expectedLastMessageId?: string;
    },
  ): Promise<ChatMessage>;
  refreshSummaries(): Promise<Summary[]>;
  summaries(): Summary[];
  summary(id: string): Summary | null;
  retryTarget(id: string): ChatMessage | null;
  memories(id: string): Promise<Memory[]>;
  saveMemory(draft: {
    roomId: string;
    text: string;
    sourceMessageId?: string;
    sourceText?: string;
  }): Promise<Memory>;
  updateMemory(
    id: string,
    patch: Partial<Pick<Memory, "text" | "enabled" | "expiresAt">>,
  ): Promise<Memory>;
  deleteMemory(id: string): Promise<unknown>;
  deleteRoom(id: string): Promise<unknown>;
  deleteAll(): Promise<unknown>;
  exportBundle(): Promise<string>;
  importBundle(raw: string, options?: { replace?: boolean }): Promise<unknown>;
  searchRoom(
    id: string,
    options: { query: string; limit?: number },
  ): Promise<
    {
      id: string;
      text: string;
      speakerType: string;
      createdAt: number | null;
    }[]
  >;
}
