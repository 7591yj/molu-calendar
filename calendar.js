export const TIME_ZONE = 'Asia/Seoul';
export const CATEGORIES = {
  maintenance: { label: '점검·업데이트', color: '#687795' },
  pickup: { label: '픽업 모집', color: '#825bd5' },
  event: { label: '이벤트', color: '#008fb6' },
  campaign: { label: '캠페인', color: '#19896b' },
};
export const STATUSES = { confirmed: '확정', tentative: '예정', postponed: '연기', cancelled: '취소' };
export const MAX_BYTES = 1024 * 1024;
export const MAX_EVENTS = 1000;
const remap = category => ({ update: 'maintenance', other: 'event' })[category] ?? category;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const clockFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
});

export function dateKey(value = new Date()) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(+time) && time.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2199-12-31';
}

function validInstant(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !validDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return false;
  if (match[6] !== 'Z') {
    const [hours, minutes] = match[6].slice(1).split(':').map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value)) && validDate(dateKey(value));
}

export function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(month, count) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

export function monthDays(month, weeks = 6) {
  const first = `${month}-01`;
  const start = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
}

// Display cap: at most 5 rows, and only if the 5th week touches the current month.
export function displayDays(month) {
  const five = monthDays(month, 5);
  return five.some(day => day.startsWith(month)) ? five : monthDays(month, 4);
}

export function span(event) {
  if (event.all_day) return { first: event.start, last: event.end ? addDays(event.end, -1) : event.start };
  return { first: dateKey(event.start), last: event.end ? dateKey(Date.parse(event.end) - 1) : dateKey(event.start) };
}

export function overlaps(event, from, to) {
  const { first, last } = span(event);
  return first < to && last >= from;
}

export function clockLabel(value) {
  return clockFormatter.format(new Date(value));
}

export function timeLabel(event, day) {
  const { first, last } = span(event);
  day ??= first;
  if (day < first || day > last) return '';
  if (event.status === 'cancelled') return '취소';
  if (event.status === 'postponed') return '연기';
  if (event.all_day) return '종일';
  const start = clockLabel(event.start);
  if (!event.end) return `${start} · 종료 미정`;
  // An exclusive midnight belongs to the previous displayed day: show 24:00, not 00:00.
  const end = dateKey(event.end) > last ? '24:00' : clockLabel(event.end);
  if (first === last) return `${start}–${end}`;
  if (day === first) return `${start} 시작`;
  if (day === last) return `${end} 종료`;
  return '진행 중';
}

export function rangeLabel(event) {
  if (event.all_day) {
    const { first, last } = span(event);
    return first === last ? `${first} · 종일` : `${first} — ${last} · 종일`;
  }
  const format = value => `${dateKey(value)} ${clockLabel(value)}`;
  return event.end ? `${format(event.start)} — ${format(event.end)}` : `${format(event.start)} · 종료 미정`;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateBundle(input) {
  if (!object(input) || input.schema_version !== 1 || !Array.isArray(input.events)) {
    throw new Error('최상위에 schema_version: 1과 events 배열이 필요합니다.');
  }
  if (Object.keys(input).some(key => !['schema_version', 'events'].includes(key))) {
    throw new Error('최상위 필드는 schema_version, events만 사용할 수 있습니다.');
  }
  if (input.events.length > MAX_EVENTS) throw new Error(`일정은 최대 ${MAX_EVENTS}개까지 저장할 수 있습니다.`);
  const ids = new Set();
  const events = input.events.map((item, index) => {
    const fail = message => { throw new Error(`${index + 1}번째 일정: ${message}`); };
    if (!object(item)) fail('객체 형식이어야 합니다.');
    const allowed = ['id', 'title', 'category', 'all_day', 'start', 'end', 'status', 'description', 'source_url'];
    const unknown = Object.keys(item).find(key => !allowed.includes(key));
    if (unknown) fail(`지원하지 않는 필드 '${unknown}'입니다. 형식 안내를 확인해 주세요.`);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(item.id)) fail('id는 영문·숫자·._:- 조합의 1~120자여야 합니다.');
    if (ids.has(item.id)) fail(`id '${item.id}'가 파일 안에서 중복됩니다.`);
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160) fail('title은 비어 있지 않은 160자 이내 문자열이어야 합니다.');
    if (!Object.hasOwn(CATEGORIES, remap(item.category))) fail(`category는 ${Object.keys(CATEGORIES).join(', ')} 중 하나여야 합니다. 'update'는 'maintenance', 'other'는 'event'에 합쳐졌습니다.`);
    if (typeof item.all_day !== 'boolean') fail('all_day에 true 또는 false가 필요합니다.');
    const check = item.all_day ? validDate : validInstant;
    const format = item.all_day ? 'YYYY-MM-DD 날짜' : '시간대가 포함된 ISO 시각(예: 2026-09-29T11:00:00+09:00)';
    if (!check(item.start)) fail(`start는 실제 존재하는 ${format}여야 합니다. 지원 연도: 1900~2199.`);
    if (item.end !== undefined && item.end !== null && !check(item.end)) fail(`end는 ${format}여야 합니다.`);
    if (item.end && (item.all_day ? item.end <= item.start : Date.parse(item.end) <= Date.parse(item.start))) fail('end는 start보다 뒤여야 합니다. 종료는 미포함입니다.');
    if (item.status !== undefined && !Object.hasOwn(STATUSES, item.status)) fail('status는 confirmed, tentative, postponed, cancelled 중 하나여야 합니다.');
    if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 4000)) fail('description은 4,000자 이내 문자열이어야 합니다.');
    if (item.source_url !== undefined) {
      let url;
      try { url = new URL(item.source_url); } catch { fail('source_url은 유효한 http(s) URL이어야 합니다.'); }
      if (typeof item.source_url !== 'string' || item.source_url.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('source_url은 인증 정보 없는 http(s) URL이어야 합니다.');
    }
    return {
      id: item.id, title: item.title.trim(), category: remap(item.category),
      all_day: item.all_day, start: item.start,
      ...(item.end ? { end: item.end } : {}),
      status: item.status ?? 'confirmed',
      ...(item.description ? { description: item.description } : {}),
      ...(item.source_url ? { source_url: item.source_url } : {}),
    };
  });
  return { schema_version: 1, events };
}

