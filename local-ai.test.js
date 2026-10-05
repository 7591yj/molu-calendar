import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import { makeServer } from './server.js';
import { MODELS, LEGACY_GEMMA2, DEFAULT_MODEL_ID, CHARACTERS, characterById, chatMessagesFor, LITERT_ASSET_PATH, LITERT_CACHE, BENCHMARK, WEBGPU_LIMITS, ENGINE_GUIDANCE, CACHE_NAMES, runtimeCompatibility, gpuLimitReason, modelURL, modelById, summarizeSamples, recommendModel, describeError, inspectEnvironment, inspectModelCaches, deleteModelCaches, LocalAIClient, benchmarkModels, errorWithCode } from './local-ai.js';
import { readFileSync } from 'node:fs';
import { PERSONAS, PERSONA_VERSION, systemPromptFor, chatMessagesWithReferences, normalizeMemories, normalizeExcerpts, referenceChars } from './persona.js';

// The dataset is the product, so it gets its own check: structure, turn counts, role order, and the shared no-emoji rule.
test('페르소나 데이터셋은 세계관·공통 지침·캐릭터별 예시를 갖추고 장식 문자를 쓰지 않는다', () => {
  assert.equal(PERSONA_VERSION, 1);
  assert.ok(PERSONAS.length >= 14, '최소 14명');
  assert.equal(new Set(PERSONAS.map(persona => persona.id)).size, PERSONAS.length, 'id는 고유');
  const decorative = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2665}\u{2764}\u{2661}]/u;
  for (const persona of PERSONAS) {
    const prompt = systemPromptFor(persona.id);
    assert.ok(prompt.includes(persona.persona), `${persona.id}: 세계관·지침 뒤에 페르소나`);
    assert.ok(prompt.includes('이모지'), `${persona.id}: 공통 지침 포함`);
    assert.ok(['존댓말', '반말', '혼용'].includes(persona.register), `${persona.id}: register 값`);
    assert.equal(persona.examples.length, 2, `${persona.id}: 예시 세트 2개`);
    for (const [index, example] of persona.examples.entries()) {
      const turns = example.length / 2;
      assert.ok(Number.isInteger(turns) && turns >= 4 && turns <= 6, `${persona.id} 세트${index + 1}: 4~6턴`);
      assert.equal(example.at(-1).role, 'assistant', `${persona.id} 세트${index + 1}: 답변으로 끝남`);
      for (const [position, message] of example.entries()) {
        assert.equal(message.role, position % 2 ? 'assistant' : 'user', `${persona.id} 세트${index + 1}: 역할 교대`);
        assert.ok(message.content.trim().length > 0, `${persona.id}: 빈 메시지 없음`);
        assert.ok(!decorative.test(message.content), `${persona.id}: 장식 문자 없음 (${message.content})`);
      }
    }
  }
  assert.equal(systemPromptFor('unknown'), null);
  assert.equal(chatMessagesFor('unknown', []), null);
});

// 말투는 눈으로만 보면 놓친다. 실제로 7명이 존댓말로 잘못 적혔었다(namu.wiki 대조로 발견).
// register가 선언된 대로 예시가 쓰였는지 기계적으로 확인한다.
test('캐릭터별 register와 few-shot 예시의 말투가 일치한다', () => {
  const polite = /(습니다|ㅂ니다|합니다|입니다|해요|하세요|세요|네요|답니다|지요|어요|아요|시죠)/;
  const checked = new Set();
  for (const persona of PERSONAS) {
    if (persona.register === '혼용') continue;
    const replies = persona.examples.flat().filter(message => message.role === 'assistant');
    const mixed = replies.filter(reply => polite.test(reply.content));
    if (persona.register === '반말') {
      assert.deepEqual(mixed.map(reply => reply.content), [], `${persona.id}: 반말인데 존댓말 예시가 있음`);
    } else {
      assert.ok(mixed.length > 0, `${persona.id}: 존댓말인데 존댓말 예시가 없음`);
    }
    checked.add(persona.register);
  }
  assert.deepEqual([...checked].sort(), ['반말', '존댓말']);
});

