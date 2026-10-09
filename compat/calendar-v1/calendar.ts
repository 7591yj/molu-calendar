import { raidImages } from "./raid-banners.ts";

import type { CalendarEvent, CalendarBundle, LaneSegment } from "./types.ts";
export const TIME_ZONE = "Asia/Seoul";
export const CATEGORIES = {
  maintenance: { label: "점검·업데이트", color: "#687795" },
  pickup: { label: "픽업 모집", color: "#825bd5" },
  event: { label: "이벤트", color: "#008fb6" },
  campaign: { label: "캠페인", color: "#19896b" },
};
export const STATUSES = {
  confirmed: "확정",
  tentative: "예정",
  postponed: "연기",
  cancelled: "취소",
};
// 서버: 일본은 선행 일정, 한국·글로벌은 후행 일정(같은 트랙)이다.
export const SERVERS = {
  jp: { label: "일본", short: "JP" },
  gl: { label: "한국·글로벌", short: "KR·GL" },
};
export function eventServers(event: CalendarEvent) {
  const servers = Array.isArray(event.servers)
    ? event.servers.filter((server) => Object.hasOwn(SERVERS, server))
    : [];
  return servers.length ? servers : Object.keys(SERVERS);
}
// 서버 필터와 별개로 배너는 언어 설정을 따른다.
export const LANGS = { kr: "한국어", jp: "日本語", en: "English", zh: "中文" };
export const FALLBACK_LANG = "jp";
export function countryLanguage(country: unknown, fallback = "kr") {
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))
    return fallback;
  return (
    (
      { KR: "kr", JP: "jp", CN: "zh", TW: "zh", HK: "zh", MO: "zh" } as Record<
        string,
        string
      >
    )[country] ?? "en"
  );
}
export function eventImageCandidates(event: CalendarEvent, lang: string) {
  const images = {
    ...(object(event?.images) ? event.images : {}),
    ...raidImages(event),
  };
  return [
    ...new Set(
      [images[lang], images[FALLBACK_LANG], ...Object.values(images)].filter(
        (file) => typeof file === "string",
      ),
    ),
  ];
}
export function eventImage(event: CalendarEvent, lang: string) {
  return eventImageCandidates(event, lang)[0] ?? null;
}
export const MAX_BYTES = 1024 * 1024;
export const MAX_EVENTS = 1000;
const remap = (category: string) =>
  (({ update: "maintenance", other: "event" }) as Record<string, string>)[
    category
  ] ?? category;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clockFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function dateKey(value: string | number | Date = new Date()) {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(+time) &&
    time.toISOString().slice(0, 10) === value &&
    value >= "1900-01-01" &&
    value <= "2199-12-31"
  );
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (
    !match ||
    !validDate(match[1]) ||
    +match[2]! > 23 ||
    +match[3]! > 59 ||
    +(match[4] || 0) > 59
  )
    return false;
  if (match[6]! !== "Z") {
    const [hours = 0, minutes = 0] = match[6]!.slice(1).split(":").map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      return false;
  }
  return Number.isFinite(Date.parse(value)) && validDate(dateKey(value));
}

