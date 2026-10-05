import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, unlink, symlink, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { makeServer, files as servedFiles } from './server.js';
import { walkFrame, modelResource } from './character.js';
import {
  CATEGORIES, STATUSES, MAX_BYTES, validDate, dateKey, addDays, shiftMonth, monthDays,
  span, overlaps, clockLabel, timeLabel, parseBundle, validateBundle, mergeEvents, featuredEvents, bannerEvents, remainingLabel, SERVERS, eventServers, LANGS, FALLBACK_LANG, countryLanguage, eventImage, eventImageCandidates, segments, timeFrac, assignLanes,
} from './calendar.js';
import { RAID_BANNERS, RAID_BANNER_FILES, raidImages } from './raid-banners.js';
import { MOMO_QUERIES, MOMO_TOPICS, momoTopicsFor, momoReply } from './momotalk.js';

const timed = { id: 'test-1', title: '점검', category: 'maintenance', all_day: false, start: '2026-09-29T11:00:00+09:00', end: '2026-09-29T14:00:00+09:00' };
const bundle = events => ({ schema_version: 1, events });
// source_url은 공식 공지·마이크로사이트·뉴스가 먼저고, 공식 페이지가 없는 일정만 위키로 남는다.
const SOURCE_HOSTS = ['forum.nexon.com', 'bluearchive.nexon.com', 'bluearchive.jp', 'www.bluearchive-cn.com', 'bluearchive.wiki'];

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

test('segments는 표시 인덱스를 주 행 단위 조각으로 나눈다', () => {
  assert.deepEqual(segments([3, 4, 5]), [[3, 4, 5]]);
  assert.deepEqual(segments([3, 4, 5, 7, 8]), [[3, 4, 5], [7, 8]]);
  assert.deepEqual(segments([6, 7]), [[6], [7]]);
  assert.deepEqual(segments([]), []);
});

