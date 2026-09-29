import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { makeServer, files as servedFiles } from './server.js';
import { walkFrame, modelResource } from './character.js';
import {
  CATEGORIES, STATUSES, MAX_BYTES, validDate, dateKey, addDays, shiftMonth, monthDays,
  span, overlaps, clockLabel, timeLabel, parseBundle, validateBundle, mergeEvents, featuredEvents, bannerEvents, bannerIndex, remainingLabel, demoBundle,
} from './calendar.js';
import { MOMO_QUERIES, MOMO_TOPICS, momoTopicsFor, momoReply } from './momotalk.js';

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
  for (const date of ['2026-02-01', '2026-09-26', '2024-12-31']) assert.equal(validateBundle(demoBundle(date)).events.length, 11);
  const october = validateBundle(demoBundle('2026-09-26')).events.filter(event => event.start.startsWith('2026-10'));
  assert.ok(october.length >= 2, october.map(event => event.start).join(','));
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

test('학생 데이터는 스키마를 지키고 아바타 파일이 실제로 존재한다', async () => {
  const students = JSON.parse(await readFile(new URL('./resource/momotalk/students.json', import.meta.url), 'utf8'));
  assert.ok(students.length > 100, '학생 명단이 비어 있습니다');
  const ids = new Set();
  for (const student of students) {
    assert.ok(student.id && student.name && student.short, `필수 필드 누락: ${JSON.stringify(student)}`);
    assert.ok(!ids.has(student.id), `중복 id: ${student.id}`);
    ids.add(student.id);
    if (!student.img) continue;
    assert.match(student.img, /^[A-Za-z0-9_]+\.(?:webp|png)$/, `아바타 파일명 형식 오류: ${student.img}`);
    await readFile(new URL(`./resource/momotalk/${student.img}`, import.meta.url)); // 파일이 없으면 실패
  }
});