export function parseBundle(text) {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('JSON은 1MB 이하여야 합니다.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('JSON 문법 오류입니다. 따옴표·쉼표·괄호를 확인해 주세요.'); }
  return validateBundle(data);
}

export function compareEvents(a, b) {
  const startTime = event => Date.parse(event.all_day ? `${event.start}T00:00:00+09:00` : event.start);
  return startTime(a) - startTime(b) || a.id.localeCompare(b.id);
}

export function featuredEvents(events, now = new Date()) {
  const day = dateKey(now);
  const timestamp = +new Date(now);
  return events.filter(event => {
    if (!['event', 'pickup', 'campaign'].includes(event.category) || ['cancelled', 'postponed'].includes(event.status)) return false;
    if (event.all_day) return span(event).last >= day;
    return event.end ? Date.parse(event.end) > timestamp : Date.parse(event.start) >= timestamp;
  }).sort(compareEvents);
}

export function mergeEvents(existing, incoming) {
  const merged = new Map(existing.map(event => [event.id, event]));
  incoming.forEach(event => merged.set(event.id, event));
  if (merged.size > MAX_EVENTS) throw new Error(`저장 가능한 전체 일정은 최대 ${MAX_EVENTS}개입니다.`);
  return [...merged.values()].sort(compareEvents);
}

export function demoBundle(today = dateKey()) {
  const month = today.slice(0, 7);
  const day = number => `${month}-${String(number).padStart(2, '0')}`;
  const sample = (id, title, category, start, end, all_day = false) => ({
    id: `demo-${id}`, title, category, all_day, start, end, status: 'confirmed',
    description: '화면 체험을 위한 가상 일정입니다. 실제 블루 아카이브 운영 일정이 아닙니다.',
  });
  return { schema_version: 1, events: [
    sample('maintenance', '정기 업데이트 점검', 'maintenance', `${day(8)}T11:00:00+09:00`, `${day(8)}T15:00:00+09:00`),
    sample('pickup', '밀레니엄 픽업 모집', 'pickup', `${day(8)}T15:00:00+09:00`, `${day(22)}T11:00:00+09:00`),
    sample('story', '새로운 메인 스토리 공개', 'maintenance', `${day(8)}T15:00:00+09:00`, `${day(8)}T16:00:00+09:00`),
    sample('event', '게임개발부의 특별한 하루', 'event', day(12), day(20), true),
    sample('campaign', '임무 보상 2배 캠페인', 'campaign', `${day(15)}T04:00:00+09:00`, `${day(18)}T04:00:00+09:00`),
    sample('mission', '샬레 특별 미션', 'event', day(22), day(28), true),
    sample('maintenance-next', '정기점검 예정', 'maintenance', `${day(22)}T11:00:00+09:00`, `${day(22)}T14:00:00+09:00`),
    sample('weekend', '계정 경험치 2배', 'campaign', day(26), day(28), true),
  ] };
}