export function addDays(day: string, count: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, count: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

export function monthDays(month: string, weeks = 6) {
  const first = `${month}-01`;
  const start = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
}

// Display cap: at most 5 rows, and only if the 5th week touches the current month.
export function displayDays(month: string) {
  const five = monthDays(month, 5);
  return five.some((day) => day.startsWith(month)) ? five : monthDays(month, 4);
}

export function span(event: CalendarEvent) {
  if (event.all_day)
    return {
      first: event.start,
      last: event.end ? addDays(event.end, -1) : event.start,
    };
  return {
    first: dateKey(event.start),
    last: event.end ? dateKey(Date.parse(event.end) - 1) : dateKey(event.start),
  };
}

export function overlaps(event: CalendarEvent, from: string, to: string) {
  const { first, last } = span(event);
  return first < to && last >= from;
}

// Split visible day indices into week-row segments: a spanning bar cannot cross row boundaries.
export function segments(indices: number[]) {
  return indices.reduce((runs, index) => {
    const last = runs[runs.length - 1];
    if (
      last &&
      index === last[last.length - 1]! + 1 &&
      Math.floor(index / 7) === Math.floor(last[last.length - 1]! / 7)
    )
      last.push(index);
    else runs.push([index]);
    return runs;
  }, [] as number[][]);
}

// Clock time as a fraction of one day cell width (11:00 → 11/24).
export function timeFrac(clock: string) {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  return hours / 24 + (minutes ?? 0) / 1440;
}

// Greedy lane assignment. Bars may share a lane when the previous one's fractional
// end position is at or before the next one's fractional start position on the same day.
export function assignLanes(segs: LaneSegment[]) {
  segs.sort((x, y) => x.startPos - y.startPos || x.endPos - y.endPos);
  const laneEnds: number[] = [];
  for (const seg of segs) {
    let lane = laneEnds.findIndex((end) => end <= seg.startPos);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = seg.endPos;
    seg.lane = lane;
  }
  return laneEnds.length;
}

export function clockLabel(value: string | number | Date) {
  return clockFormatter.format(new Date(value));
}

export function timeLabel(event: CalendarEvent, day?: string) {
  const { first, last } = span(event);
  day ??= first;
  if (day < first || day > last) return "";
  if (event.status === "cancelled") return "취소";
  if (event.status === "postponed") return "연기";
  if (event.all_day) return "종일";
  const start = clockLabel(event.start);
  if (!event.end) return `${start} · 종료 미정`;
  // An exclusive midnight belongs to the previous displayed day: show 24:00, not 00:00.
  const end = dateKey(event.end) > last ? "24:00" : clockLabel(event.end);
  if (first === last) return `${start}–${end}`;
  if (day === first) return `${start} 시작`;
  if (day === last) return `${end} 종료`;
  return "진행 중";
}

export function rangeLabel(event: CalendarEvent) {
  if (event.all_day) {
    const { first, last } = span(event);
    return first === last ? `${first} · 종일` : `${first} — ${last} · 종일`;
  }
  const format = (value: string) => `${dateKey(value)} ${clockLabel(value)}`;
  return event.end
    ? `${format(event.start)} — ${format(event.end)}`
    : `${format(event.start)} · 종료 미정`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateBundle(input: unknown): CalendarBundle {
  if (
    !object(input) ||
    input.schema_version !== 1 ||
    !Array.isArray(input.events)
  ) {
    throw new Error("최상위에 schema_version: 1과 events 배열이 필요합니다.");
  }
  if (
    Object.keys(input).some(
      (key) => !["schema_version", "events"].includes(key),
    )
  ) {
    throw new Error(
      "최상위 필드는 schema_version, events만 사용할 수 있습니다.",
    );
  }
  if (input.events.length > MAX_EVENTS)
    throw new Error(`일정은 최대 ${MAX_EVENTS}개까지 저장할 수 있습니다.`);
  const ids = new Set<string>();
  const events = input.events.map((candidate: unknown, index) => {
    const item = candidate as CalendarEvent;
    return validateEvent(item, index, ids);
  });
  return { schema_version: 1, events };
}

function validateEvent(
  item: CalendarEvent,
  index: number,
  ids: Set<string>,
): CalendarEvent {
  const fail = (message: string): never => {
    throw new Error(`${index + 1}번째 일정: ${message}`);
  };
  if (!object(item)) fail("객체 형식이어야 합니다.");
  const allowed = [
    "id",
    "title",
    "category",
    "all_day",
    "start",
    "end",
    "status",
    "description",
    "source_url",
    "images",
    "servers",
  ];
  const unknown = Object.keys(item).find((key) => !allowed.includes(key));
  if (unknown)
    fail(`지원하지 않는 필드 '${unknown}'입니다. 형식 안내를 확인해 주세요.`);
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(item.id))
    fail("id는 영문·숫자·._:- 조합의 1~120자여야 합니다.");
  if (ids.has(item.id)) fail(`id '${item.id}'가 파일 안에서 중복됩니다.`);
  ids.add(item.id);
  if (
    item.servers !== undefined &&
    (!Array.isArray(item.servers) ||
      !item.servers.length ||
      new Set(item.servers).size !== item.servers.length ||
      item.servers.some((server) => !Object.hasOwn(SERVERS, server)))
  )
    fail("servers는 jp, gl 중 1개 이상이어야 합니다.");
  if (
    typeof item.title !== "string" ||
    !item.title.trim() ||
    item.title.length > 160
  )
    fail("title은 비어 있지 않은 160자 이내 문자열이어야 합니다.");
  if (item.images !== undefined) {
    if (!object(item.images) || !Object.keys(item.images).length)
      fail("images는 비어 있지 않은 언어별 배너 파일명 객체여야 합니다.");
    for (const [lang, file] of Object.entries(item.images)) {
      if (!Object.hasOwn(LANGS, lang))
        fail(
          `images의 언어 키는 ${Object.keys(LANGS).join(", ")} 중 하나여야 합니다.`,
        );
      if (
        typeof file !== "string" ||
        !/^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/.test(file)
      )
        fail(
          "images의 값은 resource/event_banner_img/ 안의 파일명이어야 합니다.",
        );
    }
  }
  if (!Object.hasOwn(CATEGORIES, remap(item.category)))
    fail(
      `category는 ${Object.keys(CATEGORIES).join(", ")} 중 하나여야 합니다. 'update'는 'maintenance', 'other'는 'event'에 합쳐졌습니다.`,
    );
  if (typeof item.all_day !== "boolean")
    fail("all_day에 true 또는 false가 필요합니다.");
  const check = item.all_day ? validDate : validInstant;
  const format = item.all_day
    ? "YYYY-MM-DD 날짜"
    : "시간대가 포함된 ISO 시각(예: 2026-09-29T11:00:00+09:00)";
  if (!check(item.start))
    fail(`start는 실제 존재하는 ${format}여야 합니다. 지원 연도: 1900~2199.`);
  if (item.end !== undefined && item.end !== null && !check(item.end))
    fail(`end는 ${format}여야 합니다.`);
  if (
    item.end &&
    (item.all_day
      ? item.end <= item.start
      : Date.parse(item.end) <= Date.parse(item.start))
  )
    fail("end는 start보다 뒤여야 합니다. 종료는 미포함입니다.");
  if (item.status !== undefined && !Object.hasOwn(STATUSES, item.status))
    fail(
      "status는 confirmed, tentative, postponed, cancelled 중 하나여야 합니다.",
    );
  if (
    item.description !== undefined &&
    (typeof item.description !== "string" || item.description.length > 4000)
  )
    fail("description은 4,000자 이내 문자열이어야 합니다.");
  if (item.source_url !== undefined) {
    let url: URL;
    try {
      url = new URL(item.source_url);
    } catch {
      return fail("source_url은 유효한 http(s) URL이어야 합니다.");
    }
    if (
      typeof item.source_url !== "string" ||
      item.source_url.length > 2048 ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail("source_url은 인증 정보 없는 http(s) URL이어야 합니다.");
  }
  return {
    id: item.id,
    title: item.title.trim(),
    category: remap(item.category),
    all_day: item.all_day,
    start: item.start,
    ...(item.end ? { end: item.end } : {}),
    status: item.status ?? "confirmed",
    ...(item.description ? { description: item.description } : {}),
    ...(item.source_url ? { source_url: item.source_url } : {}),
    ...(item.images ? { images: item.images } : {}),
    servers: item.servers ?? Object.keys(SERVERS),
  };
}

export function parseBundle(text: string) {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error("JSON은 1MB 이하여야 합니다.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON 문법 오류입니다. 따옴표·쉼표·괄호를 확인해 주세요.");
  }
  return validateBundle(data);
}

export function compareEvents(a: CalendarEvent, b: CalendarEvent) {
  const startTime = (event: CalendarEvent) =>
    Date.parse(event.all_day ? `${event.start}T00:00:00+09:00` : event.start);
  return startTime(a) - startTime(b) || a.id.localeCompare(b.id);
}

export function featuredEvents(events: CalendarEvent[], now = new Date()) {
  const day = dateKey(now);
  const timestamp = +new Date(now);
  return events
    .filter((event) => {
      if (
        !["event", "pickup", "campaign"].includes(event.category) ||
        ["cancelled", "postponed"].includes(event.status)
      )
        return false;
      if (event.all_day) return span(event).last >= day;
      return event.end
        ? Date.parse(event.end) > timestamp
        : Date.parse(event.start) >= timestamp;
    })
    .sort(compareEvents);
}

// 배너 후보: 진행·예정 이벤트가 없으면 끝난 일정으로라도 채운다 (빈 배너 방지).
export function bannerEvents(events: CalendarEvent[], now = new Date()) {
  const current = featuredEvents(events, now);
  return current.length
    ? current
    : events
        .filter((event) => !["cancelled", "postponed"].includes(event.status))
        .sort(compareEvents);
}

// 이벤트 남은 시간 칩: '종료까지 Day -1' / '종료까지 14:30' / '시작까지 Day -2' / '종료'. 종료 미정이면 null.
function countdown(ms: number) {
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `Day -${days}`;
  const minutes = Math.floor(ms / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function remainingLabel(event: CalendarEvent, now = new Date()) {
  const timestamp = Number(now);
  const startMoment = event.all_day
    ? Date.parse(`${event.start}T00:00:00+09:00`)
    : Date.parse(event.start);
  const endMoment = event.all_day
    ? Date.parse(`${span(event).last}T00:00:00+09:00`) + 86400000 // 종일은 마지막 날 24:00(KST)까지
    : event.end
      ? Date.parse(event.end)
      : null;
  if (endMoment !== null && timestamp >= endMoment) return "종료";
  if (timestamp < startMoment)
    return `시작까지 ${countdown(startMoment - timestamp)}`;
  if (endMoment === null) return null;
  return `종료까지 ${countdown(endMoment - timestamp)}`;
}

export function mergeEvents(
  existing: CalendarEvent[],
  incoming: CalendarEvent[],
) {
  const merged = new Map(existing.map((event) => [event.id, event]));
  incoming.forEach((event) => merged.set(event.id, event));
  if (merged.size > MAX_EVENTS)
    throw new Error(`저장 가능한 전체 일정은 최대 ${MAX_EVENTS}개입니다.`);
  return [...merged.values()].sort(compareEvents);
}
