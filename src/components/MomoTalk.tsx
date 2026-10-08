import { useEffect, useRef, useState } from "react";
import { usePersistentState } from "../hooks.ts";
import type { FeedEvent } from "../lib/feed.ts";
import {
  ARONA,
  cleanRooms,
  momoReply,
  momoTopicsFor,
  scheduleReply,
} from "../lib/momotalk.ts";
import type { Message, Rooms, Student } from "../lib/momotalk.ts";
import { sitePath } from "../lib/urls.ts";
import { cx } from "../lib/cx.ts";
import { Dialog, iconButton, primaryButton, quietButton } from "./ui.tsx";
import { Icon } from "./Icon.tsx";

const time = () =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((id) => typeof id === "string");
const isCounts = (v: unknown): v is Record<string, number> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v).every(
    (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
  );
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isRooms = (v: unknown): v is Rooms => !!v && typeof v === "object";
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

function Avatar({
  student,
  large = false,
}: {
  student: Student;
  large?: boolean;
}) {
  return (
    <img
      src={sitePath(`resource/momotalk/${student.img}`)}
      alt=""
      loading="lazy"
      className={cx(
        "shrink-0 rounded-full border border-line bg-surface-2 object-cover",
        large ? "size-20" : "size-11",
      )}
    />
  );
}
function Profile({ student }: { student: Student }) {
  const facts = [
    [
      "소속",
      [student.school, student.year, student.club].filter(Boolean).join(" · "),
    ],
    ["생일", student.birthday],
    ["나이", student.age],
    ["키", student.height],
    ["취미", student.hobby],
    ["성우", student.voice],
    ["일러스트", student.illust],
  ].filter(([, value]) => value);
  return (
    <div className="p-5">
      <Avatar student={student} large />
      <h3 className="mt-3 text-lg font-semibold">{student.name}</h3>
      <p className="mt-1 text-sm text-muted">{student.status}</p>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {student.intro && <p className="mt-5 text-sm/relaxed">{student.intro}</p>}
    </div>
  );
}

function legacySound() {
  try {
    return (
      JSON.parse(localStorage.getItem("molu.prefs.v1") ?? "{}").momoSound !==
      false
    );
  } catch {
    return true;
  }
}

export function MomoTalk({
  events,
  open,
  onClose,
  onUnread,
}: {
  events: FeedEvent[];
  open: boolean;
  onClose: () => void;
  onUnread: (total: number) => void;
}) {
  const [students, setStudents] = useState<Student[]>([ARONA]);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stored, setRooms] = usePersistentState<Rooms>(
    "molu.momotalk.v1",
    {},
    isRooms,
  );
  const rooms = cleanRooms(stored);
  const [unread, setUnread] = usePersistentState(
    "molu.momotalk.unread.v1",
    {},
    isCounts,
  );
  const [favorites, setFavorites] = usePersistentState(
    "molu.momo.fav.v1",
    [],
    isIds,
  );
  const [sound, setSound] = usePersistentState(
    "molu.momo.sound.v1",
    legacySound(),
    isBoolean,
  );
  const [pane, setPane] = useState<"friends" | "chat">("friends");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("Arona");
  const [room, setRoom] = useState<string | null>(null);
  const [profile, setProfile] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const active = useRef({ open, room });
  const audio = useRef<HTMLAudioElement | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
  const student = students.find((s) => s.id === (room ?? selected)) ?? ARONA;
  const messages = room ? (rooms[room] ?? []) : [];
  const topics = momoTopicsFor(room ?? selected);
  const topic = topics[messages.filter((m) => m.me).length % topics.length]!;

  useEffect(() => {
    active.current = { open, room };
    // Replies that landed while the window was closed are read once it reopens.
    if (open && room)
      setUnread((current) =>
        current[room] ? { ...current, [room]: 0 } : current,
      );
  }, [open, room, setUnread]);
  useEffect(() => onUnread(total), [total, onUnread]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      audio.current?.pause();
    },
    [],
  );
  useEffect(() => {
    if (open && room) messagesEnd.current?.scrollIntoView({ block: "nearest" });
  }, [open, room, stored, busy]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(sitePath("resource/momotalk/students.json"), {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error("Student data unavailable");
        return r.json();
      })
      .then((data: unknown) => {
        if (
          !Array.isArray(data) ||
          !data.every(
            (s) =>
              s &&
              typeof s.id === "string" &&
              typeof s.name === "string" &&
              typeof s.img === "string",
          )
        )
          throw new Error("Invalid student data");
        setStudents([ARONA, ...data.filter((s) => s.id !== "Arona")]);
        setLoadError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [open, attempt]);

  const append = (id: string, message: Message) =>
    setRooms((current) => {
      const cleaned = cleanRooms(current);
      return { ...cleaned, [id]: [...(cleaned[id] ?? []), message].slice(-60) };
    });
  const openRoom = (id: string) => {
    setRoom(id);
    setSelected(id);
    setProfile(false);
    setInput("");
    setUnread((current) => ({ ...current, [id]: 0 }));
    if (!rooms[id]?.length)
      append(id, { me: false, text: momoTopicsFor(id)[0]!.ask, time: time() });
  };
  const chime = () => {
    if (!sound) return;
    audio.current ??= new Audio(
      sitePath("resource/momotalk/ui/SE_MomoTalk_01.wav"),
    );
    audio.current.volume = 0.5;
    audio.current.currentTime = 0;
    void audio.current.play().catch(() => {});
  };
  const send = (text: string, reply?: string) => {
    if (!room || busy || !text.trim()) return;
    const id = room;
    const answer = scheduleReply(reply ?? momoReply(text, student), events);
    const nextTopic =
      topics[(messages.filter((m) => m.me).length + 1) % topics.length]!;
    append(id, { me: true, text: text.trim().slice(0, 200), time: time() });
    setInput("");
    setBusy(id);
    const receive = (text: string) => {
      append(id, { me: false, text, time: time() });
      chime();
      if (!active.current.open || active.current.room !== id)
        setUnread((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
    };
    timers.current.push(
      setTimeout(() => {
        receive(answer);
        timers.current.push(
          setTimeout(() => {
            receive(nextTopic.ask);
            setBusy(null);
          }, 650),
        );
      }, 650),
    );
  };
  const hits = students
    .filter((s) =>
      normalize(
        [s.name, s.short, s.school, s.club, s.status].join(" "),
      ).includes(normalize(query)),
    )
    .sort(
      (a, b) =>
        Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
    );
  const chatIds = Object.keys(rooms).filter(
    (id) => rooms[id]?.length && (!onlyUnread || unread[id]),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="MomoTalk"
      labelledBy="momotalk-title"
      icon="chat"
      className="w-[min(900px,calc(100vw-24px))]"
      actions={
        <button
          type="button"
          className={iconButton}
          aria-label="모모톡 알림음"
          aria-pressed={sound}
          onClick={() => setSound(!sound)}
        >
          <Icon name={sound ? "sound" : "muted"} />
        </button>
      }
    >
      <h2 id="momotalk-title" className="sr-only">
        MomoTalk
      </h2>
      <div className="flex h-[min(650px,calc(100dvh-180px))] min-h-[300px] flex-col">
        {room ? (
          <>
            <header className="flex shrink-0 items-center gap-3 border-b border-line pb-3">
              <button
                type="button"
                className={iconButton}
                aria-label="대화 목록으로"
                onClick={() => {
                  setRoom(null);
                  setProfile(false);
                  setPane("chat");
                }}
              >
                <Icon name="chevron" className="rotate-180" />
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => setProfile(!profile)}
                aria-expanded={profile}
                aria-label={`${student.short} 프로필`}
              >
                <Avatar student={student} />
                <span>
                  <strong>{student.short}</strong>
                  <small className="block text-xs text-muted">
                    {[student.school, student.club].filter(Boolean).join(" · ")}
                  </small>
                </span>
              </button>
            </header>
            {profile ? (
              <div className="flex-1 scroll-thin overflow-y-auto">
                <Profile student={student} />
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => setProfile(false)}
                >
                  대화로 돌아가기
                </button>
              </div>
            ) : (
              <>
                <div
                  role="log"
                  aria-label={`${student.short}와의 대화`}
                  aria-live="polite"
                  className="flex min-h-0 flex-1 scroll-thin flex-col gap-4 overflow-y-auto bg-surface-2 p-4 max-sm:px-2"
                >
                  {messages.map((message, index) => (
                    <div
                      key={index}
                      className={cx(
                        "flex items-start gap-2",
                        message.me && "flex-row-reverse",
                      )}
                    >
                      {!message.me && <Avatar student={student} />}
                      <div className="max-w-[80%]">
                        {!message.me && (
                          <p className="mb-1 text-xs font-semibold">
                            {student.short}
                          </p>
                        )}
                        <p
                          className={cx(
                            "rounded-lg px-3 py-2 text-sm/relaxed wrap-anywhere whitespace-pre-wrap",
                            message.me
                              ? "bg-blue text-white"
                              : "border border-line bg-surface",
                          )}
                        >
                          {message.text}
                        </p>
                        <time className="mt-1 block text-right text-2xs text-muted">
                          {message.time}
                        </time>
                      </div>
                    </div>
                  ))}
                  {busy === room && (
                    <p className="text-xs text-muted" role="status">
                      {student.short} 입력 중…
                    </p>
                  )}
                  <div ref={messagesEnd} />
                </div>
                <div
                  className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line pt-3"
                  aria-label="답장 선택"
                >
                  {topic.options.map((option) => (
                    <button
                      key={option.text}
                      type="button"
                      className={cx(quietButton, "text-sm")}
                      disabled={!!busy}
                      onClick={() => send(option.text, option.reply)}
                    >
                      {option.text}
                    </button>
                  ))}
                </div>
                <form
                  className="mt-3 flex shrink-0 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send(input);
                  }}
                >
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-control bg-surface px-3 text-sm placeholder:text-muted"
                    aria-label="메시지 입력"
                    placeholder="메시지를 입력하세요"
                    maxLength={200}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  <button
                    className={primaryButton}
                    type="submit"
                    disabled={!!busy || !input.trim()}
                  >
                    전송
                  </button>
                </form>
              </>
            )}
          </>
        ) : (
          <>
            <nav
              className="flex shrink-0 gap-2 border-b border-line pb-3"
              aria-label="모모톡 보기 전환"
            >
              <button
                type="button"
                className={pane === "friends" ? primaryButton : quietButton}
                aria-pressed={pane === "friends"}
                onClick={() => setPane("friends")}
              >
                친구
              </button>
              <button
                type="button"
                className={pane === "chat" ? primaryButton : quietButton}
                aria-pressed={pane === "chat"}
                onClick={() => setPane("chat")}
              >
                채팅{total > 0 ? ` · ${total}` : ""}
              </button>
            </nav>
            {pane === "friends" ? (
              <>
                <input
                  type="search"
                  aria-label="학생 검색"
                  placeholder="이름 · 학교 · 동아리 검색"
                  className="my-3 min-h-10 shrink-0 rounded-lg border border-control px-3 text-sm placeholder:text-muted"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {loadError && (
                  <p role="alert" className="mb-2 text-sm text-danger">
                    학생 목록을 불러오지 못했어요.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setAttempt(attempt + 1)}
                    >
                      다시 시도
                    </button>
                  </p>
                )}
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-sm:grid-cols-1">
                  <div
                    className={cx(
                      "scroll-thin overflow-y-auto",
                      profile && "max-sm:hidden",
                    )}
                    aria-label="학생 목록"
                  >
                    {hits.length ? (
                      hits.map((s) => (
                        <div
                          key={s.id}
                          className={cx(
                            "flex items-center border-b border-line-soft",
                            selected === s.id && "bg-selected",
                          )}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-hover"
                            onClick={() => {
                              setSelected(s.id);
                              setProfile(true);
                            }}
                            aria-pressed={selected === s.id}
                          >
                            <Avatar student={s} />
                            <span className="min-w-0">
                              <strong className="block text-sm">
                                {s.short}
                              </strong>
                              <small className="block truncate text-xs text-muted">
                                {s.school} · {s.club || s.status}
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={iconButton}
                            aria-label={`${s.short} 즐겨찾기`}
                            aria-pressed={favorites.includes(s.id)}
                            onClick={() =>
                              setFavorites((current) =>
                                current.includes(s.id)
                                  ? current.filter((id) => id !== s.id)
                                  : [...current, s.id],
                              )
                            }
                          >
                            <Icon
                              name="bookmark"
                              filled={favorites.includes(s.id)}
                            />
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="p-5 text-sm text-muted">
                        검색 결과가 없어요.
                      </p>
                    )}
                  </div>
                  <aside
                    className={cx(
                      "scroll-thin overflow-y-auto border-l border-line max-sm:border-l-0",
                      !profile && "max-sm:hidden",
                    )}
                    aria-label="선택한 학생 프로필"
                  >
                    <Profile student={student} />
                    <div className="px-5 pb-5">
                      <button
                        type="button"
                        className={primaryButton}
                        onClick={() => openRoom(student.id)}
                      >
                        대화 시작
                      </button>
                      <button
                        type="button"
                        className={cx(quietButton, "mt-2 ml-2 sm:hidden")}
                        onClick={() => setProfile(false)}
                      >
                        목록으로
                      </button>
                    </div>
                  </aside>
                </div>
              </>
            ) : (
              <>
                <div
                  className="flex shrink-0 gap-2 py-3"
                  aria-label="대화 목록 필터"
                >
                  <button
                    type="button"
                    className={onlyUnread ? quietButton : primaryButton}
                    aria-pressed={!onlyUnread}
                    onClick={() => setOnlyUnread(false)}
                  >
                    전체
                  </button>
                  <button
                    type="button"
                    className={onlyUnread ? primaryButton : quietButton}
                    aria-pressed={onlyUnread}
                    onClick={() => setOnlyUnread(true)}
                  >
                    읽지 않음{total > 0 ? ` · ${total}` : ""}
                  </button>
                </div>
                <div className="min-h-0 flex-1 scroll-thin overflow-y-auto">
                  {chatIds.length ? (
                    chatIds.map((id) => {
                      const s = students.find((s) => s.id === id) ?? {
                        ...ARONA,
                        id,
                        short: id,
                      };
                      const last = rooms[id]!.at(-1)!;
                      return (
                        <button
                          key={id}
                          type="button"
                          className="flex w-full items-center gap-3 border-b border-line-soft py-3 text-left hover:bg-hover"
                          onClick={() => openRoom(id)}
                        >
                          <Avatar student={s} />
                          <span className="min-w-0 flex-1">
                            <strong className="block text-sm">{s.short}</strong>
                            <span className="block truncate text-xs text-muted">
                              {last.text}
                            </span>
                          </span>
                          <span className="text-xs text-muted">
                            {last.time}
                            {!!unread[id] && (
                              <span className="ml-2 rounded-full bg-blue px-2 text-white">
                                {unread[id]}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="py-8 text-center text-sm text-muted">
                      {onlyUnread
                        ? "읽지 않은 대화가 없어요."
                        : "친구 탭에서 학생을 골라 대화를 시작해 보세요."}
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