// 예시를 손으로 쓰면 캐릭터 목소리가 아니라 쓴 사람 목소리가 난다.
// set 1은 실제 모모톡 교환(선생님 발화 포함), set 2는 로비·잡담 음성 대사에서만 온다.
test('few-shot 예시의 답변은 실제 게임 대사에서만 온다', async () => {
  const lines = JSON.parse(await readFile(new URL('./resource/persona/lines.json', import.meta.url), 'utf8')).characters;
  const momotalk = JSON.parse(await readFile(new URL('./resource/persona/momotalk.json', import.meta.url), 'utf8')).characters;
  const decor = /[\u2665\u2661\u266a\u266b\u2606\u2605\u2764\ufe0f\u2727\u2728]/g;
  const clean = text => text.replace(decor, '').replace(/\s+/g, ' ').trim();
  let checked = 0;
  let fromMomotalk = 0;
  for (const persona of PERSONAS) {
    const voice = new Set(lines[persona.id].map(line => clean(line.text)));
    const chat = new Set((momotalk[persona.id]?.pairs ?? []).map(pair => clean(pair.student.join(' '))));
    assert.ok(voice.size >= 8, `${persona.id}: 음성 대사가 너무 적음 (${voice.size})`);
    for (const [setIndex, example] of persona.examples.entries()) {
      for (const message of example.filter(entry => entry.role === 'assistant')) {
        const text = clean(message.content);
        const real = voice.has(text) || chat.has(text);
        assert.ok(real, `${persona.id} set${setIndex + 1}: 실제 대사가 아님 — ${message.content.slice(0, 40)}`);
        if (chat.has(text)) fromMomotalk++;
        checked++;
      }
    }
    // 모모톡이 충분한 캐릭터는 마지막 세트(생성 직전)를 모모톡 교환으로 채운다.
    // 소형 모델은 마지막 예시를 가장 강하게 따라하므로 여기가 가장 중요하다.
    if (chat.size >= 4) {
      assert.ok(persona.examples.at(-1).filter(entry => entry.role === 'assistant').every(entry => chat.has(clean(entry.content))),
        `${persona.id}: 마지막 세트가 모모톡 교환이 아님`);
    }
  }
  // 캐릭터마다 턴 수가 다를 수 있다(모모톡 쌍이 적으면 4~6턴). 모든 답변을 검사했는지만 본다.
  const expected = PERSONAS.reduce((sum, persona) =>
    sum + persona.examples.flat().filter(entry => entry.role === 'assistant').length, 0);
  assert.equal(checked, expected);
  assert.ok(fromMomotalk >= 12 * 4, `모모톡에서 온 답변이 ${fromMomotalk}개뿐`);
});

// 스토리 대사 2만 줄에서 register를 측정한다. 손으로 적은 추측이 아니라 코퍼스가 판정한다.
// 학생은 동료에게는 반말, 선생님께는 존댓말을 쓸 수 있으므로 '선생'이 있는 줄만 센다.
test('선언한 register가 실제 스토리 대사와 맞는다', async () => {
  const story = JSON.parse(await readFile(new URL('./resource/persona/story_lines.json', import.meta.url), 'utf8')).characters;
  const polite = /(습니다|ㅂ니다|합니다|입니다|해요|하세요|세요|네요|답니다|지요|어요|아요|예요|이에요|십시오|습니까|ㅂ니까|시죠|군요|나요|까요|데요)\s*[.!?…~]*$/;
  const plain = /(다|냐|니|구나|는데|잖아|거든|해|줘|봐|마|자|야|어|아|지|네|군|라|까)\s*[.!?…~]*$/;
  let judged = 0;
  for (const persona of PERSONAS) {
    const toSensei = (story[persona.id] ?? []).filter(line => line.includes('선생'));
    const sentences = toSensei.flatMap(line => line.split(/(?<=[.!?…])\s+/)).map(line => line.trim()).filter(line => line.length > 1);
    const politeCount = sentences.filter(line => polite.test(line)).length;
    if (!politeCount && !sentences.filter(line => plain.test(line)).length) continue; // 판단할 종결형이 없음
    judged++;
    if (persona.register === '반말') {
      assert.equal(politeCount, 0, `${persona.id}: 반말인데 선생님께 존댓말 ${politeCount}문장`);
    } else if (persona.register === '존댓말') {
      assert.ok(politeCount >= 1, `${persona.id}: 존댓말인데 선생님께 존댓말이 한 문장도 없음`);
    }
  }
  assert.ok(judged >= 12, `판정한 캐릭터가 ${judged}명뿐`);
});

// 데이터셋은 네 파일이 서로 맞아야 쓸모가 있다. 로스터·헤더·단위 수치를 한 번에 본다.
test('페르소나 데이터셋 네 파일의 로스터와 헤더가 맞는다', async () => {
  const read = async name => JSON.parse(await readFile(new URL(`./resource/persona/${name}`, import.meta.url), 'utf8'));
  const characters = await read('characters.json');
  const ids = characters.characters.map(persona => persona.id);
  assert.equal(new Set(ids).size, ids.length, 'characters.json id 중복');

  for (const name of ['lines.json', 'story_lines.json', 'momotalk.json']) {
    const file = await read(name);
    assert.equal(file.version, 1, `${name}: version`);
    assert.ok(file.source.trim(), `${name}: source 없음`);
    assert.equal(file.counts.characters, Object.keys(file.characters).length, `${name}: counts.characters 불일치`);
    for (const key of Object.keys(file.characters)) {
      assert.ok(ids.includes(key), `${name}: characters.json에 없는 id ${key}`);
    }
  }

  const voice = await read('lines.json');
  const story = await read('story_lines.json');
  const momotalk = await read('momotalk.json');
  for (const [name, file] of [['lines.json', voice], ['story_lines.json', story]]) {
    assert.deepEqual(Object.keys(file.characters).sort(), [...ids].sort(), `${name}: 로스터 불일치`);
    const total = Object.values(file.characters).reduce((sum, list) => sum + list.length, 0);
    assert.equal(file.counts.lines, total, `${name}: counts.lines 불일치`);
    for (const [key, list] of Object.entries(file.characters)) {
      assert.ok(list.length > 0, `${name}: ${key} 비어 있음`);
    }
  }

  // 모모톡은 학생만 쓴다. 아로나·프라나는 싯딤의 상자 OS라 모모톡이 없다.
  const withoutMomotalk = ids.filter(id => !['Arona', 'Prana'].includes(id));
  assert.deepEqual(Object.keys(momotalk.characters).sort(), withoutMomotalk.sort(), 'momotalk.json: 로스터 불일치');
  assert.equal(momotalk.counts.pairs,
    Object.values(momotalk.characters).reduce((sum, entry) => sum + entry.pairs.length, 0), 'counts.pairs 불일치');
  assert.equal(momotalk.counts.conversations,
    Object.values(momotalk.characters).reduce((sum, entry) => sum + entry.conversations.length, 0), 'counts.conversations 불일치');
  for (const [key, entry] of Object.entries(momotalk.characters)) {
    assert.ok(Number.isInteger(entry.characterId), `${key}: characterId 없음`);
    assert.ok(entry.pairs.length > 0, `${key}: pairs 비어 있음`);
    for (const pair of entry.pairs) {
      assert.ok(pair.sensei.length > 0 && pair.student.length > 0, `${key}: 빈 모모톡 쌍`);
    }
  }
});