test('서버는 페이지·자산만 제공하고 쓰기·비공개 파일을 차단한다', async t => {
  const server = makeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/styles.css', '/app.js', '/calendar.js', '/momotalk.js', '/schema.json', '/example.json']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  // Model assets are user-supplied and gitignored: skip them when absent.
  const modelPaths = existsSync(new URL('./GawrGura/GawrGura.pmx', import.meta.url)) ? ['/models/gura/GawrGura.pmx', '/models/gura/body.png'] : [];
  for (const path of ['/character.bundle.js', '/character.bundle.js.LEGAL.txt', ...modelPaths]) {
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

test('브라우저 모듈 그래프의 모든 로컬 참조는 서버 화이트리스트에 등록되어 있다', async () => {
  const root = new URL('./', import.meta.url);
  const imported = new Set();
  const seen = new Set(['/app.js']);
  const queue = ['/app.js'];
  while (queue.length) {
    const path = queue.shift();
    const text = await readFile(new URL(`.${path}`, root), 'utf8');
    for (const match of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1] ?? match[2];
      if (!spec.startsWith('.')) continue; // bare specifier(three 등)는 번들이 처리
      const resolved = new URL(spec, `http://localhost${path}`).pathname;
      imported.add(resolved);
      if (resolved.endsWith('.js') && !seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
    }
  }
  const html = await readFile(new URL('./index.html', root), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:|#|mailto:)/.test(match[1])) continue;
    imported.add(new URL(match[1], 'http://localhost/').pathname);
  }
  assert.ok(imported.size > 0);
  for (const path of imported) {
    assert.ok(Object.hasOwn(servedFiles, path), `${path}: import됐지만 server.js 화이트리스트에 없음 — 브라우저 404로 앱 전체가 죽음`);
    assert.ok(existsSync(new URL(`./${servedFiles[path][0]}`, root)), `${path}: 디스크에 파일 없음`);
  }
});

test('모모톡 대화는 선택지·응답 계약을 지키고 알 수 없는 학생은 기본 대화로 떨어진다', () => {
  for (const [id, topics] of Object.entries(MOMO_TOPICS)) {
    assert.ok(topics.length > 0, `${id}: 주제 없음`);
    for (const topic of topics) {
      assert.ok(topic.ask.trim(), `${id}: 질문 없음`);
      assert.ok(topic.options.length >= 2, `${id}: 선택지 부족`);
      for (const option of topic.options) {
        assert.ok(option.text.trim(), `${id}: 선택지 문구 없음`);
        assert.ok(option.reply.trim(), `${id}: 학생 응답 없음`);
        if (option.reply.startsWith('@')) assert.ok(MOMO_QUERIES.includes(option.reply), `${id}: 알 수 없는 일정 조회 ${option.reply}`);
      }
    }
  }
  assert.equal(momoTopicsFor('Arona'), MOMO_TOPICS.Arona);
  assert.equal(momoTopicsFor('CH0167'), MOMO_TOPICS.default);
  assert.equal(momoTopicsFor('__proto__'), MOMO_TOPICS.default);
  assert.equal(momoTopicsFor('constructor'), MOMO_TOPICS.default);
});

test('배너 후보는 진행·예정이 없으면 끝난 일정으로라도 채운다', () => {
  const now = '2026-09-29T12:00:00+09:00';
  const past = { ...timed, id: 'past', category: 'event', start: '2026-09-01T11:00:00+09:00', end: '2026-09-10T11:00:00+09:00' };
  const active = { ...timed, id: 'active', category: 'pickup' };
  assert.deepEqual(bannerEvents([past, active], now).map(event => event.id), ['active']);
  assert.deepEqual(bannerEvents([past], now).map(event => event.id), ['past']);
  const older = { ...past, id: 'older', start: '2026-08-01T11:00:00+09:00', end: '2026-08-20T11:00:00+09:00' };
  assert.deepEqual(bannerEvents([past, older], now).map(event => event.id), ['older', 'past']);
  assert.deepEqual(bannerEvents([{ ...past, status: 'cancelled' }], now), []);
  assert.deepEqual(bannerEvents([{ ...past, status: 'postponed' }], now), []);
  assert.deepEqual(bannerEvents([], now), []);
});

test('배너 인덱스는 id에 결정적이고 범위 안에 머문다', () => {
  assert.equal(bannerIndex('demo-1', 3), bannerIndex('demo-1', 3));
  for (const id of ['demo-1', 'demo-2', 'test-1', '', '한글아이디', 'a'.repeat(120)]) {
    const index = bannerIndex(id, 3);
    assert.ok(Number.isInteger(index) && index >= 0 && index < 3, id);
  }
});

test('남은 시간 칩은 Day -N과 시:분 형식으로 가고 마감이 지나면 종료로 만다', () => {
  const now = Date.parse('2026-09-29T12:00:00+09:00');
  const ongoing = { ...timed, id: 'ongoing', start: '2026-09-29T11:00:00+09:00', end: '2026-10-01T11:00:00+09:00' };
  assert.equal(remainingLabel(ongoing, now), '종료까지 Day -1');
  const hours = { ...timed, id: 'hours', start: '2026-09-29T11:00:00+09:00', end: '2026-09-29T18:00:00+09:00' };
  assert.equal(remainingLabel(hours, now), '종료까지 6:00');
  const minutes = { ...timed, id: 'minutes', start: '2026-09-29T11:00:00+09:00', end: '2026-09-29T14:30:00+09:00' };
  assert.equal(remainingLabel(minutes, now), '종료까지 2:30');
  const future = { ...timed, id: 'future', start: '2026-10-02T11:00:00+09:00', end: '2026-10-03T11:00:00+09:00' };
  assert.equal(remainingLabel(future, now), '시작까지 Day -2');
  assert.equal(remainingLabel({ ...timed, end: '2026-09-29T11:30:00+09:00' }, now), '종료');
  const noEnd = { ...timed, id: 'noend', end: undefined };
  assert.equal(remainingLabel(noEnd, now), null);
  const allDay = { ...timed, id: 'allday', all_day: true, start: '2026-09-29', end: '2026-10-01' };
  assert.equal(remainingLabel(allDay, now), '종료까지 Day -1');
  // 경계: 정확히 48h/24h, 23:59:59, 1분 미만, 종일 시작 전
  assert.equal(remainingLabel({ ...timed, id: 'b48', end: '2026-10-01T12:00:00+09:00' }, now), '종료까지 Day -2');
  assert.equal(remainingLabel({ ...timed, id: 'b24', end: '2026-09-30T12:00:00+09:00' }, now), '종료까지 Day -1');
  assert.equal(remainingLabel({ ...timed, id: 'b2359', end: '2026-09-30T11:59:59+09:00' }, now), '종료까지 23:59');
  assert.equal(remainingLabel({ ...timed, id: 'b0', end: '2026-09-29T12:00:30+09:00' }, now), '종료까지 0:00');
  const futureAllDay = { ...timed, id: 'fall', all_day: true, start: '2026-10-02', end: '2026-10-04' };
  assert.equal(remainingLabel(futureAllDay, now), '시작까지 Day -2');
});

test('모모톡 검색 뇌는 일정 질의를 캘린더로 보내고 학생 목소리를 유지한다', () => {
  const arona = { id: 'Arona', short: '아로나' };
  const hoshino = { id: 'Hoshino', short: '호시노' };
  assert.equal(momoReply('오늘 일정 뭐야', arona), '@today');
  assert.equal(momoReply('오늘일정좀', arona), '@today');
  assert.equal(momoReply('내일 일정 알려줘', hoshino), '@tomorrow');
  assert.equal(momoReply('고마워요 선생님', arona), '헤헤, 선생님께 도움이 되는 게 아로나의 임무니까요!');
  assert.notEqual(momoReply('안녕!', arona), momoReply('안녕!', hoshino));
  assert.ok(momoReply('넌 누구야', { id: 'CH0167', short: '모모이' }).includes('모모이'));
  assert.ok(momoReply('안녕', { id: '__proto__', short: 'x' }).includes('x입니다'));
  assert.ok(!momoReply('ㅁㄴㅇㄹ xyzzy', arona).startsWith('@'));
});
