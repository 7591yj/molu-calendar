import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { makeServer } from './server.js';
import { walkFrame, modelResource } from './character.js';
import {
  CATEGORIES, STATUSES, MAX_BYTES, validDate, dateKey, addDays, shiftMonth, monthDays,
  span, overlaps, clockLabel, timeLabel, parseBundle, validateBundle, mergeEvents, featuredEvents, demoBundle,
} from './calendar.js';

const timed = { id: 'test-1', title: '점검', category: 'maintenance', all_day: false, start: '2026-09-29T11:00:00+09:00', end: '2026-09-29T14:00:00+09:00' };
const bundle = events => ({ schema_version: 1, events });

test('날짜 유효성과 월 경계·윤년', () => {
  assert.ok(validDate('2024-02-29'));
  assert.ok(!validDate('2025-02-29'));
  assert.ok(!validDate('2026-04-31'));
  assert.ok(!validDate('2026-2-01'));
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  const days = monthDays('2026-09');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2026-08-30');
  assert.equal(days[41], '2026-10-10');
});

test('한국 시간 변환과 배타적 종료', () => {
  assert.equal(dateKey('2026-09-29T16:00:00Z'), '2026-09-30');
  const event = { ...timed, start: '2026-09-29T14:00:00Z', end: '2026-09-29T15:00:00Z' };
  assert.deepEqual(span(event), { first: '2026-09-29', last: '2026-09-29' });
  assert.ok(!overlaps(event, '2026-09-30', '2026-10-01'));
  const allDay = { ...timed, all_day: true, start: '2026-09-29', end: '2026-10-02' };
  assert.deepEqual(span(allDay), { first: '2026-09-29', last: '2026-10-01' });
  assert.ok(overlaps(allDay, '2026-10-01', '2026-11-01'));
  assert.ok(!overlaps(allDay, '2026-10-02', '2026-10-03'));
});

test('종료 없는 일정은 시작일에만 표시한다', () => {
  const { end, ...event } = timed;
  assert.deepEqual(span(event), { first: '2026-09-29', last: '2026-09-29' });
  assert.ok(!overlaps(event, '2026-09-30', '2026-10-01'));
  assert.deepEqual(span({ ...event, all_day: true, start: '2026-09-29' }), { first: '2026-09-29', last: '2026-09-29' });
});

test('날짜 칸의 시각은 단일일 범위와 여러 날의 시작·진행·종료를 구분한다', () => {
  assert.equal(timeLabel(timed, '2026-09-29'), '11:00–14:00');
  assert.equal(clockLabel('2026-09-29T02:00:00Z'), '11:00');
  const long = { ...timed, start: '2026-09-28T15:00:00+09:00', end: '2026-10-01T11:00:00+09:00' };
  assert.equal(timeLabel(long, '2026-09-28'), '15:00 시작');
  assert.equal(timeLabel(long, '2026-09-29'), '진행 중');
  assert.equal(timeLabel(long, '2026-10-01'), '11:00 종료');
  assert.equal(timeLabel(long, '2026-10-02'), '');
  assert.equal(timeLabel({ ...long, status: 'cancelled' }, '2026-09-29'), '취소');
  assert.equal(timeLabel({ ...long, status: 'postponed' }, '2026-09-29'), '연기');
});

test('시간 라벨은 자정·종일·종료 미정을 혼동하지 않는다', () => {
  const midnight = { ...timed, start: '2026-09-29T23:00:00+09:00', end: '2026-09-30T00:00:00+09:00' };
  assert.equal(timeLabel(midnight, '2026-09-29'), '23:00–24:00');
  assert.equal(timeLabel(midnight, '2026-09-30'), '');
  assert.equal(timeLabel({ ...midnight, start: '2026-09-28T23:00:00+09:00' }, '2026-09-29'), '24:00 종료');
  assert.equal(timeLabel({ ...timed, end: undefined }), '11:00 · 종료 미정');
  assert.equal(timeLabel({ ...timed, all_day: true, start: '2026-09-29', end: '2026-10-01' }, '2026-09-30'), '종일');
});

test('JSON 계약 검증과 기본값 정규화', () => {
  const data = parseBundle(JSON.stringify(bundle([timed])));
  assert.equal(data.events[0].status, 'confirmed');
  assert.equal(validateBundle(bundle([{ ...timed, title: ' 점검 ' }])).events[0].title, '점검');
  assert.doesNotThrow(() => validateBundle(bundle([{ ...timed, end: null }])));
  assert.throws(() => parseBundle('{invalid'), /JSON 문법/);
  assert.throws(() => validateBundle({ schema_version: 2, events: [] }), /schema_version/);
  assert.throws(() => validateBundle(bundle([timed, timed])), /중복/);
  assert.throws(() => validateBundle(bundle([{ ...timed, status: 'something' }])), /status/);
  assert.throws(() => validateBundle(bundle([{ ...timed, category: '__proto__' }])), /category/);
  assert.throws(() => validateBundle(bundle([{ ...timed, start_date: '2026-09-29' }])), /지원하지 않는 필드/);
});

test('잘못된 날짜·오프셋·종일 형식·기간을 거부한다', () => {
  for (const start of ['2026-09-29T11:00:00', '2026-02-30T11:00:00+09:00', '2026-09-29T24:00:00+09:00', '2026-09-29T12:60:00Z', '2026-09-29T12:00:00+15:00', '점검 후']) {
    assert.throws(() => validateBundle(bundle([{ ...timed, start }])), /start/);
  }
  assert.throws(() => validateBundle(bundle([{ ...timed, end: timed.start }])), /뒤/);
  assert.throws(() => validateBundle(bundle([{ ...timed, all_day: true }])), /YYYY-MM-DD/);
  assert.throws(() => validateBundle(bundle([{ ...timed, all_day: true, start: '2026-09-29', end: '2026-09-29' }])), /뒤/);
});