// 공유 세계관은 factions에 한 번만 쓰고, 그 캐릭터가 속한 것만 프롬프트에 들어간다.
test('소속 세계관은 공유되고, 캐릭터에게 필요한 것만 주입된다', () => {
  const dataset = JSON.parse(readFileSync(new URL('./resource/persona/characters.json', import.meta.url), 'utf8'));
  const factions = dataset.factions;
  assert.ok(Object.keys(factions).length >= 10, 'factions가 너무 적음');
  for (const [key, faction] of Object.entries(factions)) {
    assert.ok(faction.name?.trim(), `${key}: name 없음`);
    assert.ok(faction.lore?.trim(), `${key}: lore 없음`);
  }

  const used = new Set();
  for (const persona of PERSONAS) {
    assert.ok(persona.affiliation?.trim(), `${persona.id}: affiliation 없음`);
    assert.ok(persona.relations?.trim(), `${persona.id}: relations 없음`);
    assert.ok(persona.factions.length > 0, `${persona.id}: factions 비어 있음`);
    for (const key of persona.factions) {
      assert.ok(factions[key], `${persona.id}: 없는 faction ${key}`);
      used.add(key);
    }
    const prompt = systemPromptFor(persona.id);
    assert.ok(prompt.includes(persona.affiliation), `${persona.id}: 소속 줄이 프롬프트에 없음`);
    assert.ok(prompt.includes(persona.relations), `${persona.id}: 인간관계가 프롬프트에 없음`);
    // 같은 학교라도 다른 학교의 세계관까지 끌어오지 않는다.
    for (const key of Object.keys(factions)) {
      if (persona.factions.includes(key)) continue;
      assert.ok(!prompt.includes(factions[key].name + ':'), `${persona.id}: 남의 소속 ${key}가 섞임`);
    }
  }
  assert.deepEqual([...used].sort(), Object.keys(factions).sort(), '아무도 쓰지 않는 faction이 있음');
});

test('few-shot 예시는 데이터셋에서 오고 호출자가 넘긴 대화 뒤에 붙는다', () => {
  const history = [{ role: 'user', content: '새 질문' }];
  const messages = chatMessagesFor('Hoshino', history);
  const persona = PERSONAS.find(entry => entry.id === 'Hoshino');
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages.slice(1, -1), persona.examples.flat(), '예시는 그대로, 호출자 입력은 아님');
  assert.deepEqual(messages.at(-1), history[0]);
  assert.ok(messages.length > 2, '예시가 없으면 페르소나가 무의미');
});

const sample = (ttftMs = 1500, tokensPerSecond = 20) => ({ ttftMs, tokensPerSecond, tokens: 96 });
const result = (modelId, samples = [sample(), sample(), sample()]) => ({ modelId, version: BENCHMARK.version, samples, ...summarizeSamples(samples) });

test('벤치마크는 첫 출력·생성 속도·실제 토큰 수를 구분하고 중앙값으로 판정한다', () => {
  assert.deepEqual(summarizeSamples([sample(2900, 10), sample(1000, 20), sample(2000, 30)]), { status: 'comfortable', ttftMs: 2000, tokensPerSecond: 20 });
  assert.equal(summarizeSamples([sample(3000), sample(3000), sample(3000)]).status, 'comfortable');
  assert.equal(summarizeSamples([sample(5000, 5), sample(5000, 5), sample(5000, 5)]).status, 'usable');
  assert.equal(summarizeSamples([sample(100, 5), sample(100, 5), sample(100, 5)]).status, 'comfortable');
  assert.equal(summarizeSamples([sample(), sample(), sample(5001)]).status, 'slow');
  assert.equal(summarizeSamples([sample(100, 4.9), sample(100, 4.9), sample(100, 99)]).status, 'slow');
  for (const samples of [null, {}, [], [sample()], [null, sample(), sample()], [sample(NaN), sample(), sample()], [sample(10, Infinity), sample(), sample()], [{ ...sample(), tokens: 1 }, sample(), sample()]]) {
    assert.equal(summarizeSamples(samples).status, 'invalid');
  }
});