test('시각 비율과 lane 공유는 같은 날 종료·시작 일정을 한 줄로 냔다', () => {
  assert.equal(timeFrac('00:00'), 0);
  assert.equal(timeFrac('24:00'), 1);
  assert.equal(timeFrac('12:00'), 0.5);
  assert.equal(timeFrac('18:30'), 0.7708333333333334);
  // 같은 날에 하나는 11:00에 끝나고 하나는 18:00에 시작하면 lane을 나눠 쓴다.
  const shared = [
    { startPos: 0, endPos: 1 + 11 / 24, lane: 0 },
    { startPos: 1 + 18 / 24, endPos: 2, lane: 0 },
  ];
  assert.equal(assignLanes(shared), 1);
  assert.equal(shared[0].lane, shared[1].lane, 0);
  // 겹치면 다른 lane으로 간다.
  const stacked = [
    { startPos: 0, endPos: 2, lane: 0 },
    { startPos: 1 + 18 / 24, endPos: 3, lane: 0 },
  ];
  assert.equal(assignLanes(stacked), 2);
  assert.notEqual(stacked[0].lane, stacked[1].lane);
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

test('제공 예시와 JSON Schema의 분류·상태 계약 일치', async () => {
  const example = JSON.parse(await readFile(new URL('./example.json', import.meta.url), 'utf8'));
  assert.equal(validateBundle(example).events.length, 2);
  const schema = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  const fields = schema.properties.events.items.properties;
  assert.deepEqual(fields.category.enum, Object.keys(CATEGORIES));
  assert.deepEqual(fields.status.enum, Object.keys(STATUSES));
  assert.deepEqual(fields.servers.items.enum, Object.keys(SERVERS));
  assert.deepEqual(fields.images.propertyNames.enum, Object.keys(LANGS));
});

test('배너는 고른 언어를 먼저 쓰고 없으면 일본어로 폴백한다', () => {
  const event = { ...timed, images: { jp: 'jp.webp', en: 'en.webp' } };
  assert.equal(eventImage(event, 'en'), 'en.webp');
  assert.equal(eventImage(event, 'kr'), 'jp.webp', '없는 언어는 일본어 폴백');
  assert.equal(eventImage({ ...timed, images: { en: 'en.webp' } }, 'kr'), 'en.webp', '일본어도 없으면 있는 배너');
  assert.equal(eventImage({ ...timed, images: { kr: 'kr.webp' } }, 'en'), 'kr.webp');
  assert.equal(eventImage(timed, 'kr'), null, '배너가 하나도 없으면 표시하지 않음');
  assert.equal(eventImage({ ...timed, images: { __proto__: 'x.webp' } }, 'jp'), null, '프로토타입 키는 무시');
  assert.deepEqual(Object.keys(LANGS), ['kr', 'jp', 'en', 'zh']);
  assert.equal(FALLBACK_LANG, 'jp');
  const data = validateBundle(bundle([{ ...timed, images: { kr: 'kr.webp' } }]));
  assert.deepEqual(data.events[0].images, { kr: 'kr.webp' });
});

test('배너 언어 설정은 서버와 무관하게 모든 일정에 적용된다', () => {
  const images = { kr: 'kr.webp', jp: 'jp.webp', en: 'en.webp', zh: 'zh.webp' };
  for (const server of Object.keys(SERVERS)) {
    for (const lang of Object.keys(LANGS)) {
      assert.equal(eventImage({ ...timed, servers: [server], images }, lang), images[lang]);
    }
  }
});

test('레이드 배너는 시즌·서버·일정 images 없이 보스 데이터셋을 재사용한다', async () => {
  for (const boss of Object.values(RAID_BANNERS)) {
    for (const [type, label] of [['total', '총력전'], ['grand', '대결전']]) {
      if (!boss[type]) continue;
      for (const name of boss.names) {
        const jp = { ...timed, id: 'future-rotation', title: `${label} ${name} (시즌 999)`, servers: ['jp'] };
        assert.deepEqual(raidImages(jp), boss[type].jp ? { jp: boss[type].jp } : {}, 'JP 일정에는 jp 배너만');
        assert.equal(eventImage(jp, 'kr'), boss[type].jp, 'JP 일정에 KR 배너를 주입하지 않음');
        assert.equal(eventImage(jp, 'jp'), boss[type].jp);
        const gl = { ...jp, servers: ['gl'] };
        assert.deepEqual(raidImages(gl), boss[type], 'GL 일정은 전 언어 재사용');
        assert.equal(eventImage(gl, 'kr'), boss[type].kr ?? boss[type].jp);
      }
      for (const file of Object.values(boss[type])) {
        assert.match(file, /^[A-Za-z0-9_-]+\.webp$/);
        await readFile(new URL(`./resource/event_banner_img/${file}`, import.meta.url));
      }
    }
  }
  assert.deepEqual(raidImages({ title: '호드 픽업' }), {}, '레이드가 아닌 일정은 매칭하지 않음');
  assert.deepEqual(raidImages({ title: '대결전 Unknown Boss' }), {}, '다른 보스 아트를 대체하지 않음');
  assert.deepEqual(raidImages({ title: '대결전 Method' }), {}, 'Hod가 다른 이름 일부이면 매칭하지 않음');
  assert.equal(eventImage({ ...timed, title: '대결전 New Boss', images: { jp: 'new-boss.webp' } }, 'kr'), 'new-boss.webp');
  assert.match(eventImage({ ...timed, title: '대결전 비나', images: { kr: 'stale.webp' } }, 'kr'), /^kr-raid-grand-decagrammaton-binah/);
  assert.notEqual(eventImage({ ...timed, title: '대결전 비나' }, 'kr'), eventImage({ ...timed, title: '총력전 비나' }, 'kr'));
});

test('첫 접속 IP 국가를 지원 언어로 매핑하고 실패하면 브라우저 언어를 유지한다', () => {
  for (const [country, lang] of Object.entries({ KR: 'kr', JP: 'jp', CN: 'zh', TW: 'zh', HK: 'zh', MO: 'zh', US: 'en', DE: 'en' })) {
    assert.equal(countryLanguage(country), lang);
  }
  for (const country of [undefined, null, '', 'invalid', 42, {}]) {
    assert.equal(countryLanguage(country, 'jp'), 'jp');
  }
  assert.equal(countryLanguage(undefined), 'kr');
});

test('IP 초기화는 첫 접속만 실행하고 저장된 언어·수동 변경을 보호한다', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const startup = source.slice(source.indexOf('if (!languageChosen) {'), source.indexOf('// 새로고침해도 있던 화면 유지:'));
  for (const scenario of ['first', 'saved', 'manual', 'failure']) {
    let resolveLookup;
    let rejectLookup;
    let calls = 0;
    let saves = 0;
    const context = {
      languageChosen: scenario === 'saved', prefs: { lang: scenario === 'saved' ? 'zh' : 'kr' },
      countryLanguage, AbortSignal, state: { events: [] }, activeScreen: 'calendar',
      fetch: () => { calls++; return new Promise((resolve, reject) => { resolveLookup = resolve; rejectLookup = reject; }); },
      savePrefs: () => { saves++; }, render: () => {},
    };
    runInNewContext(startup, context);
    assert.equal(calls, scenario === 'saved' ? 0 : 1);
    if (scenario === 'saved') { assert.equal(context.prefs.lang, 'zh'); continue; }
    if (scenario === 'manual') { context.languageChosen = true; context.prefs.lang = 'en'; }
    if (scenario === 'failure') rejectLookup(new Error('offline'));
    else resolveLookup({ ok: true, json: async () => ({ country: 'JP' }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.prefs.lang, ({ first: 'jp', manual: 'en', failure: 'kr' })[scenario]);
    assert.equal(saves, scenario === 'manual' ? 0 : 1);
  }
});

test('images는 알려진 언어 키와 배너 파일명만 받는다', () => {
  assert.throws(() => validateBundle(bundle([{ ...timed, images: 'images.jpg' }])), /images/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: { cn: 'a.webp' } }])), /언어 키/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: { jp: '../../etc/passwd' } }])), /이미지|파일명/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: { jp: 42 } }])), /파일명/);
  assert.throws(() => validateBundle(bundle([{ ...timed, image: 'images.jpg' }])), /지원하지 않는 필드/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: {} }])), /images/);
  // 리터럴의 __proto__는 프로토타입이지만, JSON.parse는 own 속성으로 만든다.
  assert.throws(() => validateBundle(bundle([{ ...timed, images: JSON.parse('{"__proto__": "x.webp"}') }])), /언어 키/);
});