test('링크 안전성·크기 제한', () => {
  for (const source_url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com', 'invalid', 42]) {
    assert.throws(() => validateBundle(bundle([{ ...timed, source_url }])), /source_url/);
  }
  assert.doesNotThrow(() => validateBundle(bundle([{ ...timed, source_url: 'https://forum.nexon.com/bluearchive/' }])));
  assert.throws(() => parseBundle(' '.repeat(MAX_BYTES + 1)), /1MB/);
  assert.throws(() => validateBundle(bundle(Array(1001).fill(timed))), /최대/);
});

test('id 기반 갱신·추가와 원본 불변, 실패 시 부분 반영 없음', () => {
  const original = validateBundle(bundle([timed])).events;
  const update = { ...original[0], title: '점검 시간 변경', status: 'cancelled' };
  const next = { ...original[0], id: 'test-2' };
  const merged = mergeEvents(original, [update, next]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(event => event.id === timed.id).title, '점검 시간 변경');
  assert.equal(original[0].title, '점검');
  assert.throws(() => mergeEvents(original, parseBundle(JSON.stringify(bundle([next, { ...timed, start: '미정' }]))).events));
  assert.equal(original.length, 1);
});

test('서로 다른 UTC 오프셋도 실제 시작 순서로 정렬한다', () => {
  const early = { ...timed, id: 'early', start: '2026-09-29T11:00:00+09:00', end: undefined };
  const late = { ...timed, id: 'late', start: '2026-09-29T03:00:00Z', end: undefined };
  assert.deepEqual(mergeEvents([], [late, early]).map(event => event.id), ['early', 'late']);
});

test('제공 샘플과 JSON Schema의 분류·상태 계약 일치', async () => {
  const example = JSON.parse(await readFile(new URL('./example.json', import.meta.url), 'utf8'));
  assert.equal(validateBundle(example).events.length, 2);
  for (const date of ['2026-02-01', '2026-09-26', '2024-12-31']) assert.equal(validateBundle(demoBundle(date)).events.length, 8);
  const schema = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  const fields = schema.properties.events.items.properties;
  assert.deepEqual(fields.category.enum, Object.keys(CATEGORIES));
  assert.deepEqual(fields.status.enum, Object.keys(STATUSES));
});

test('순환 카드는 종료·취소·점검을 제외하고 현재/예정 이벤트를 시작 순서로 보여 준다', () => {
  const now = '2026-09-29T12:00:00+09:00';
  const active = { ...timed, id: 'active', category: 'event' };
  const future = { ...timed, id: 'future', category: 'pickup', start: '2026-09-30T11:00:00+09:00', end: '2026-10-01T11:00:00+09:00' };
  const allDay = { ...timed, id: 'all-day', category: 'campaign', all_day: true, start: '2026-09-29', end: '2026-09-30' };
  const ignored = [
    timed,
    { ...active, id: 'ended', end: now },
    { ...active, id: 'cancelled', status: 'cancelled' },
    { ...future, id: 'postponed', status: 'postponed' },
    { ...active, id: 'unknown-end-in-past', end: undefined },
    { ...allDay, id: 'yesterday', start: '2026-09-28', end: '2026-09-29' },
  ];
  const input = [future, ...ignored, active, allDay];
  assert.deepEqual(featuredEvents(input, now).map(event => event.id), ['all-day', 'active', 'future']);
  assert.equal(input[0].id, 'future');
  assert.deepEqual(featuredEvents([], now), []);
});

test('구라 테스트 이동은 양 끝에서 멈추고 반대로 돌아오며 범위를 벗어나지 않는다', () => {
  assert.deepEqual(walkFrame(0), { position: -1, direction: 1, walking: true });
  assert.deepEqual(walkFrame(18), { position: 1, direction: 1, walking: false });
  assert.deepEqual(walkFrame(20), { position: 1, direction: -1, walking: true });
  assert.deepEqual(walkFrame(38), { position: -1, direction: -1, walking: false });
  assert.deepEqual(walkFrame(40), walkFrame(0));
  for (let time = 0; time < 100; time += .25) assert.ok(Math.abs(walkFrame(time, 7).position) <= 1);
  assert.throws(() => walkFrame(-1), RangeError);
  assert.throws(() => walkFrame(1, 0), RangeError);
});

test('모델 리소스는 지정한 로컬 PMX·PNG만 허용한다', () => {
  const origin = 'http://localhost:5173';
  assert.equal(modelResource('/models/gura/body.png', origin), `${origin}/models/gura/body.png`);
  for (const url of ['https://example.com/body.png', '/package.json', '/models/gura/../face.png', '/models/gura/unknown.pmx', 'data:image/svg+xml,test', 'http://user:pass@localhost:5173/models/gura/body.png']) assert.throws(() => modelResource(url, origin));
  assert.equal(modelResource('data:image/png;base64,abc', origin), 'data:image/png;base64,abc');
});

test('서버는 페이지·자산만 제공하고 쓰기·비공개 파일을 차단한다', async t => {
  const server = makeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/styles.css', '/app.js', '/calendar.js', '/schema.json', '/example.json']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  for (const path of ['/character.bundle.js', '/character.bundle.js.LEGAL.txt', '/models/gura/GawrGura.pmx', '/models/gura/body.png']) {
    const response = await fetch(base + path, { method: 'HEAD' });
    assert.equal(response.status, 200, path);
    assert.ok(Number(response.headers.get('content-length')) > 0);
  }
  assert.equal((await fetch(`${base}/GawrGura.zip`)).status, 404);
  assert.equal((await fetch(`${base}/models/gura/../../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/node_modules/three/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
});