test('추천은 계열의 검증된 통과 모델만 사용하며 다른 계열·구버전·미지 모델은 무시한다', () => {
  const results = [result(MODELS[0].id), result(MODELS[0].id, [sample(6000), sample(), sample()])];
  assert.equal(recommendModel(results, 'Gemma 4').id, MODELS[0].id);
  assert.equal(recommendModel([result(MODELS[0].id, [sample(6000), sample(), sample()])], 'Gemma 4'), null, '기준 미달은 추천하지 않음');
  assert.equal(recommendModel(results, 'Qwen3'), null, '없는 계열은 빈 목록');
  assert.equal(modelById(LEGACY_GEMMA2.id), undefined);
  assert.equal(recommendModel([result(LEGACY_GEMMA2.id)], 'Gemma 2'), null);
  assert.equal(recommendModel([{ ...results[0], version: 'old' }, { modelId: 'arbitrary-model', version: BENCHMARK.version, samples: [] }], 'Gemma 4'), null);
});

test('네트워크·저장공간·취소·GPU 오류를 응답 속도 미달과 구분한다', () => {
  assert.equal(describeError(new Error('Failed to fetch')).status, 'error');
  assert.match(describeError(new Error('Failed to fetch')).reason, /사양 부족 판정은 아닙니다/);
  assert.match(describeError(new Error('QuotaExceededError')).reason, /저장 공간/);
  assert.match(describeError(new Error('GPU device lost')).reason, /메모리 부족일 수/);
  assert.equal(describeError(errorWithCode('hidden', '백그라운드')).status, 'cancelled');
  assert.equal(describeError(errorWithCode('generation_timeout', '시간 초과')).status, 'slow');
});

test('GPU 감지는 VRAM을 추측하지 않고 비공개 정보·미지원 환경에서도 안전하다', async () => {
  const base = { userAgent: 'test', storage: { estimate: async () => ({ usage: 10, quota: 100 }) } };
  const adapter = { features: new Set(['shader-f16']), limits: { ...WEBGPU_LIMITS } };
  const env = await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => adapter } }, true);
  assert.equal(env.supported, true);
  assert.equal(env.gpu, 'GPU 정보 비공개');
  assert.equal(env.memoryGB, null);
  assert.equal(env.limits.maxBufferSize, WEBGPU_LIMITS.maxBufferSize);
  assert.equal(env.vram, null);
  assert.match(env.vramReason, /공개하지 않습니다/);
  assert.equal(env.browser, '확인 불가');
  assert.equal((await inspectEnvironment(base, true)).supported, false);
  assert.match((await inspectEnvironment(base, false)).reason, /HTTPS/);
  assert.equal((await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => null } }, true)).supported, false);
  assert.equal((await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => ({ ...adapter, features: new Set() }) } }, true)).engines.webllm.supported, false);
  assert.equal((await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => ({ ...adapter, info: { isFallbackAdapter: true } }) } }, true)).supported, false);
  assert.match((await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => { throw Error('blocked'); } } }, true)).reason, /GPU 확인 실패/);
  assert.equal((await inspectEnvironment({ ...base, gpu: { requestAdapter: async () => ({ ...adapter, info: { type: 'software' } }) } }, true)).supported, false);
});

test('페이지 스레드 캐시 조회·삭제는 종류별로 분리되고 unrelated 캐시를 건드리지 않는다', async () => {
  assert.deepEqual(CACHE_NAMES, ['webllm/model', 'webllm/config', 'webllm/wasm', LITERT_CACHE]);
  assert.match(ENGINE_GUIDANCE.webllm, /Firefox/);
  const weightURL = modelURL(MODELS[0]);
  const weights = new Map([[weightURL, 2000]]);
  const runtime = new Map([['https://cdn.test/wasm/litert.wasm', 500]]);
  const opened = [];
  const open = name => {
    opened.push(name);
    const store = name === LITERT_CACHE ? weights : name === 'webllm/wasm' ? runtime : new Map();
    return {
      keys: async () => [...store.keys()].map(url => ({ url })),
      match: async request => ({ headers: { get: () => String(store.get(request.url) ?? 0) } }),
      delete: async request => store.delete(request.url),
    };
  };
  const caches = { keys: async () => [LITERT_CACHE, 'webllm/wasm', 'unrelated-cache'], open };
  const scanned = await inspectModelCaches({ caches });
  assert.equal(scanned.counts[MODELS[0].id], 1);
  assert.equal(scanned.bytes[MODELS[0].id], 2000);
  assert.equal(scanned.runtimeBytes, 500);
  assert.ok(!opened.includes('unrelated-cache'), 'unrelated 캐시는 열지 않음');
  const afterWeights = await deleteModelCaches({ caches, modelId: MODELS[0].id, scope: 'weights' });
  assert.equal(afterWeights.counts[MODELS[0].id], 0);
  assert.equal(weights.size, 0, '가중치 삭제');
  assert.equal(runtime.size, 1, '가중치 삭제에 실행 파일 유지');
  await deleteModelCaches({ caches, scope: 'runtime' });
  assert.equal(runtime.size, 0, '실행 파일 삭제');
});

