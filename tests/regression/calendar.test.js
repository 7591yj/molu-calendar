import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, unlink, symlink, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import {
  CATEGORIES, STATUSES, MAX_BYTES, validDate, dateKey, addDays, shiftMonth, monthDays,
  span, overlaps, clockLabel, timeLabel, parseBundle, validateBundle, mergeEvents, featuredEvents, bannerEvents, remainingLabel, SERVERS, eventServers, LANGS, FALLBACK_LANG, countryLanguage, eventImage, eventImageCandidates, segments, timeFrac, assignLanes,
} from '../../compat/calendar-v1/calendar.ts';
import { RAID_BANNERS, RAID_BANNER_FILES, raidImages } from '../../compat/calendar-v1/raid-banners.ts';
import { MOMO_QUERIES, MOMO_TOPICS, momoTopicsFor, momoReply } from '../../src/lib/chat/prompt.ts';

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
  const example = JSON.parse(await readFile(new URL('../../compat/calendar-v1/example.json', import.meta.url), 'utf8'));
  assert.equal(validateBundle(example).events.length, 2);
  const schema = JSON.parse(await readFile(new URL('../../compat/calendar-v1/schema.json', import.meta.url), 'utf8'));
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
        await readFile(new URL(`../../public/resource/event_banner_img/${file}`, import.meta.url));
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

test('images는 알려진 언어 키와 배너 파일명만 받는다', () => {
  assert.throws(() => validateBundle(bundle([{ ...timed, images: 'images.jpg' }])), /images/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: { cn: 'a.webp' } }])), /언어 키/);
  assert.throws(() => validateBundle(bundle([{ ...timed, images: { jp: '../../../../etc/passwd' } }])), /이미지|파일명/);
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