test('서버 지정은 검증되고 생략하면 전체 서버로 정규화된다', () => {
  assert.deepEqual(validateBundle(bundle([timed])).events[0].servers, ['jp', 'gl']);
  assert.deepEqual(validateBundle(bundle([{ ...timed, id: 'gl-only', servers: ['gl'] }])).events[0].servers, ['gl']);
  assert.deepEqual(eventServers({}), ['jp', 'gl']);
  assert.deepEqual(eventServers({ servers: ['gl', 'jp'] }), ['gl', 'jp']);
  assert.deepEqual(eventServers({ servers: ['xx'] }), ['jp', 'gl']);
  assert.throws(() => validateBundle(bundle([{ ...timed, id: 'no-server', servers: [] }])), /servers/);
  assert.throws(() => validateBundle(bundle([{ ...timed, id: 'dup-server', servers: ['jp', 'jp'] }])), /servers/);
  assert.throws(() => validateBundle(bundle([{ ...timed, id: 'bad-server', servers: ['cn'] }])), /servers/);
  assert.throws(() => validateBundle(bundle([{ ...timed, id: 'bad-shape', servers: 'jp' }])), /servers/);
});

test('내장 일정은 가상 데이터가 아니라 출처가 있는 실제 일정이다', async () => {
  const data = JSON.parse(await readFile(new URL('./resource/events.json', import.meta.url), 'utf8'));
  const events = validateBundle(data).events; // 날짜·시각·id·URL 형식은 여기서 검증된다
  assert.ok(events.length >= 20, `내장 일정이 너무 적습니다: ${events.length}`);
  assert.ok(Object.hasOwn(servedFiles, '/resource/events.json'), 'server.js 화이트리스트에 없음 — 브라우저 404');
  assert.equal(new Set(events.map(event => event.id)).size, events.length, '중복 id');
  for (const event of events) {
    assert.ok(Object.hasOwn(CATEGORIES, event.category), `${event.id}: 알 수 없는 분류 ${event.category}`);
    assert.ok(event.servers.length && event.servers.every(server => Object.hasOwn(SERVERS, server)), `${event.id}: 알 수 없는 서버`);
    assert.ok(SOURCE_HOSTS.includes(new URL(event.source_url).host), `${event.id}: 알 수 없는 출처 ${event.source_url}`);
    assert.ok(!/가상|샘플/.test(`${event.title}${event.description}`), `${event.id}: 가상 일정 문구가 남아 있음`);
  }
  for (const server of Object.keys(SERVERS)) assert.ok(events.some(event => event.servers.includes(server)), `내장 일정에 ${server} 서버가 없습니다`);
  assert.deepEqual(events.map(event => event.start), [...events.map(event => event.start)].sort(), '시작 순서 정렬');
});

