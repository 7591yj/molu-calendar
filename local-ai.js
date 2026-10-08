// Pinned, reviewed model artifacts only. No arbitrary URLs or user-supplied WASM.
export const MODELS = [
  { id: 'gemma-4-E2B-it-web', name: 'Gemma 4 E2B', engine: 'litert', family: 'Gemma 4', rank: 1, bytes: 2008432640, memoryMB: 1800, revision: 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1' },
];
// Retained only to delete old downloads; never offered for loading or recommendation.
export const LEGACY_GEMMA2 = { id: 'gemma-2-2b-it-q4f16_1-MLC', engine: 'webllm', revision: 'de9cc76f0d4b3a49a0f718df424944054bf1eec1' };
export const DEFAULT_MODEL_ID = 'gemma-4-E2B-it-web';
export { PERSONAS as CHARACTERS, personaById as characterById, chatMessagesFor, chatMessagesWithReferences,
  normalizeMemories, normalizeExcerpts, referenceChars, promptCharsFor } from './persona.js';
export const LITERT_ASSET_PATH = '/vendor/litert-lm/0.17.1/';
export const LITERT_CACHE = 'molu/litert-model-v1';
export const ENGINE_NAMES = { webllm: 'WebLLM', litert: 'LiteRT-LM' };
export const BENCHMARK = Object.freeze({ version: 'webllm-0.2.85-litert-0.17.1-ko-v3', context: 4096, firstMs: 5000, comfortableMs: 3000, minTps: 5, samples: 3, minTokens: 16, maxTokens: 96 });
// TVM detectGPUDevice() minima in the pinned WebLLM 0.2.85 runtime, before any model loads.
// Buffer sizes are API limits, NOT installed/free VRAM. Do not clamp runtime requests to hide failures.
export const WEBGPU_LIMITS = Object.freeze({
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 32768,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
});
export function gpuLimitReason(key, available, required = WEBGPU_LIMITS[key]) {
  return `현재 브라우저/GPU의 WebGPU 실행 한도가 부족합니다: ${key} 현재 ${available} / 필요 ${required}. ` +
    'VRAM 용량이나 생성 속도의 문제가 아니며, 작은 모델로 바꿔도 현재 WebLLM 엔진은 실행되지 않습니다. ' +
    '최신 Chrome/Edge 등 다른 GPU 가속 브라우저에서 다시 확인해 주세요. 앱에서 이 한도를 올릴 수는 없습니다.';
}
export const ENGINE_GUIDANCE = Object.freeze({
  webllm: 'WebLLM: Chromium(WebGPU shader-f16 + 저장 버퍼 10개)이 필요합니다. Firefox·Safari에서는 실행되지 않습니다.',
  litert: 'LiteRT-LM: Chromium WebGPU가 필요합니다. Safari 26+는 WebGPU를 지원하지만 어댑터 정보 공개가 제한적이라 실측이 필요합니다.',
});
export function runtimeCompatibility(adapter, engine = 'webllm') {
  if (adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? (adapter.info?.type === 'software' || adapter.type === 'software')) return '소프트웨어 GPU 어댑터는 지원하지 않습니다. GPU 가속 브라우저에서 다시 확인해 주세요.';
  // LiteRT requests the adapter's limits, not TVM's minima. Model execution still needs testing.
  if (engine === 'litert') return null;
  if (!adapter.features.has('shader-f16')) return '현재 모델에 필요한 GPU의 shader-f16 기능을 사용할 수 없습니다. CPU 실행은 이번 버전에 포함되지 않습니다.';
  for (const [key, minimum] of Object.entries(WEBGPU_LIMITS)) {
    const value = adapter.limits?.[key];
    if (!Number.isFinite(value) || value < minimum) return gpuLimitReason(key, Number.isFinite(value) ? value : '확인 불가');
  }
  return null;
}

export const MODEL_OVERHEAD_BYTES = 50 * 1024 * 1024; // tokenizer, WASM, configs; estimate, not a quota guarantee
export const modelCardURL = model => model.engine === 'litert'
  ? 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm' : `https://huggingface.co/mlc-ai/${model.id}`;
export const modelURL = model => `${modelCardURL(model)}/resolve/${model.revision}/${model.engine === 'litert' ? `${model.id}.litertlm` : ''}`;
export const modelById = id => MODELS.find(model => model.id === id);
export const errorWithCode = (code, message) => Object.assign(new Error(message), { code });
export const CACHE_MODELS = [...MODELS, LEGACY_GEMMA2];
export const CACHE_NAMES = ['webllm/model', 'webllm/config', 'webllm/wasm', LITERT_CACHE];
const cacheModelFor = (name, url, modelLib) => CACHE_MODELS.find(candidate => name === LITERT_CACHE
  ? candidate.engine === 'litert' && url === modelURL(candidate)
  : candidate.engine === 'webllm' && (url.startsWith(modelURL(candidate)) || url === modelLib?.get(candidate.id)));
// Page-thread Cache Storage scan. Worker 없이 기기 확인·정리에서 바로 쓴다.
// scope: 'weights' | 'runtime' | undefined. unrelated origin 캐시는 건드리지 않는다.
export async function inspectModelCaches({ caches: cacheStorage = globalThis.caches, modelLib = new Map() } = {}) {
  const counts = Object.fromEntries(CACHE_MODELS.map(model => [model.id, 0]));
  const bytes = Object.fromEntries(CACHE_MODELS.map(model => [model.id, 0]));
  let runtimeBytes = 0;
  let runtimeFiles = 0;
  if (!cacheStorage) throw new Error('이 브라우저에서 모델 캐시를 사용할 수 없습니다.');
  for (const name of await cacheStorage.keys()) {
    if (!CACHE_NAMES.includes(name)) continue;
    const cache = await cacheStorage.open(name);
    for (const request of await cache.keys()) {
      const model = cacheModelFor(name, request.url, modelLib);
      const isRuntime = name === 'webllm/wasm' || (name === 'webllm/config' && !model);
      if (!model && !isRuntime) continue;
      const isWeights = Boolean(model) && (name === LITERT_CACHE || name === 'webllm/model');
      let size = 0;
      try {
        const response = await cache.match(request);
        size = Number(response?.headers?.get('content-length'));
        if (!Number.isFinite(size)) size = 0;
      } catch { size = 0; }
      if (model && isWeights) { counts[model.id]++; bytes[model.id] += size; }
      else if (isRuntime) { runtimeFiles++; runtimeBytes += size; }
    }
  }
  return { counts, bytes, runtimeBytes, runtimeFiles };
}
export async function deleteModelCaches({ caches: cacheStorage = globalThis.caches, modelLib = new Map(), modelId = null, scope } = {}) {
  if (scope === 'runtime') {
    if (!cacheStorage) throw new Error('이 브라우저에서 모델 캐시를 사용할 수 없습니다.');
    for (const name of ['webllm/wasm', 'webllm/config']) {
      if (!(await cacheStorage.keys()).includes(name)) continue;
      const cache = await cacheStorage.open(name);
      for (const request of await cache.keys()) {
        if (name === 'webllm/config' && cacheModelFor(name, request.url, modelLib)) continue;
        await cache.delete(request);
      }
    }
    return inspectModelCaches({ caches: cacheStorage, modelLib });
  }
  if (!CACHE_MODELS.some(model => model.id === modelId)) throw new Error('지원하지 않는 모델입니다.');
  if (!cacheStorage) throw new Error('이 브라우저에서 모델 캐시를 사용할 수 없습니다.');
  for (const name of await cacheStorage.keys()) {
    if (!CACHE_NAMES.includes(name)) continue;
    const cache = await cacheStorage.open(name);
    for (const request of await cache.keys()) {
      const model = cacheModelFor(name, request.url, modelLib);
      if (model?.id !== modelId) continue;
      const isWeights = name === LITERT_CACHE || name === 'webllm/model';
      if (scope && (scope === 'weights' ? !isWeights : isWeights)) continue;
      await cache.delete(request);
    }
  }
  return inspectModelCaches({ caches: cacheStorage, modelLib });
}
export const gb = bytes => Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(2)} GB` : '확인 불가';
export function modelConsentText(models, storage) {
  const bytes = models.reduce((sum, model) => sum + model.bytes + MODEL_OVERHEAD_BYTES, 0);
  const free = storage?.quota - storage?.usage;
  return `${models.map(model => model.name).join(' → ')}\n\n최대 약 ${gb(bytes)}를 다운로드합니다. 기존 캐시는 재사용하며, 최초 준비에는 시간이 걸릴 수 있습니다. 모델 카드의 이용 조건을 확인해 주세요.\n${models.map(modelCardURL).join('\n')}${Number.isFinite(free) && free < bytes ? '\n\n주의: 브라우저 저장 여유가 예상 다운로드량보다 적습니다.' : ''}\n\n다운로드·실행을 시작할까요?`;
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length !== BENCHMARK.samples || samples.some(sample =>
    !sample || !Number.isFinite(sample.ttftMs) || sample.ttftMs < 0 ||
    !Number.isFinite(sample.tokensPerSecond) || sample.tokensPerSecond <= 0 ||
    !Number.isInteger(sample.tokens) || sample.tokens < BENCHMARK.minTokens)) {
    return { status: 'invalid', reason: '측정 토큰 또는 통계가 부족합니다. 다시 측정해 주세요.' };
  }
  const median = key => [...samples].sort((a, b) => a[key] - b[key])[1][key];
  const ttftMs = median('ttftMs');
  const tokensPerSecond = median('tokensPerSecond');
  const status = samples.some(sample => sample.ttftMs > BENCHMARK.firstMs) || tokensPerSecond < BENCHMARK.minTps
    ? 'slow' : ttftMs > BENCHMARK.comfortableMs ? 'usable' : 'comfortable';
  return { status, ttftMs, tokensPerSecond };
}

export function recommendModel(results, family) {
  // Speed qualifies a candidate; it is not a character-chat quality ranking.
  return MODELS.filter(model => model.family === family && results.some(result =>
    result && result.modelId === model.id && result.version === BENCHMARK.version &&
    ['comfortable', 'usable'].includes(summarizeSamples(result.samples ?? []).status)))
    .sort((a, b) => b.rank - a.rank)[0] ?? null;
}

export function describeError(error) {
  const message = String(error?.message ?? error);
  if (error?.code === 'webgpu_unsupported') return { status: 'unsupported', reason: message };
  const limit = message.match(/requested (\w+)\s+exceeds limit\.\s*requested=([^,]+),\s*limit=([^\s.]+)/);
  if (limit && Object.hasOwn(WEBGPU_LIMITS, limit[1])) return { status: 'unsupported', reason: gpuLimitReason(limit[1], limit[3], limit[2].trim()) };
  if (error?.code === 'cancelled' || error?.code === 'hidden') return { status: 'cancelled', reason: message };
  if (error?.code === 'first_timeout' || error?.code === 'generation_timeout') return { status: 'slow', reason: message };
  if (error?.code === 'empty_output') return { status: 'invalid', reason: '답변 또는 토큰 통계를 얻지 못했습니다. 다시 측정해 주세요.' };
  if (/quota|disk|storage.*full/i.test(message)) return { status: 'error', reason: '브라우저 저장 공간이 부족하거나 저장이 차단되었습니다.' };
  if (/out of memory|oom|device.?lost|gpu.*lost|allocation/i.test(message)) return { status: 'error', reason: 'GPU 오류가 발생했습니다. 메모리 부족일 수 있습니다. 다른 GPU 작업을 닫거나 작은 모델로 다시 시도하세요.' };
  if (/fetch|network|http|download|CORS/i.test(message)) return { status: 'error', reason: '모델 다운로드에 실패했습니다. 네트워크·보안 정책을 확인하세요. 사양 부족 판정은 아닙니다.' };
  return { status: 'error', reason: `실행 오류: ${message.slice(0, 240)}` };
}

export async function inspectEnvironment(nav = navigator, secure = isSecureContext) {
  const ua = nav.userAgent ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? 'Safari' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : '확인 불가';
  const result = { supported: false, browser, gpu: '확인 불가', vram: null, vramReason: '브라우저 API는 설치된 VRAM 용량과 남은 GPU 메모리를 공개하지 않습니다. 모델 추정치와 저장 여유로 판단해 주세요.', memoryGB: nav.deviceMemory ?? null, memoryReason: nav.deviceMemory ? null : '이 브라우저가 시스템 RAM 용량을 공개하지 않았습니다 (Safari/Firefox는 미지원).', cores: nav.hardwareConcurrency ?? null, features: [], limits: {}, engines: {} };
  try {
    const storage = await nav.storage?.estimate();
    result.storage = storage ? { quota: storage.quota, usage: storage.usage } : null;
  } catch { result.storage = null; }
  if (!secure) result.reason = 'HTTPS 또는 localhost에서 열어 주세요.';
  else if (!nav.gpu) result.reason = '이 브라우저에서 WebGPU를 사용할 수 없습니다. GPU 가속이 켜진 최신 Chrome/Edge를 확인해 주세요.';
  else {
    try {
      let timer;
      let adapter;
      try {
        adapter = await Promise.race([
          nav.gpu.requestAdapter({ powerPreference: 'high-performance' }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GPU 확인 시간 초과. 다시 확인해 주세요.')), 10000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!adapter) result.reason = '사용 가능한 GPU 어댑터가 없습니다. 브라우저 GPU 가속과 드라이버를 확인해 주세요.';
      else {
        const info = adapter.info;
        result.gpu = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' · ') || 'GPU 정보 비공개';
        result.features = [...adapter.features];
        result.limits = Object.fromEntries(Object.keys(WEBGPU_LIMITS).map(key => [key, adapter.limits?.[key]]));
        for (const engine of Object.keys(ENGINE_NAMES)) {
          const reason = runtimeCompatibility(adapter, engine);
          result.engines[engine] = { supported: reason === null, reason };
        }
        result.supported = Object.values(result.engines).some(engine => engine.supported);
        result.reason = result.supported ? null : result.engines.webllm.reason;
      }
    } catch (error) { result.reason = `GPU 확인 실패: ${String(error.message).slice(0, 160)}`; }
  }
  result.fingerprint = JSON.stringify([BENCHMARK.version, MODELS.map(model => [model.id, model.revision]), nav.userAgent, result.gpu, result.features.slice().sort(), result.limits]);
  return result;
}

// A single worker owns a single model. Termination also cancels stalled GPU/download work.
export class LocalAIClient {
  // LiteRT's pinned loader uses importScripts, so this bundle must be a classic Worker.
  constructor(workerFactory = () => new Worker(new URL(`${(import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/')}local-ai-worker.bundle.js`, globalThis.location.href))) {
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = null;
    this.nextId = 0;
    this.loaded = null;
  }
  request(action, payload = {}, { onEvent = () => {}, firstMs = 0, timeoutMs = 60000, timeoutCode = 'operation_timeout' } = {}) {
    if (this.pending) return Promise.reject(errorWithCode('busy', '이미 실행 중인 작업이 있습니다.'));
    if (!this.worker) {
      try {
        this.worker = this.workerFactory();
        this.worker.onmessage = ({ data }) => {
          const pending = this.pending;
          if (!pending || data.id !== pending.id) return;
          if (data.event) {
            if (data.event === 'started' && pending.firstMs) {
              clearTimeout(pending.firstTimer);
              pending.firstTimer = setTimeout(() => this.stop(errorWithCode('first_timeout', '첫 답변이 5초 안에 표시되지 않아 채팅 응답 기준에 미달했습니다.')), pending.firstMs);
            }
            if (data.event === 'token' && data.text?.trim()) clearTimeout(pending.firstTimer);
            pending.onEvent(data);
          } else if (data.done) {
            this.pending = null;
            clearTimeout(pending.timer);
            clearTimeout(pending.firstTimer);
            if (data.error) pending.reject(errorWithCode(data.error.code || 'runtime', data.error.message));
            else {
              if (pending.action === 'load') this.loaded = pending.modelId;
              pending.resolve(data.result);
            }
          }
        };
        const failed = () => this.stop(errorWithCode('worker', '실행 Worker가 종료되었습니다. 다시 로드해 주세요.'));
        this.worker.onerror = failed;
        this.worker.onmessageerror = failed;
      } catch (error) { this.worker = null; return Promise.reject(error); }
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.stop(errorWithCode(timeoutCode, '작업 시간 제한을 초과했습니다. 다운로드·초기화 또는 생성 상태를 확인해 주세요.')), timeoutMs);
      this.pending = { id, action, modelId: payload.modelId, resolve, reject, onEvent, firstMs, timer };
      try { this.worker.postMessage({ id, action, ...payload }); }
      catch (error) { this.stop(error); }
    });
  }
  stop(error = errorWithCode('cancelled', '작업을 취소했습니다. 이미 받은 파일은 캐시에 남을 수 있습니다.')) {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      clearTimeout(pending.firstTimer);
      pending.reject(error);
    }
  }
}

