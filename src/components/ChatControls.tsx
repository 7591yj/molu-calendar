import { useEffect, useState } from "react";
import type { ChatTranscript, Memory } from "../../chat-transcript.js";
import { filterMemories } from "../../chat-memory.js";
import { inspectEnvironment, MODELS } from "../../local-ai.js";
import { localAISession } from "../../local-ai-session.js";
import { primaryButton, quietButton } from "./ui.tsx";

const field =
  "min-h-10 min-w-0 rounded-lg border border-control bg-surface px-3 text-sm";
export function ChatControls({
  store,
  room,
  onChange,
  busy,
  version,
}: {
  store: ChatTranscript | null;
  room: string | null;
  onChange: () => Promise<void>;
  busy: boolean;
  version: number;
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState("");
  const [ai, setAI] = useState({
    ready: localAISession.ready,
    enabled: localAISession.momoEnabled,
    busy: localAISession.busy,
  });
  const [now] = useState(() => Date.now());
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const changed = () => {
      if (localAISession.notice) setNotice(localAISession.notice);
      setAI({
        ready: localAISession.ready,
        enabled: localAISession.momoEnabled,
        busy: localAISession.busy,
      });
    };
    localAISession.addEventListener("change", changed);
    return () => localAISession.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    let disposed = false;
    if (room && store)
      void store
        .memories(room)
        .then((rows) => {
          if (!disposed) setMemories(rows);
        })
        .catch((cause: unknown) => setNotice(String(cause)));
    return () => {
      disposed = true;
    };
  }, [room, store, version]);
  const action = async (task: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await task();
      if (room && store) setMemories(await store.memories(room));
      await onChange();
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      setWorking(false);
    }
  };
  const exportBackup = async () => {
    if (!store) return;
    const url = URL.createObjectURL(
      new Blob([await store.exportBundle()], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "molu-chat-backup.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("대화와 기억을 내보냈어요.");
  };
  return (
    <details className="shrink-0 border-b border-line py-2">
      <summary className="cursor-pointer text-sm font-semibold">
        대화 기록 · 기억 · 로컬 AI
      </summary>
      <div className="mt-3 max-h-[min(16rem,30dvh)] scroll-thin space-y-3 overflow-y-auto text-sm">
        <p>
          대화는 이 브라우저에 저장돼요. 모델 답변은 자동으로 기억이 되지
          않아요.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={quietButton}
            disabled={!store || working}
            onClick={() => void action(exportBackup)}
          >
            기록 내보내기
          </button>
          <label className={quietButton}>
            백업 가져오기
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              disabled={!store || busy || working}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file || !store) return;
                if (file.size > 32 * 1024 * 1024) {
                  setNotice("백업은 32 MiB 이하여야 해요.");
                  return;
                }
                if (
                  !window.confirm("현재 대화와 기억을 이 백업으로 교체할까요?")
                )
                  return;
                void action(async () => {
                  await store.importBundle(await file.text(), {
                    replace: true,
                  });
                  setNotice("백업을 복원했어요.");
                });
              }}
            />
          </label>
          <button
            className={quietButton}
            disabled={!store || busy || working}
            onClick={() => {
              if (store && window.confirm("모든 대화와 기억을 삭제할까요?"))
                void action(() => store.deleteAll());
            }}
          >
            전체 기록 삭제
          </button>
          {room && (
            <button
              className={quietButton}
              disabled={!store || busy || working}
              onClick={() => {
                if (
                  store &&
                  window.confirm("이 방의 대화와 기억을 삭제할까요?")
                )
                  void action(() => store.deleteRoom(room));
              }}
            >
              이 대화 삭제
            </button>
          )}
          <button
            className={quietButton}
            onClick={() =>
              void action(async () => {
                const estimate = await navigator.storage.estimate();
                setUsage(
                  `브라우저 저장소 ${(Number(estimate.usage ?? 0) / 1024 / 1024).toFixed(1)} / ${(Number(estimate.quota ?? 0) / 1024 / 1024).toFixed(0)} MiB · ${(await navigator.storage.persisted()) ? "보존 중" : "자동 정리될 수 있어요"}`,
                );
              })
            }
          >
            저장소 사용량
          </button>
          <button
            className={quietButton}
            onClick={() => {
              void action(async () => {
                const persisted = await navigator.storage.persist();
                setUsage(
                  persisted
                    ? "저장소 보존 요청이 승인됐어요."
                    : "브라우저가 보존 요청을 승인하지 않았어요. 백업을 보관해 주세요.",
                );
              });
            }}
          >
            저장소 보존 요청
          </button>
        </div>
        {usage && <p role="status">{usage}</p>}
        {room && (
          <section aria-label="이 대화의 기억" className="space-y-2">
            <h3 className="font-semibold">이 대화의 기억</h3>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!store) return;
                void action(async () => {
                  await store.saveMemory({ roomId: room, text: text.trim() });
                  setText("");
                });
              }}
            >
              <input
                className={`${field} flex-1`}
                aria-label="새 기억"
                placeholder="기억할 내용을 입력하세요"
                maxLength={500}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <button
                className={primaryButton}
                disabled={!store || working || !text.trim()}
              >
                기억 추가
              </button>
            </form>
            <input
              className={`${field} w-full`}
              type="search"
              aria-label="기억 검색"
              maxLength={200}
              placeholder="기억 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {filterMemories(memories, query).map((memory) => (
              <div key={memory.id} className="border-b border-line-soft py-2">
                <p className="wrap-anywhere">{memory.text}</p>
                <p className="text-xs text-muted">
                  {!memory.enabled
                    ? "사용 중지"
                    : memory.expiresAt !== null && memory.expiresAt <= now
                      ? "만료됨"
                      : "사용 중"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={quietButton}
                    disabled={working}
                    onClick={() => {
                      const next = window.prompt("기억 수정", memory.text);
                      if (next?.trim() && store)
                        void action(() =>
                          store.updateMemory(memory.id, { text: next.trim() }),
                        );
                    }}
                  >
                    수정
                  </button>
                  <button
                    className={quietButton}
                    disabled={working}
                    onClick={() => {
                      if (store)
                        void action(() =>
                          store.updateMemory(memory.id, {
                            enabled: !memory.enabled,
                          }),
                        );
                    }}
                  >
                    {memory.enabled ? "사용 중지" : "다시 사용"}
                  </button>
                  <button
                    className={quietButton}
                    disabled={working}
                    onClick={() => {
                      if (store)
                        void action(() =>
                          store.updateMemory(memory.id, {
                            expiresAt:
                              memory.expiresAt === null ? Date.now() : null,
                          }),
                        );
                    }}
                  >
                    {memory.expiresAt === null ? "만료시키기" : "만료 해제"}
                  </button>
                  <button
                    className={quietButton}
                    disabled={working}
                    onClick={() => {
                      if (store)
                        void action(() => store.deleteMemory(memory.id));
                    }}
                  >
                    기억 삭제
                  </button>
                </div>
              </div>
            ))}
            {!memories.length && (
              <p className="text-muted">
                저장된 기억이 없어요. 메시지 아래의 기억하기로 원문을 연결할
                수도 있어요.
              </p>
            )}
          </section>
        )}
        <section aria-label="로컬 AI" className="space-y-2">
          <h3 className="font-semibold">로컬 AI · {MODELS[0]!.name}</h3>
          <p>
            선택하면 약 2 GB를 다운로드해요. 대화는 기기에서 처리돼요.
            Chromium의 WebGPU가 필요해요.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(event) => {
                if (!localAISession.save({ momoEnabled: event.target.checked }))
                  setNotice("AI 설정을 저장하지 못했어요.");
              }}
            />
            지원하는 학생과 AI로 대화
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={primaryButton}
              disabled={ai.busy || ai.ready}
              onClick={() =>
                void action(async () => {
                  const environment = await inspectEnvironment();
                  if (!environment.engines.litert?.supported)
                    throw new Error(
                      environment.engines.litert?.reason ?? environment.reason,
                    );
                  await localAISession.run("settings", (client) =>
                    client.request(
                      "load",
                      { modelId: localAISession.modelId },
                      {
                        timeoutMs: 600000,
                        onEvent: (event) => {
                          if (event.text) {
                            localAISession.notice = event.text;
                            localAISession.notify();
                          }
                        },
                      },
                    ),
                  );
                  setNotice("모델이 준비됐어요.");
                })
              }
            >
              {ai.ready ? "모델 준비됨" : "모델 다운로드 · 준비"}
            </button>
            <button
              className={quietButton}
              onClick={() => {
                localAISession.cancel("settings");
                localAISession.cancel("momotalk");
                setNotice("작업을 중단했어요.");
              }}
            >
              중단
            </button>
            <button
              className={quietButton}
              disabled={ai.busy}
              onClick={() =>
                void action(async () => {
                  await localAISession.run("settings", (client) =>
                    client.request("delete", {
                      modelId: localAISession.modelId,
                    }),
                  );
                  setNotice("모델 캐시를 삭제했어요.");
                })
              }
            >
              모델 캐시 삭제
            </button>
          </div>
        </section>
        {notice && (
          <p role="status" className="wrap-anywhere">
            {notice}
          </p>
        )}
      </div>
    </details>
  );
}