test('일정 배너는 그 일정의 실제 이미지를 가리키고, 파일과 서버 화이트리스트가 맞물린다', async () => {
  const data = JSON.parse(await readFile(new URL('./resource/events.json', import.meta.url), 'utf8'));
  // 앱이 실제로 쓰는 값은 validateBundle이 정규화한 결과다. 원본 JSON만 보면 필드가 조용히 버려져도 통과한다.
  const events = validateBundle(data).events;
  const used = new Set();
  let referenced = 0;
  for (const event of events) {
    for (const [lang, file] of Object.entries(event.images ?? {})) {
      referenced++;
      used.add(file);
      assert.ok(Object.hasOwn(LANGS, lang), `${event.id}: 알 수 없는 배너 언어 ${lang}`);
      assert.ok(Object.hasOwn(servedFiles, `/resource/event_banner_img/${file}`), `${file}: server.js 화이트리스트에 없음`);
      await readFile(new URL(`./resource/event_banner_img/${file}`, import.meta.url));
    }
  }
  // 보스 공용 아트는 일정 창과 무관하게 보존한다. 데이터셋이 유일한 이름 출처다.
  const dir = new URL('./resource/event_banner_img/', import.meta.url);
  for (const file of RAID_BANNER_FILES) {
    used.add(file);
    assert.ok(Object.hasOwn(servedFiles, `/resource/event_banner_img/${file}`), `${file}: server.js 화이트리스트에 없음`);
    await readFile(new URL(`./resource/event_banner_img/${file}`, import.meta.url));
  }
  const expected = data.events.reduce((sum, event) => sum + Object.keys(event.images ?? {}).length, 0);
  assert.equal(referenced, expected, 'validateBundle이 images를 떨어뜨렸습니다');
  assert.ok(used.size >= 20, `실제 배너가 너무 적습니다: ${used.size}`);
  // 배너 파일명은 스키마의 maxLength 80 안에 들어야 한다.
  for (const file of used) assert.ok(file.length <= 80, `${file}: 파일명이 80자를 넘음`);
  // 한국어·중국어 배너는 공식 소스에서 수집한다(tools/vendor_banners.py).
  // CN은 학생 이름으로, KR은 포럼 모집 공지로 매칭하므로 커버리지는 소스가 정한다.
  for (const lang of ['kr', 'zh']) {
    const covered = events.filter(event => event.images?.[lang]).length;
    assert.ok(covered >= 20, `${lang} 배너가 너무 적습니다: ${covered}`);
  }
  // 총력전·대결전·종합전술시험·미니 이벤트·경험치 2배는 전용 아트가 반드시 있어야 한다.
  for (const event of events) {
    if (/총력전|대결전/.test(event.title) || event.title.includes('종합전술시험') || event.description.startsWith('Mini-Event') || event.title.startsWith('Double level EXP')) assert.ok(eventImage(event, 'jp'), `${event.id}: 전용 배너 없음`);
  }
  // 일정 데이터는 로테이션 정보만 담는다. 보스 아트의 KR/JP 선택은 데이터셋이 결정한다.
  // JP 일정에는 jp 배너만 주입하고, GL 일정에만 KR 공용 아트를 허용한다.
  for (const event of events.filter(event => /총력전|대결전/.test(event.title))) {
    const kr = eventImage(event, 'kr');
    assert.ok(eventImage(event, 'jp'), `${event.id}: 전용 배너 없음`);
    if (event.servers?.length === 1 && event.servers[0] === 'jp') assert.doesNotMatch(kr, /^kr-/, `${event.id}: JP 일정에 한국어 아트`);
    else if (event.title.includes('Geburah')) assert.doesNotMatch(kr, /^kr-/, `${event.id}: 미공개 한국어 아트`);
    else assert.match(kr, /^kr-raid-/, `${event.id}: 한국어 레이드 아트 없음`);
  }
  // 도구가 만든 webp는 전부 쓰여야 한다. 남으면 창 밖으로 나간 일정의 잔재다.
  const orphans = (await readdir(dir)).filter(name => name.endsWith('.webp') && !used.has(name));
  assert.deepEqual(orphans, [], 'events.json과 데이터셋에 없는 배너 파일');
  // 수집 도구는 raid-banners.js를 읽어 공용 아트를 보호한다(도구에 목록을 복사하지 않음).
  const onDisk = (await readdir(dir)).filter(name => /^(?:kr-)?raid-.*\.webp$/.test(name));
  assert.deepEqual(onDisk.sort(), [...RAID_BANNER_FILES].sort(), '디스크와 데이터셋의 보스 아트 목록이 다름');
  const tools = await Promise.all(['./tools/vendor_events.py', './tools/vendor_banners.py'].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  for (const tool of tools) assert.match(tool, /raid_assets\(\)/, '수집 도구가 공용 아트 보호 목록을 읽지 않음');
});

function fakeElement(tag = 'div') {
  const element = {
    tagName: tag, className: '', textContent: '', type: '', children: [], dataset: {}, attributes: {}, listeners: {},
    style: { setProperty(name, value) { element.style[name] = value; } },
    classList: {
      add(...names) { element.className = [element.className, ...names].filter(Boolean).join(' '); },
      remove(name) { element.className = element.className.split(' ').filter(item => item !== name).join(' '); },
      contains(name) { return element.className.split(' ').includes(name); },
      toggle(name, on) { element.classList[on ? 'add' : 'remove'](name); },
    },
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren(...nodes) { element.children = nodes; },
    querySelector: () => fakeElement(),
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    removeAttribute(name) { delete element.attributes[name]; },
    addEventListener(kind, handler) { (element.listeners[kind] ??= []).push(handler); },
  };
  return element;
}

test('설정앱은 iOS 그룹 목록 규칙(행 종류·섹션·하위 페이지)을 지킨다', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = {};
  const element = selector => (elements[selector] ??= fakeElement());
  const context = {
    document: {
      createElement: tag => fakeElement(tag),
      createElementNS: (_, tag) => fakeElement(tag),
      querySelector: element,
    },
    state: { view: 'month', filter: 'all', server: 'all', events: [{ id: 'e1', title: '테스트 일정', images: { jp: 'sample.webp', kr: 'sample-kr.webp' } }] },
    prefs: { lang: 'kr', bannerAuto: true, momoSound: true, devMode: true },
    $: element,
    matchMedia: () => ({ matches: true }),
    CATEGORIES, SERVERS, LANGS, TextEncoder,
    reducedMotion: { matches: false },
    savePrefs() {}, render() {}, openImport() {}, saveCrops: () => true, alert() {}, confirm: () => false,
    bannerFrame: () => fakeElement(), attachCropEditor() {}, cropLabel: () => '중심 50.0% 50.0% · 영역 100%', crops: {},
  };
  const nodeImpl = source.slice(source.indexOf('function node(tag'), source.indexOf('function eventColor('));
  const region = source.slice(source.indexOf("let setTab = 'general';"), source.indexOf("document.querySelectorAll('.set-nav')"));
  assert.ok(nodeImpl && region, '설정 코드 구간을 찾지 못했습니다');
  const api = runInNewContext(`${nodeImpl}\n${region}\n({ renderSetDetail, pushChoice, pushPage, popSetPage, iosRow, iosSwitch, iosSection, select: name => { setTab = name; }, stack: () => setPath.length, devTitles: DEV_TOOLS.map(tool => tool.title).join('|') })`, context);
  const find = (nodes, className) => nodes.flatMap(node => [node, ...find(node.children ?? [], className)]).filter(node => node.classList?.contains(className));
  const rowText = row => find([row], 'ios-text')[0]?.textContent;

  // 루트 페이지: 섹션 헤더 + 카드, 하위 페이지로 가는 행에는 셰브론.
  api.renderSetDetail();
  const body = element('#set-body');
  assert.equal(find(body.children, 'ios-section-title')[0].textContent, '표시');
  assert.ok(find(body.children, 'ios-card').length >= 2);
  const rootRows = find(body.children, 'ios-row');
  for (const label of ['보기 방식', '서버', '분류', '배너 언어']) {
    const row = rootRows.find(candidate => rowText(candidate) === label);
    assert.ok(row, `${label}: 행 없음`);
    assert.equal(find([row], 'ios-chevron').length, 1, `${label}: 셰브론 없음`);
    assert.equal(row.tagName, 'button', `${label}: 누를 수 없음`);
  }
  assert.equal(rootRows.filter(row => row.attributes.role === 'switch').length, 2, '스위치 행은 두 개');

  // 스위치: 행 전체를 눌러 켜고 끄며, 값이 즉시 저장된다.
  const switchRow = rootRows.find(row => row.attributes.role === 'switch');
  assert.equal(switchRow.attributes['aria-checked'], 'true');
  switchRow.listeners.click[0]();
  assert.equal(switchRow.attributes['aria-checked'], 'false');
  assert.equal(context.prefs.bannerAuto, false);

  // 하위 페이지: 제목·뒤로가기 라벨이 바뀌고, 고른 값에만 체크가 붙는다.
  const picked = [];
  api.pushChoice('서버', [['all', '전체'], ['jp', '일본']], () => 'jp', value => picked.push(value), '설명');
  assert.equal(element('#set-detail-title').textContent, '서버');
  assert.equal(element('#set-compact-title').textContent, '서버');
  assert.equal(element('#set-back-label').textContent, '일반');
  assert.equal(element('#app-settings').dataset.stack, 'page');
  assert.equal(api.stack(), 1);
  const choiceBody = element('#set-body').children;
  const choiceRows = find(choiceBody, 'ios-row');
  assert.equal(choiceRows.length, 2);
  assert.equal(choiceRows[0].attributes['aria-pressed'], 'false');
  assert.equal(choiceRows[1].attributes['aria-pressed'], 'true');
  assert.equal(rootRows.find(row => rowText(row) === '서버').attributes['aria-pressed'], undefined);
  assert.equal(choiceRows.filter(row => find([row], 'ios-check').length === 1).length, 1, '체크는 현재 값 하나뿐');
  assert.equal(find(choiceRows, 'ios-chevron').length, 0, '고르는 행에는 셰브론을 두지 않음');
  const checkedRow = choiceRows.find(row => find([row], 'ios-check').length === 1);
  assert.equal(rowText(checkedRow), '일본');
  assert.equal(find(choiceBody, 'ios-section-footer')[0].textContent, '설명');
  choiceRows[0].listeners.click[0]();
  assert.deepEqual(picked, ['all']);
  assert.equal(api.stack(), 0);
  assert.equal(element('#set-detail-title').textContent, '일반');
  assert.equal(element('#app-settings').dataset.stack, 'root');

  // 파괴적 행은 빨간색으로 표시하고 셰브론을 두지 않는다(iOS 확인 대화상자 규칙).
  api.select('data');
  api.renderSetDetail();
  const danger = find(element('#set-body').children, 'ios-row-danger');
  assert.equal(danger.length, 1);
  assert.equal(rowText(danger[0]), '저장 데이터 초기화');
  assert.equal(find(danger, 'ios-chevron').length, 0);

  // 개발자 페이지는 도구 메뉴다. 도구를 고르면 하위 페이지에서 실행한다.
  api.select('dev');
  api.renderSetDetail();
  assert.ok(context.prefs.devMode, '개발자 모드 기본값');
  const devTitles = api.devTitles.split('|');
  assert.ok(devTitles.length >= 1, '개발자 도구가 하나도 없음');
  const toolRows = find(element('#set-body').children, 'ios-row');
  assert.equal(toolRows.map(rowText).join('|'), api.devTitles);
  assert.equal(find(toolRows, 'ios-chevron').length, devTitles.length, '도구마다 셰브론');
  assert.equal(find(element('#set-body').children, 'crop-row').length, 0, '개발자 메뉴에는 도구 내용을 펼치지 않음');
  toolRows[0].listeners.click[0]();
  assert.equal(element('#set-detail-title').textContent, '배너 크롭');
  assert.equal(element('#set-back-label').textContent, '개발자');
  const toolBody = element('#set-body').children;
  assert.equal(rowText(find(toolBody, 'ios-row-danger')[0]), '배너 크롭 전체 초기화');
  assert.equal(find(toolBody, 'crop-row').length, 2, '배너 파일 행은 이미지 수만큼');
  element('[data-set-back]');
  api.popSetPage();
  assert.equal(element('#set-detail-title').textContent, '개발자');

  // 전환 게이트: 애니메이션 없이 그리면 anim 속성이 붙지 않고, 밀어 올리면 붙는다.
  delete element('#set-body').dataset.anim;
  api.select('general');
  api.renderSetDetail();
  assert.equal(element('#set-body').dataset.anim, undefined, '분할 레이아웃 카테고리 선택에는 전환이 없어야 함');
  api.pushPage('배너 크롭', () => []);
  assert.equal(element('#set-body').dataset.anim, 'push', '하위 페이지는 밀어 올림');
  api.popSetPage();
  assert.equal(element('#set-body').dataset.anim, 'pop', '뒤로가기는 되돌림');
  assert.equal(element('#set-scroll').scrollTop, 0, '페이지 전환 시 위로 되감음');

  // 셸과 스타일: 대형 타이틀·내비게이션 바·다크 모드·전환 애니메이션.
  const [markup, css] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  for (const needle of ['ios-navbar', 'ios-large-title', 'id="set-scroll"', 'ios-scroll', 'data-set-back']) assert.ok(markup.includes(needle), `${needle}: 셸에 없음`);
  assert.match(css, /#app-settings\{--ios-bg:/);
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{#app-settings\{/);
  assert.match(css, /#app-settings\[data-stack="page"\] \.set-back\{display:inline-flex\}/);
  assert.match(css, /\.ios-row\+\.ios-row::before\{/);
  assert.match(css, /@keyframes ios-push\{/);
  assert.match(css, /\.ios-scroll\.scrolled \.ios-navbar-title\{opacity:1\}/);
  // 한 열 기준은 CSS와 JS가 같은 값이어야 한다(다르면 사이드바 선택에 슬라이드가 붙는다).
  const jsBreakpoint = source.match(/matchMedia\('\(max-width:(\d+)px\)'\)/)?.[1];
  const cssBreakpoint = css.match(/@media\(max-width:(\d+)px\)\{#app-settings\[data-pane="side"\]/)?.[1];
  assert.ok(jsBreakpoint && cssBreakpoint, '분할 브레이크포인트를 찾지 못했습니다');
  assert.equal(jsBreakpoint, cssBreakpoint, 'CSS와 JS의 분할 브레이크포인트가 다름');
  assert.match(source, /renderSetDetail\(SET_SINGLE_COLUMN\.matches \? 'push' : undefined\)/, '사이드바 선택은 한 열에서만 밀어 올려야 함');
});

test('목록에서 월 보기로 돌아오면 보이는 날짜 칸에서 막대를 측정한다', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = {
    '#calendar-view': { hidden: true },
    '#agenda': { hidden: false },
    '#month-view': { setAttribute() {} },
    '#list-view': { setAttribute() {} },
  };
  const cell = { offsetLeft: 10, offsetTop: 20, querySelector: () => ({ offsetTop: 2, offsetHeight: 12 }) };
  Object.defineProperty(cell, 'offsetWidth', { get: () => elements['#calendar-view'].hidden ? 0 : 100 });
  elements['#calendar-grid'] = { querySelectorAll: () => [cell] };
  const bar = { style: {} };
  let measurements = 0;
  const context = {
    $: selector => elements[selector], state: { view: 'month' },
    spanSegs: [{ indices: [0], startPos: 0, endPos: 1, lane: 0, bar }],
    renderFilters() {}, renderBriefing() {}, renderMetrics() {}, updateDockDate() {},
    renderCalendar() { measurements++; context.placeSpanBars(); },
  };
  const render = source.slice(source.indexOf('function render() {'), source.indexOf('function changeMonth('));
  const place = source.slice(source.indexOf('function placeSpanBars() {'), source.indexOf('// Multi-day events'));
  runInNewContext(`${place}\n${render}\nrender();`, context);
  assert.equal(measurements, 1);
  assert.equal(elements['#agenda'].hidden, true);
  assert.equal(bar.style.left, '10px');
  assert.equal(bar.style.width, '100px');
  assert.equal(bar.style.top, '38px');
});

test('터치용 상대 위치는 span-bar를 제외하고 터치 영역은 유지한다', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const coarse = css.slice(css.indexOf('@media(pointer:coarse)'));
  assert.match(css, /\.span-bar\{position:absolute;/);
  assert.match(coarse, /\.icon-button,\.day-event:not\(\.span-bar\),\.more-events,\.filter-chip\{position:relative\}/);
  assert.match(coarse, /\.day-event::after/);
});

test('달력 렌더에 필요한 서버 필터 컨테이너가 있다', async () => {
  const [markup, script] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8')
  ]);
  assert.match(script, /\$\('#servers'\)/);
  assert.match(markup, /id="servers"/);
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
    assert.ok(Object.hasOwn(servedFiles, `/resource/momotalk/${student.img}`), `${student.img}: server.js 화이트리스트에 없음 — 브라우저 404`);
    await readFile(new URL(`./resource/momotalk/${student.img}`, import.meta.url)); // 파일이 없으면 실패
  }
});

test('브라우저 모듈 그래프의 모든 상대 import가 서버 화이트리스트에 있다', async () => {
  const roots = ['app.js', 'local-ai-settings.js', 'local-ai-session.js', 'local-ai.js', 'local-ai-worker.js', 'momotalk.js', 'persona.js',
    'chat-store.js', 'chat-transcript.js', 'calendar.js', 'banner-crop.js', 'raid-banners.js'];
  const seen = new Set();
  // local-ai-worker.js는 esbuild IIFE 번들(local-ai-worker.bundle.js)로만 서빙된다.
  const bundledOnly = new Set(['local-ai-worker.js']);
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!bundledOnly.has(name)) assert.ok(Object.hasOwn(servedFiles, `/${name}`), `${name}: server.js 서빙 목록에 없음 — 브라우저 404`);
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = match[1].replace(/^\.\//, '');
      if (target.endsWith('.json')) {
        // JSON module import도 서빙 목록에 있어야 한다.
        assert.ok(Object.hasOwn(servedFiles, `/${target}`), `${name} → ${match[1]}: server.js 서빙 목록에 없음 — 브라우저 404`);
        continue;
      }
      assert.ok(!target.startsWith('..'), `${name} → ${match[1]}: 하위 디렉터리 모듈만 이 검사 대상`);
      queue.push(target);
    }
  }
  // Worker는 classic 번들이라 importScripts를 쓴다: 번들 자체가 서빙되는지만 확인한다.
  assert.ok(Object.hasOwn(servedFiles, '/local-ai-worker.bundle.js'));
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

test('실행 중 추가한 배너를 제공하고 삭제·경로 탈출·심볼릭 링크를 차단한다', async t => {
  const server = makeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const name = `test-runtime-${process.pid}.webp`;
  const linkName = `test-runtime-link-${process.pid}.webp`;
  const file = new URL(`./resource/event_banner_img/${name}`, import.meta.url);
  const link = new URL(`./resource/event_banner_img/${linkName}`, import.meta.url);
  t.after(async () => {
    await Promise.all([unlink(file).catch(() => {}), unlink(link).catch(() => {})]);
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/resource/event_banner_img/`;
  assert.equal((await fetch(base + name)).status, 404);
  assert.equal(Object.hasOwn(servedFiles, `/resource/event_banner_img/${name}`), false);
  const bytes = await readFile(new URL('./resource/event_banner_img/raid-grand-decagrammaton-hod-grand-assault.webp', import.meta.url));
  await writeFile(file, bytes);
  const response = await fetch(base + name);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/webp/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await fetch(base + name, { method: 'HEAD' })).status, 200);
  await unlink(file);
  assert.equal((await fetch(base + name)).status, 404);
  await symlink(new URL('./package.json', import.meta.url).pathname, link);
  assert.equal((await fetch(base + linkName)).status, 404);
  for (const path of ['%2e%2e%2f%2e%2e%2fpackage.json', 'anything.js', 'nested%2fimage.webp']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('배너의 상위 resource 폴더와 배너 폴더 심볼릭 링크도 차단한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'molu-banner-boundary-'));
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const resource = join(root, 'resource');
  const banners = join(resource, 'event_banner_img');
  const outside = join(root, 'outside');
  await mkdir(banners, { recursive: true });
  await mkdir(join(outside, 'event_banner_img'), { recursive: true });
  await writeFile(join(banners, 'secret.webp'), 'inside');
  await writeFile(join(outside, 'event_banner_img', 'secret.webp'), 'outside');
  const module = join(root, 'server.mjs');
  await writeFile(module, await readFile(new URL('./server.js', import.meta.url)));
  server = (await import(pathToFileURL(module))).makeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/resource/event_banner_img/secret.webp`;
  assert.equal(await (await fetch(url)).text(), 'inside');

  await rename(banners, `${banners}-original`);
  await symlink(join(outside, 'event_banner_img'), banners);
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(url, { method })).status, 404, `배너 폴더 링크: ${method}`);
  await unlink(banners);
  await rename(`${banners}-original`, banners);
  assert.equal((await fetch(url)).status, 200);

  await rename(resource, `${resource}-original`);
  await symlink(outside, resource);
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(url, { method })).status, 404, `resource 폴더 링크: ${method}`);
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
    // 코드에서 부르는 로컬 데이터 파일도 서버가 내려줘야 한다 (fetch 404는 조용한 빈 화면이 된다).
    for (const match of text.matchAll(/fetch\(\s*['"](\.[^'"]+)['"]/g)) imported.add(new URL(match[1], `http://localhost${path}`).pathname);
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

test('이미지 없음·로딩 실패·일정 없음에도 배너 영역을 유지한다', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function showBanner('), source.indexOf('const PREFS_KEY'));
  const frame = { dataset: {}, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} };
  const image = { id: 'memo-banner', dataset: {}, removeAttribute(name) { delete this[name]; } };
  const context = { prefs: { lang: 'kr' }, eventImageCandidates, bannerFrame: () => frame, applyBannerCrop() {}, crops: {} };
  runInNewContext(code, context);
  context.showBanner(image, timed);
  assert.equal(image.hidden, true);
  assert.equal(image.src, undefined);
  assert.match(frame.dataset.placeholder, /점검\n배너 이미지 준비 중/);
  assert.equal(frame.dataset.eventId, timed.id);
  assert.equal(frame.tabIndex, 0, '이미지가 없어도 상세 팝업을 열 수 있다');
  const event = { ...timed, images: { kr: 'real.webp' } };
  context.showBanner(image, event);
  assert.match(frame.dataset.placeholder, /불러오는 중/);
  assert.equal(image.src, './resource/event_banner_img/real.webp');
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(frame.dataset.placeholder, undefined);
  image.onerror();
  assert.equal(image.hidden, true);
  assert.match(frame.dataset.placeholder, /불러오지 못했습니다/);
  assert.equal(frame.dataset.eventId, event.id);
  assert.equal(frame.tabIndex, 0);
  context.showBanner(image, event);
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(frame.dataset.placeholder, undefined);
  context.showBanner(image, undefined);
  assert.match(frame.dataset.placeholder, /표시할 일정이 없습니다/);
  assert.equal(frame.dataset.eventId, undefined);
  assert.equal(frame.tabIndex, -1);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.banner-frame\[data-placeholder\][^{]*\{[^}]*aspect-ratio:2\/1/);
  assert.ok(source.includes('function renderFeatured(events = bannerEvents(serverEvents()))'));
  for (const name of ['images.jpg', 'i1mages.jpg', '1231123.jpg']) {
    assert.equal(existsSync(new URL(`./resource/event_banner_img/${name}`, import.meta.url)), false);
  }
});

test('한국어 이미지 HTTP 실패 시 JP로 재시도하고 모든 후보 실패에도 영역을 유지한다', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function showBanner('), source.indexOf('const PREFS_KEY'));
  const frame = { dataset: {}, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} };
  const image = { id: 'memo-banner', dataset: {}, removeAttribute(name) { delete this[name]; } };
  const applied = [];
  const context = { prefs: { lang: 'kr' }, eventImageCandidates, bannerFrame: () => frame, applyBannerCrop: (_, crop) => applied.push(crop), crops: { 'jp.webp': 'JP crop' } };
  runInNewContext(code, context);
  const event = { ...timed, images: { kr: 'kr.webp', jp: 'jp.webp' } };
  assert.deepEqual(eventImageCandidates(event, 'kr'), ['kr.webp', 'jp.webp']);
  context.showBanner(image, event);
  assert.equal(image.src, './resource/event_banner_img/kr.webp');
  image.onerror();
  assert.equal(image.src, './resource/event_banner_img/jp.webp');
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(frame.dataset.placeholder, undefined);
  assert.deepEqual(applied, ['JP crop']);
  context.showBanner(image, event);
  assert.equal(image.src, './resource/event_banner_img/jp.webp', '정상 폴백 이미지를 불필요하게 재시도하지 않음');
  context.prefs.lang = 'en';
  context.showBanner(image, event);
  assert.equal(image.src, './resource/event_banner_img/jp.webp');
  image.onerror();
  assert.equal(image.src, './resource/event_banner_img/kr.webp');
  image.onerror();
  assert.equal(image.onerror, null, '실패한 후보를 무한 재시도하지 않음');
  assert.match(frame.dataset.placeholder, /불러오지 못했습니다/);
  assert.equal(frame.dataset.eventId, event.id);
  assert.equal(frame.tabIndex, 0);
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
