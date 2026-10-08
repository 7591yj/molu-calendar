import { useCallback, useEffect, useRef, useState } from "react";
import { ChatTranscript } from "../../chat-transcript.js";
import type { ChatMessage, RoomCache, Summary } from "../../chat-transcript.js";

export function useChat() {
  const transcript = useRef<ChatTranscript | null>(null);
  const [store, setStore] = useState<ChatTranscript | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const [rooms, setRooms] = useState<Record<string, ChatMessage[]>>({});
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadedRooms = useRef(new Set<string>());
  const pending = useRef<(() => Promise<unknown>) | null>(null);
  const update = useCallback((cache: RoomCache | null) => {
    if (cache)
      setRooms((previous) => ({
        ...previous,
        [cache.roomId]: [...cache.messages],
      }));
  }, []);
  const refresh = useCallback(async () => {
    const store = transcript.current;
    if (!store) return;
    setSummaries(await store.refreshSummaries());
    for (const id of loadedRooms.current) update(await store.load(id));
  }, [update]);
  useEffect(() => {
    let disposed = false;
    let opened: ChatTranscript | null = null;
    let legacyRaw: string | null = null;
    try {
      // Preserve the snapshot; ChatTranscript.open migrates it atomically to IndexedDB.
      legacyRaw = localStorage.getItem("molu.momotalk.v1");
    } catch {
      setError("이 브라우저에서 이전 대화 저장소를 읽을 수 없어요.");
    }
    void ChatTranscript.open({
      legacyRaw,
      onBlocked: () => setError("다른 탭을 닫고 다시 시도해 주세요."),
    })
      .then(async (store) => {
        opened = store;
        if (disposed) {
          store.close();
          return;
        }
        transcript.current = store;
        setStore(store);
        await refresh();
        if (!disposed) {
          setReady(true);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(String(cause));
      });
    const broadcasts = new BroadcastChannel("molu-chat-memory");
    channel.current = broadcasts;
    broadcasts.onmessage = () => {
      void refresh().catch((cause: unknown) => setError(String(cause)));
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === "molu.momotalk.v1" && event.newValue !== legacyRaw)
        setError(
          "이전 버전의 대화가 다른 탭에서 변경됐어요. 새로고침 전에 기록을 내보내 주세요.",
        );
    };
    window.addEventListener("storage", storageChanged);
    return () => {
      disposed = true;
      opened?.close();
      transcript.current = null;
      broadcasts.close();
      window.removeEventListener("storage", storageChanged);
    };
  }, [attempt, refresh]);
  const mutate = async <T>(
    operation: (store: ChatTranscript) => Promise<T>,
  ): Promise<T> => {
    const store = transcript.current;
    if (!store) throw new Error("대화 저장소를 준비 중이에요.");
    const run = async () => {
      const result = await operation(store);
      setSummaries(store.summaries());
      channel.current?.postMessage("changed");
      return result;
    };
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "ChatStorageConflict") {
        await refresh();
        throw cause;
      }
      pending.current = run;
      setError(String(cause));
      throw cause;
    }
  };
  const load = async (id: string) => {
    const store = transcript.current;
    if (!store) return;
    try {
      loadedRooms.current.add(id);
      update(await store.load(id));
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  };
  const append = async (
    id: string,
    message: {
      me: boolean;
      text: string;
      sourceKind?: string;
      expectedLastMessageId?: string;
    },
  ) => {
    const messageId = crypto.randomUUID();
    return mutate(async (store) => {
      const result = await store.append(id, {
        id: messageId,
        expectedLastMessageId: message.expectedLastMessageId,
        text: message.text,
        speakerType: message.me ? "user" : "character",
        sourceKind: message.sourceKind ?? (message.me ? "user-input" : "app"),
      });
      update(store.cached(id));
      return result;
    });
  };
  const retry = async () => {
    try {
      if (pending.current) {
        await pending.current();
        pending.current = null;
        await refresh();
        setError("");
      } else {
        setReady(false);
        setAttempt((value) => value + 1);
      }
    } catch (cause) {
      setError(String(cause));
    }
  };
  return {
    transcript,
    store,
    rooms,
    summaries,
    error,
    ready,
    update,
    mutate,
    load,
    append,
    refresh,
    retry,
    notify: () => channel.current?.postMessage("changed"),
  };
}
