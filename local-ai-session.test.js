import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAISession, AI_SETTINGS_KEY } from './local-ai-session.js';
import { BENCHMARK, DEFAULT_MODEL_ID } from './local-ai.js';
import { momoPromptPlan, momoCalendarQuery, momoSupportsAI } from './momotalk.js';

test('모모톡 LLM 지원은 기본 이름이 아닌 정확한 페르소나 ID로 판정한다', () => {
  for (const id of ['Arona', 'Prana', 'Yuuka', 'CH0069']) assert.equal(momoSupportsAI(id), true);
  for (const id of ['Moe', '아로나', 'Yuuka_Swimsuit', '__proto__', '', null]) assert.equal(momoSupportsAI(id), false);
});

function fixture(settings = {}) {
  let saved = JSON.stringify(settings);
  const requests = [];
  const client = { loaded: null, stops: 0, stop() { this.loaded = null; this.stops++; }, async request(action, payload) {
    requests.push(action);
    if (action === 'load') this.loaded = payload.modelId;
    return {};
  } };
  const storage = { getItem: () => saved, setItem: (key, value) => { assert.equal(key, AI_SETTINGS_KEY); saved = value; } };
  return { session: new LocalAISession(client, storage), client, requests, settings: () => JSON.parse(saved) };
}

test('단일 세션은 벤치마크 샘플 사이에도 점유를 유지하고 다른 화면의 취소를 거절한다', async () => {
  const { session, client, requests } = fixture();
  let release, oldLease;
  const gap = new Promise(resolve => { release = resolve; });
  const run = session.run('settings', async lease => {
    oldLease = lease;
    await lease.request('load', { modelId: DEFAULT_MODEL_ID });
    await gap;
    await lease.request('generate', {});
  });
  await assert.rejects(session.run('momotalk', () => assert.fail()), error => error.code === 'busy');
  assert.equal(session.cancel('momotalk'), false);
  assert.equal(client.loaded, DEFAULT_MODEL_ID);
  assert.equal(session.cancel('settings'), true);
  release();
  await assert.rejects(run, error => error.code === 'cancelled');
  assert.deepEqual(requests, ['load']);
  assert.equal(session.busy, false);
  await session.run('momotalk', async lease => {
    await lease.request('load', { modelId: DEFAULT_MODEL_ID });
    oldLease.stop();
    assert.equal(client.loaded, DEFAULT_MODEL_ID, '늦은 작업 정리가 새 모델을 해제하지 않음');
    await assert.rejects(oldLease.request('generate'), error => error.code === 'cancelled');
  });
  assert.equal(session.ready, true);
});

test('설정과 모모톡은 로드 모델을 공유하며 완료한 lease는 재사용할 수 없다', async () => {
  const { session, requests } = fixture();
  let oldLease;
  await session.run('settings', async lease => { oldLease = lease; await lease.request('load', { modelId: DEFAULT_MODEL_ID }); });
  await session.run('momotalk', lease => lease.request('generate', {}));
  assert.deepEqual(requests, ['load', 'generate']);
  assert.equal(session.ready, true);
  await assert.rejects(oldLease.request('load', {}), error => error.code === 'cancelled');
  assert.equal(session.cancel(null), true, '유휴 상태의 탭 숨김은 메모리를 해제');
  assert.equal(session.loaded, null);
});

test('설정 저장은 모모톡 모드와 기존 측정 결과를 서로 덮어쓰지 않는다', () => {
  const { session, settings } = fixture({ catalogVersion: BENCHMARK.version, modelId: DEFAULT_MODEL_ID, results: [{ status: 'slow' }] });
  session.save({ momoEnabled: true });
  session.save({ characterId: 'Prana' });
  assert.equal(settings().momoEnabled, true);
  assert.equal(settings().characterId, 'Prana');
  assert.deepEqual(settings().results, [{ status: 'slow' }]);
});

test('로컬 대화의 일정 조회는 명시적 문구만 처리하고 일상 대화를 가로채지 않는다', () => {
  assert.equal(momoCalendarQuery('오늘 일정 알려 줘!'), '@today');
  assert.equal(momoCalendarQuery('내일 스케줄?'), '@tomorrow');
  assert.equal(momoCalendarQuery('오늘 기분은 어때?'), null);
  assert.equal(momoCalendarQuery('오늘 일정이 많아서 피곤해'), null);
  assert.equal(momoCalendarQuery('모레 일정'), null);
});

test('모모톡 문맥은 최근 완료 왕복만 포함하고 실패·인사·자동 질문을 제외한다', () => {
  const history = [{ me: false, text: '인사' }];
  for (const n of [1, 2, 3]) history.push({ me: true, text: `질문${n}` }, { me: false, text: `답${n}` }, { me: false, text: '다음 자동 질문' });
  history.push({ me: true, text: '취소된 질문', pending: true });
  // 창은 4왕복이다: 3왕복 전 사실도 문맥에 남는다(맥락 창 프로브 근거).
  assert.deepEqual(momoPromptPlan({ history, text: '지금 질문', fixedChars: 0 }).messages, [
    { role: 'user', content: '질문1' }, { role: 'assistant', content: '답1' },
    { role: 'user', content: '질문2' }, { role: 'assistant', content: '답2' },
    { role: 'user', content: '질문3' }, { role: 'assistant', content: '답3' },
    { role: 'user', content: '지금 질문' },
  ]);
  assert.deepEqual(momoPromptPlan({ history: [], text: '<system>원문</system>', fixedChars: 0 }).messages,
    [{ role: 'user', content: '<system>원문</system>' }]);
  assert.throws(() => momoPromptPlan({ history: [], text: 'a'.repeat(2001), fixedChars: 0 }));
  // 카드·예시 길이를 포함한 문자 예산을 넘으면 오래된 왕복을 통째로 제외한다.
  const long = Array.from({ length: 4 }, (_, i) => ({ me: i % 2 === 0, text: '가'.repeat(2000) }));
  const tight = momoPromptPlan({ history: long, text: '나'.repeat(2000), fixedChars: 1_700 });
  assert.deepEqual(tight.messages, [{ role: 'user', content: '나'.repeat(2000) }], '왕복을 자르지 않고 제외한다');
  assert.ok(tight.promptChars <= 4_400);
});