export const BENCH_MESSAGES = [
  { role: 'user', content: '우리는 일정 관리 앱에서 한국어로 대화하고 있어. 오늘은 공부와 운동을 하고 싶어.' },
  { role: 'assistant', content: '좋아요. 무리하지 않는 일정으로 함께 정리해 봐요.' },
  { role: 'user', content: '공부할 시간이 두 시간 있고 저녁에는 30분 산책할 거야. 준비, 집중, 휴식, 마무리 순서로 계획을 네 문단으로 설명해 줘. 각 문단은 두 문장으로 작성하고 자연스러운 한국어로 답해 줘.' },
];

export async function benchmarkModels(client, models, onUpdate) {
  const results = [];
  for (const model of models) {
    const samples = [];
    let result;
    try {
      client.stop(); // release previous model/device before allocating the next
      onUpdate({ phase: 'loading', model });
      const load = await client.request('load', { modelId: model.id }, {
        timeoutMs: 15 * 60 * 1000,
        onEvent: event => onUpdate({ phase: 'loading', model, ...event }),
      });
      onUpdate({ phase: 'warming', model });
      await client.request('generate', { messages: BENCH_MESSAGES, maxTokens: 16 }, { timeoutMs: 60000 });
      for (let i = 0; i < BENCHMARK.samples; i++) {
        onUpdate({ phase: 'measuring', model, sample: i + 1 });
        samples.push(await client.request('generate', { messages: BENCH_MESSAGES, maxTokens: BENCHMARK.maxTokens }, {
          firstMs: BENCHMARK.firstMs, timeoutMs: 30000, timeoutCode: 'generation_timeout',
          onEvent: event => onUpdate({ phase: 'measuring', model, sample: i + 1, ...event }),
        }));
      }
      result = { modelId: model.id, version: BENCHMARK.version, at: Date.now(), loadMs: load.loadMs, samples, ...summarizeSamples(samples) };
    } catch (error) {
      if (['cancelled', 'hidden'].includes(error.code)) throw error;
      result = { modelId: model.id, version: BENCHMARK.version, at: Date.now(), samples: [], ...describeError(error) };
    } finally { client.stop(); }
    results.push(result);
    onUpdate({ phase: 'result', model, result });
    if (!['comfortable', 'usable'].includes(result.status)) break;
  }
  return results;
}