test('런타임 한도 9/10을 다운로드 전에 감지하고 API 한도와 속도 미달을 구분한다', async () => {
  const adapter = { features: new Set(['shader-f16']), limits: { ...WEBGPU_LIMITS, maxStorageBuffersPerShaderStage: 9 } };
  const env = await inspectEnvironment({ gpu: { requestAdapter: async () => adapter } }, true);
  assert.equal(env.supported, true, 'LiteRT 경로는 WebLLM의 10개 요구로 차단하지 않음');
  assert.equal(env.engines.webllm.supported, false);
  assert.equal(env.limits.maxStorageBuffersPerShaderStage, 9);
  assert.match(env.engines.webllm.reason, /maxStorageBuffersPerShaderStage 현재 9 \/ 필요 10/);
  assert.match(env.engines.webllm.reason, /작은 모델로 바꿔도/);
  const raw = new Error('Cannot initialize runtime because of requested maxStorageBuffersPerShaderStage exceeds limit. requested=10, limit=9.');
  assert.equal(describeError(raw).status, 'unsupported');
  assert.equal(describeError(raw).reason, gpuLimitReason('maxStorageBuffersPerShaderStage', 9));
  for (const [key, value] of Object.entries(WEBGPU_LIMITS)) {
    assert.equal(runtimeCompatibility({ ...adapter, limits: { ...WEBGPU_LIMITS } }), null);
    assert.match(runtimeCompatibility({ ...adapter, limits: { ...WEBGPU_LIMITS, [key]: value - 1 } }), new RegExp(key));
    assert.match(runtimeCompatibility({ ...adapter, limits: { ...WEBGPU_LIMITS, [key]: undefined } }), /확인 불가/);
  }
  const runtime = await readFile(new URL('./node_modules/@mlc-ai/web-llm/lib/index.js', import.meta.url), 'utf8');
  assert.match(runtime, /requiredMaxStorageBuffersPerShaderStage = 10;/, 'WebLLM 업그레이드 시 공통 사전 검사도 검토해야 함');
});

test('실행 환경 비호환은 다른 크기 모델을 다운로드하지 않고 성능 추천에서 제외한다', async () => {
  const requests = [];
  const client = { stop() {}, async request(action) {
    requests.push(action);
    throw errorWithCode('webgpu_unsupported', gpuLimitReason('maxStorageBuffersPerShaderStage', 9));
  } };
  const results = await benchmarkModels(client, MODELS, () => {});
  assert.deepEqual(requests, ['load']);
  assert.equal(results[0].status, 'unsupported');
  assert.equal(recommendModel(results, 'Gemma 4'), null);
});

function fakeWorker() {
  return { terminated: false, posted: [], postMessage(data) { this.posted.push(data); }, terminate() { this.terminated = true; }, emit(data) { this.onmessage({ data }); } };
}

test('취소는 Worker와 타이머를 종료하며 이전 응답이 새 요청을 덮어쓰지 않는다', async () => {
  const workers = [];
  const client = new LocalAIClient(() => { const worker = fakeWorker(); workers.push(worker); return worker; });
  const pending = client.request('load', { modelId: MODELS[0].id });
  await assert.rejects(client.request('cache'), error => error.code === 'busy');
  const rejected = assert.rejects(pending, error => error.code === 'cancelled');
  client.stop();
  await rejected;
  assert.ok(workers[0].terminated);
  const next = client.request('load', { modelId: MODELS[0].id });
  workers[0].emit({ id: 1, done: true, result: { loadMs: 2 } });
  assert.equal(client.loaded, null);
  workers[1].emit({ id: 2, done: true, result: { loadMs: 3 } });
  assert.equal((await next).loadMs, 3);
  assert.equal(client.loaded, MODELS[0].id);
  client.stop();
});

test('첫 답변 제한은 추론 시작부터 적용하고 공백 청크는 첫 답변으로 세지 않는다', async () => {
  const worker = fakeWorker();
  const client = new LocalAIClient(() => worker);
  const pending = client.request('generate', {}, { firstMs: 15, timeoutMs: 1000 });
  const rejected = assert.rejects(pending, error => error.code === 'first_timeout');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(worker.terminated, false, '로드·초기화 대기는 첫 토큰 시간에 포함하지 않음');
  worker.emit({ id: 1, event: 'started' });
  worker.emit({ id: 1, event: 'token', text: '  ' });
  await rejected;
  assert.ok(worker.terminated);
});

test('첫 실제 출력은 첫 토큰 타이머를 해제하며 Worker 오류도 요청을 정리한다', async () => {
  const worker = fakeWorker();
  const client = new LocalAIClient(() => worker);
  const pending = client.request('generate', {}, { firstMs: 15, timeoutMs: 1000 });
  worker.emit({ id: 1, event: 'started' });
  worker.emit({ id: 1, event: 'token', text: '안녕' });
  await new Promise(resolve => setTimeout(resolve, 25));
  worker.emit({ id: 1, done: true, result: sample() });
  assert.equal((await pending).ttftMs, 1500);
  const crashed = client.request('cache');
  const rejected = assert.rejects(crashed, error => error.code === 'worker');
  worker.onerror();
  await rejected;
  assert.equal(client.pending, null);
});

test('계단식 측정은 워밍업 후 3회 수행하고 기준 미달 다음 모델은 다운로드하지 않는다', async () => {
  const loads = [];
  const calls = [];
  const client = { stop() {}, async request(action, payload, options) {
    calls.push({ action, payload, options });
    if (action === 'load') { loads.push(payload.modelId); return { loadMs: 60000 }; }
    return loads.length === 1 ? sample(1500, 5) : sample(1500, 4);
  } };
  const updates = [];
  // 계열 필터 없이 실제 목록(MODELS)을 그대로 측정한다. 현재 후보는 Gemma 4 E2B 하나.
  const results = await benchmarkModels(client, MODELS, update => updates.push(update));
  assert.equal(loads.length, 1);
  assert.deepEqual(results.map(entry => entry.status), ['comfortable']);
  assert.equal(calls.filter(call => call.action === 'generate').length, 4);
  assert.equal(calls[1].options.firstMs, undefined, '워밍업은 5초 제한에서 제외');
  assert.equal(calls[2].options.firstMs, 5000);
  assert.ok(calls.filter(call => call.action === 'generate').every(call => call.payload.characterId === undefined), '벤치마크에는 캐릭터를 주입하지 않음');
  assert.equal(recommendModel(results, 'Gemma 4').id, MODELS[0].id);
  assert.equal(updates.filter(update => update.phase === 'result').length, 1);
});

test('벤치마크 취소는 불완전 샘플이나 추천 결과를 기록하지 않는다', async () => {
  let stopCalls = 0;
  const client = { stop() { stopCalls++; }, async request(action) {
    if (action === 'load') return { loadMs: 2 };
    throw errorWithCode('hidden', '백그라운드');
  } };
  const updates = [];
  await assert.rejects(benchmarkModels(client, MODELS, update => updates.push(update)), error => error.code === 'hidden');
  assert.equal(updates.filter(update => update.phase === 'result').length, 0);
  assert.ok(stopCalls >= 2);
});

test('업데이트된 모델 목록에서 webllm 로드는 막히고 이전 Gemma 2 삭제는 유지된다', async () => {
  const source = (await readFile(new URL('./local-ai-worker.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const posted = [];
  const fake = { postMessage: message => posted.push(message) };
  // Gemma 4는 LiteRT 한 모델이므로 webllm 프로토콜 검사는 목록 전체에 남은 이전 Gemma 2 삭제만 확인한다.
  const deleted = [];
  const legacy = modelURL(LEGACY_GEMMA2) + 'params_shard_0.bin';
  const wasm = model => `https://raw.githubusercontent.com/test/${model.id}.wasm`;
  const keys = [{ url: legacy }, { url: wasm(LEGACY_GEMMA2) }, { url: 'https://unrelated.test/private' }];
  runInNewContext(source, {
    self: fake, MODELS, LEGACY_GEMMA2, BENCHMARK, LITERT_CACHE, modelURL, modelById, characterById, chatMessagesFor, errorWithCode, performance,
    prebuiltAppConfig: { model_list: [LEGACY_GEMMA2].map(model => ({ model_id: model.id, model_lib: wasm(model) })) },
    caches: { keys: async () => ['webllm/model', 'unrelated-cache'], open: async name => {
      assert.equal(name, 'webllm/model');
      return { keys: async () => keys, match: async () => ({ headers: { get: () => null } }), delete: async request => deleted.push(request.url) };
    } },
  });
  await fake.onmessage({ data: { id: 1, action: 'load', modelId: 'not-in-list.test' } });
  assert.match(posted.find(message => message.id === 1).error.message, /지원하지 않는 모델/, 'webllm 로드 대상은 없음');
  await fake.onmessage({ data: { id: 4, action: 'load', modelId: 'https://untrusted.test/model' } });
  assert.match(posted.find(message => message.id === 4).error.message, /지원하지 않는 모델/);
  await fake.onmessage({ data: { id: 6, action: 'cache' } });
  assert.ok(posted.find(message => message.id === 6).result, '비호환 환경에서도 캐시 관리는 사용 가능');
  assert.equal(posted.find(message => message.id === 6).result.counts[LEGACY_GEMMA2.id], 2);
  await fake.onmessage({ data: { id: 7, action: 'load', modelId: LEGACY_GEMMA2.id } });
  assert.match(posted.find(message => message.id === 7).error.message, /지원하지 않는 모델/);
  await fake.onmessage({ data: { id: 8, action: 'delete', modelId: LEGACY_GEMMA2.id } });
  assert.deepEqual(deleted, [legacy, wasm(LEGACY_GEMMA2)], '제외한 Gemma 2 가중치·WASM은 삭제만 허용');
});

test('고정 LiteRT 배포본은 어댑터 한도 9를 그대로 요청한다 (GPU 추론 모사가 아님)', async () => {
  const source = (await readFile(new URL('./node_modules/@litert-lm/core/dist/litertlm_web.js', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  let requested;
  const adapter = { limits: { ...WEBGPU_LIMITS, maxStorageBuffersPerShaderStage: 9, maxTextureDimension2D: 8192 }, features: new Set(['shader-f16']),
    async requestDevice(options) { requested = options; return {}; } };
  const LiteRtLm = runInNewContext(source + '\nLiteRtLm;', { navigator: { gpu: { requestAdapter: async () => adapter } } });
  await new LiteRtLm({ setupLogging() {} }).setupDefaultWebGpuDevice();
  assert.equal(requested.requiredLimits.maxStorageBuffersPerShaderStage, 9);
  assert.equal(runtimeCompatibility(adapter, 'litert'), null);
});

test('LiteRT Worker는 스트림 캐시·새 대화·실제 토큰 통계·엔진별 삭제를 사용한다', async () => {
  const source = (await readFile(new URL('./local-ai-worker.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const models = MODELS.map(model => model.engine === 'litert' ? { ...model, bytes: 3 } : model);
  const posted = [], configs = [], fetches = [], sequence = [];
  const store = new Map();
  const otherURL = 'https://test.local/cache/webllm-model/params_shard_0.bin';
  let downloadedBytes = 3;
  let disposed = 0;
  const cache = {
    match: async url => store.has(url) ? new Response(store.get(url)) : undefined,
    put: async (url, response) => { store.set(url, await response.arrayBuffer()); },
    keys: async () => [...store.keys()].map(url => ({ url })),
    delete: async request => store.delete(request.url),
  };
  const fake = { postMessage: message => posted.push(message), location: { origin: 'https://test.local' } };
  runInNewContext(source, {
    self: fake, MODELS: models, LEGACY_GEMMA2, BENCHMARK, LITERT_ASSET_PATH, LITERT_CACHE, modelURL,
    modelById: id => models.find(model => model.id === id), characterById, chatMessagesFor, chatMessagesWithReferences,
    normalizeMemories, normalizeExcerpts, referenceChars, errorWithCode, performance,
    URL, Response, TransformStream,
    prebuiltAppConfig: { model_list: MODELS.filter(model => model.engine === 'webllm').map(model => ({ model_id: model.id })) },
    inspectEnvironment: async () => ({ engines: { webllm: { supported: false }, litert: { supported: true } } }),
    getOrLoadGlobalLiteRtLm: async url => {
      assert.equal(url, 'https://test.local' + LITERT_ASSET_PATH);
      assert.equal(fake.Module.locateFile('x.wasm'), url + 'x.wasm');
      return { setupDefaultWebGpuDevice: async () => sequence.push('device') };
    },
    fetch: async url => { sequence.push('download'); fetches.push(url); return new Response(new Uint8Array(downloadedBytes)); },
    caches: { keys: async () => [LITERT_CACHE, 'webllm/model'], open: async name => name === LITERT_CACHE ? cache : {
      keys: async () => [{ url: otherURL }], delete: async () => assert.fail('다른 엔진 캐시는 유지해야 함'),
    } },
    Backend: { GPU_ARTISAN: 3 },
    LiteRTEngine: { create: async options => {
      sequence.push('engine');
      assert.equal(options.backend, 3);
      assert.equal(options.benchmarkEnabled, true);
      assert.equal(options.mainExecutorSettings.maxNumTokens, BENCHMARK.context);
      assert.equal((await new Response(options.model).arrayBuffer()).byteLength, 3);
      return { delete: async () => {}, createConversation: async config => {
        configs.push(config);
        return {
          async *sendMessageStreaming(message) {
            assert.equal(message.content, '새 질문');
            yield { channels: { analysis: '비공개 추론' } };
            yield { content: [{ type: 'text', text: '안녕' }] };
            yield { content: '하세요' };
          },
          getBenchmarkInfo: async () => ({ lastDecodeTokenCount: 23, lastDecodeTokensPerSecond: 17.5, timeToFirstTokenInSecond: 999 }),
          delete: async () => { disposed++; },
        };
      } };
    } },
  });
  const request = async (id, action, payload = {}) => {
    await fake.onmessage({ data: { id, action, ...payload } });
    return posted.find(message => message.id === id && message.done);
  };
  assert.ok((await request(1, 'load', { modelId: DEFAULT_MODEL_ID })).result);
  assert.deepEqual(sequence, ['device', 'download', 'engine']);
  assert.ok((await request(2, 'load', { modelId: DEFAULT_MODEL_ID })).result);
  assert.equal(fetches.length, 1, '완료한 캐시는 다시 다운로드하지 않음');
  const messages = [{ role: 'user', content: '이전 질문' }, { role: 'assistant', content: '이전 답' }, { role: 'user', content: '새 질문' }];
  for (const id of [3, 4]) {
    const response = await request(id, 'generate', { messages, maxTokens: 96 });
    assert.equal(response.result.text, '안녕하세요');
    assert.equal(response.result.tokens, 23, '출력 청크 수 대신 엔진 토큰 수');
    assert.equal(response.result.tokensPerSecond, 17.5);
    assert.ok(response.result.ttftMs < 999000, '엔진의 첫 내부 토큰 대신 화면에 보이는 답변 측정');
  }
  assert.equal(configs.length, 2, '매 샘플마다 새 대화·KV 상태');
  assert.equal(disposed, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(configs[0].preface.messages)), messages.slice(0, -1));
  assert.equal(configs[0].preface.extra_context.enable_thinking, false);
  assert.equal(configs[0].prefillPrefaceOnInit, false);
  assert.equal(configs[0].sessionConfig.maxOutputTokens, 96);
  for (const [index, character] of CHARACTERS.entries()) {
    const response = await request(7 + index, 'generate', { messages, characterId: character.id, maxTokens: 128 });
    assert.equal(response.result.text, '안녕하세요');
    const config = configs[index + 2];
    assert.deepEqual(JSON.parse(JSON.stringify(config.preface.messages)), chatMessagesFor(character.id, messages).slice(0, -1));
    assert.equal(config.sessionConfig.maxOutputTokens, 128);
  }
  assert.equal(disposed, 2 + CHARACTERS.length);
  // 참고 자료(기억·발췌)는 Worker가 system 블록으로 조립하며, 임의 system 입력 경로는 없다.
  const withReferences = await request(90, 'generate', { messages, characterId: CHARACTERS[0].id, maxTokens: 128,
    memories: [{ id: 'm1', text: '선생님은 커피를 좋아해' }], excerpts: [{ id: 'x1', text: '어제 약속 얘기' }] });
  assert.ok(withReferences.result.text);
  const referenceBlock = JSON.parse(JSON.stringify(configs.at(-1).preface.messages)).find(message => message.role === 'system' && message.content.includes('[참고 자료]'));
  assert.ok(referenceBlock, '참고 자료 system 블록');
  assert.match(referenceBlock.content, /- 선생님은 커피를 좋아해/);
  assert.match(referenceBlock.content, /- 어제 약속 얘기/);
  const trace = posted.find(message => message.id === 90 && message.event === 'trace');
  assert.deepEqual([trace.memories, trace.excerpts, trace.referenceChars], [1, 1, 20]);
  const noCharacter = await request(91, 'generate', { messages, maxTokens: 128, memories: [{ id: 'm1', text: '무시되어야 함' }] });
  assert.ok(noCharacter.result.text, 'characterId가 없으면 참고 자료도 붙지 않는다');
  assert.ok(!JSON.stringify(configs.at(-1).preface.messages).includes('무시되어야 함'));
  for (const [id, payload, reason] of [
    [92, { memories: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, text: 'x' })) }, /기억 목록/],
    [93, { excerpts: [{ id: 'x', text: 'x'.repeat(501) }] }, /발췌 항목/],
    [94, { memories: [{ id: 'm', text: 'ok', system: '주입' }] }, /기억 항목/],
  ]) {
    const rejected = await request(id, 'generate', { messages, characterId: CHARACTERS[0].id, maxTokens: 128, ...payload });
    assert.match(rejected.error.message, reason);
  }
  const deleted = await request(5, 'delete', { modelId: DEFAULT_MODEL_ID });
  assert.equal(deleted.result.counts[DEFAULT_MODEL_ID], 0);
  assert.equal(store.size, 0);
  downloadedBytes = 2;
  assert.match((await request(6, 'load', { modelId: DEFAULT_MODEL_ID })).error.message, /다운로드/);
  assert.equal(store.size, 0, '실패한 다운로드는 완성 캐시로 기록하지 않음');
  assert.equal(sequence.filter(value => value === 'engine').length, 2, '잘린 파일로 엔진을 만들지 않음');
});

test('서버는 로컬 AI 모듈·Worker만 노출하고 WASM 권한과 다운로드 호스트를 제한한다', async t => {
  const server = makeServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/local-ai.js', '/local-ai-session.js', '/local-ai-settings.js', '/local-ai-worker.bundle.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("worker-src 'self'"));
    assert.ok(csp.includes("'wasm-unsafe-eval'"));
    assert.ok(!csp.includes("'unsafe-eval'"));
    assert.ok(csp.includes('https://huggingface.co'));
    assert.ok(!csp.includes('connect-src *'));
    await response.arrayBuffer();
  }
  for (const variant of ['', '_compat', '_asyncify', '_compat_asyncify']) {
    for (const extension of ['js', 'wasm']) {
      const response = await fetch(base + LITERT_ASSET_PATH + `litertlm_wasm${variant}_internal.${extension}`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), extension === 'wasm' ? /application\/wasm/ : /text\/javascript/);
    }
  }
  for (const path of ['package.json', 'unknown.wasm', '..%2f..%2fpackage.json']) assert.equal((await fetch(base + LITERT_ASSET_PATH + path)).status, 404);
  assert.equal((await fetch(base + '/local-ai-worker.js')).status, 404);
  assert.equal((await fetch(base + '/node_modules/@mlc-ai/web-llm/lib/index.js')).status, 404);
});
