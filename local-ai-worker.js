import { MLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm';
import { Engine as LiteRTEngine, Backend, getOrLoadGlobalLiteRtLm } from '@litert-lm/core';
import { MODELS, LEGACY_GEMMA2, BENCHMARK, LITERT_ASSET_PATH, LITERT_CACHE, modelURL, modelById, chatMessagesWithReferences, normalizeMemories, normalizeExcerpts, referenceChars, errorWithCode, inspectEnvironment } from './local-ai.js';

const cacheModels = [...MODELS, LEGACY_GEMMA2];
const appConfig = {
  cacheBackend: 'cache',
  model_list: MODELS.filter(model => model.engine === 'webllm').map(model => {
    const preset = prebuiltAppConfig.model_list.find(entry => entry.model_id === model.id);
    if (!preset) throw new Error(`지원 모델 구성이 없습니다: ${model.id}`);
    return { ...preset, model: modelURL(model), overrides: { ...preset.overrides, context_window_size: BENCHMARK.context } };
  }),
};
let engine;
let loaded;
let liteRuntime;

async function unload() {
  if (engine) {
    if (modelById(loaded)?.engine === 'litert') await engine.delete();
    else await engine.unload();
  }
  engine = null;
  loaded = null;
}

// Never clear unrelated origin caches or another model's artifacts.
// scope: 'weights' (model files only) | 'runtime' (shared WASM/config) | undefined (all).
async function modelCaches(deleteId, scope) {
  const counts = Object.fromEntries(cacheModels.map(model => [model.id, 0]));
  const bytes = Object.fromEntries(cacheModels.map(model => [model.id, 0]));
  let runtimeBytes = 0;
  if (!globalThis.caches) throw new Error('이 브라우저에서 모델 캐시를 사용할 수 없습니다.');
  for (const name of await caches.keys()) {
    if (!['webllm/model', 'webllm/config', 'webllm/wasm', LITERT_CACHE].includes(name)) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const model = cacheModels.find(candidate => name === LITERT_CACHE
        ? candidate.engine === 'litert' && request.url === modelURL(candidate)
        : candidate.engine === 'webllm' && (request.url.startsWith(modelURL(candidate)) ||
          request.url === prebuiltAppConfig.model_list.find(entry => entry.model_id === candidate.id)?.model_lib));
      const isRuntime = name === 'webllm/wasm' || (name === 'webllm/config' && !model);
      if (!model && !isRuntime) continue;
      const isWeights = Boolean(model) && (name === LITERT_CACHE || name === 'webllm/model');
      const inScope = !scope || (scope === 'weights' ? isWeights : scope === 'runtime' ? isRuntime : true);
      if (deleteId && inScope && (model?.id === deleteId || (scope === 'runtime' && isRuntime))) { await cache.delete(request); continue; }
      let size = 0;
      try {
        const response = await cache.match(request);
        const length = response?.headers?.get('content-length');
        size = Number(length);
        if (!Number.isFinite(size)) size = 0;
      } catch { size = 0; }
      if (model && isWeights) { counts[model.id]++; bytes[model.id] += size; }
      else if (isRuntime) runtimeBytes += size;
    }
  }
  return { counts, bytes, runtimeBytes };
}

async function liteModelStream(model, emit) {
  if (!globalThis.caches) throw new Error('이 브라우저에서 모델 캐시를 사용할 수 없습니다.');
  const cache = await caches.open(LITERT_CACHE);
  const url = modelURL(model);
  let response = await cache.match(url);
  if (!response) {
    const download = await fetch(url, { credentials: 'omit' });
    if (!download.ok || !download.body) throw new Error(`모델 다운로드 HTTP ${download.status}`);
    let received = 0;
    let reported = 0;
    const body = download.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > model.bytes) throw new Error('다운로드 모델 크기가 고정된 파일 정보와 다릅니다.');
        if (performance.now() - reported > 200 || received === model.bytes) {
          emit('progress', { progress: received / model.bytes, text: `모델 다운로드 ${(received / 1e9).toFixed(2)} / ${(model.bytes / 1e9).toFixed(2)} GB` });
          reported = performance.now();
        }
        controller.enqueue(chunk);
      },
      flush() { if (received !== model.bytes) throw new Error('모델 다운로드가 완료되지 않았습니다. 다시 시도해 주세요.'); },
    }));
    // Stream directly to disk, then read the cache. clone()/tee() would buffer GBs for the slower reader.
    await cache.put(url, new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(model.bytes) } }));
    response = await cache.match(url);
  }
  if (!response?.body) throw new Error('저장된 모델을 읽을 수 없습니다. 캐시를 삭제하고 다시 시도해 주세요.');
  return response.body;
}

self.onmessage = async ({ data }) => {
  const { id, action, modelId } = data;
  const emit = (event, value = {}) => self.postMessage({ id, event, ...value });
  try {
    let result;
    if (action === 'cache') result = await modelCaches();
    else if (action === 'delete') {
      if (data.scope === 'runtime') result = await modelCaches(null, 'runtime');
      else {
        if (!cacheModels.some(model => model.id === modelId)) throw new Error('지원하지 않는 모델입니다.');
        if (loaded === modelId) await unload();
        result = await modelCaches(modelId, data.scope === 'weights' ? 'weights' : undefined);
      }
    } else if (action === 'load') {
      const model = modelById(modelId);
      if (!model) throw new Error('지원하지 않는 모델입니다.');
      // The Worker's adapter may differ from the page's adapter. Check the selected engine only.
      const environment = await inspectEnvironment();
      const runtime = environment.engines[model.engine];
      if (!runtime?.supported) throw errorWithCode('webgpu_unsupported', runtime?.reason ?? environment.reason);
      await unload();
      const started = performance.now();
      if (model.engine === 'litert') {
        emit('progress', { progress: 0.02, text: 'LiteRT-LM 실행 파일·WebGPU 초기화 중 (모델 다운로드 전)' });
        if (!liteRuntime) {
          const assetURL = new URL(LITERT_ASSET_PATH, self.location.origin).href;
          // Emscripten otherwise locates WASM beside the Worker, not beside the imported script.
          self.Module = { locateFile: name => new URL(name, assetURL).href };
          liteRuntime = await getOrLoadGlobalLiteRtLm(assetURL);
        }
        await liteRuntime.setupDefaultWebGpuDevice();
        const stream = await liteModelStream(model, (event, value = {}) => emit(event, event === 'progress' && Number.isFinite(value.progress) ? { ...value, progress: 0.1 + value.progress * 0.8 } : value));
        emit('progress', { progress: 0.95, text: '캐시에서 GPU로 모델 준비 중 · 다운로드 완료' });
        engine = await LiteRTEngine.create({ model: stream, backend: Backend.GPU_ARTISAN, benchmarkEnabled: true, mainExecutorSettings: { maxNumTokens: BENCHMARK.context } });
      } else {
        engine = new MLCEngine({ appConfig, logLevel: 'WARN', initProgressCallback: report => emit('progress', { progress: report.progress, text: report.text }) });
        await engine.reload(modelId);
      }
      loaded = modelId;
      result = { loadMs: performance.now() - started };
    } else if (action === 'generate') {
      if (!engine || !loaded) throw new Error('먼저 모델을 로드해 주세요.');
      const { messages, maxTokens } = data;
      if (!Array.isArray(messages) || !messages.length || messages.length > 9 ||
        messages.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 2000) ||
        messages.at(-1).role !== 'user' || messages.reduce((sum, message) => sum + message.content.length, 0) > 6000 ||
        !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 256) throw new Error('테스트 입력이 허용 범위를 벗어났습니다.');
      // Only a built-in persona can become a system message, and its few-shot examples come from the dataset.
      // Benchmarks stay neutral, and a client cannot supply its own system prompt or examples.
      let chatMessages = messages;
      if (data.characterId !== undefined) {
        // 기억·발췌도 길이·개수·형식이 제한된 참고 자료일 뿐이며 system 역할은 Worker가 조립한다.
        const memories = normalizeMemories(data.memories);
        const excerpts = normalizeExcerpts(data.excerpts);
        chatMessages = chatMessagesWithReferences(data.characterId, messages, memories, excerpts);
        if (!chatMessages) throw new Error('지원하지 않는 테스트 캐릭터입니다.');
        emit('trace', { characterId: data.characterId, messageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
          memories: memories.length, excerpts: excerpts.length, referenceChars: referenceChars(memories, excerpts), promptChars: chatMessages.reduce((sum, message) => sum + message.content.length, 0) });
      }
      const model = modelById(loaded);
      // Reset KV history before every sample. Warm prefix-cache hits must not inflate scores.
      if (model.engine === 'webllm') await engine.resetChat(false);
      const started = performance.now();
      let ttftMs = null;
      let text = '';
      let tokens;
      let tokensPerSecond;
      const output = value => {
        text = value;
        if (ttftMs === null && text.trim()) ttftMs = performance.now() - started;
        if (text.trim()) emit('token', { text });
      };
      emit('started');
      if (model.engine === 'litert') {
        const conversation = await engine.createConversation({
          sessionConfig: { maxOutputTokens: maxTokens, samplerParams: { seed: 42, temperature: 0.6, p: 0.9 } },
          preface: { messages: chatMessages.slice(0, -1), extra_context: { enable_thinking: false } },
          prefillPrefaceOnInit: false,
        });
        try {
          for await (const chunk of conversation.sendMessageStreaming(messages.at(-1))) {
            const delta = typeof chunk.content === 'string' ? chunk.content
              : Array.isArray(chunk.content) ? chunk.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
            // Reasoning channels and tool calls are not visible answers or executable actions.
            if (delta) output(text + delta);
          }
          const info = await conversation.getBenchmarkInfo();
          tokens = info.lastDecodeTokenCount;
          tokensPerSecond = info.lastDecodeTokensPerSecond;
        } finally { await conversation.delete(); }
      } else {
        let rawText = '';
        const stream = await engine.chat.completions.create({
          messages: chatMessages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
          seed: 42, temperature: 0.6, top_p: 0.9,
        });
        for await (const chunk of stream) {
          if (chunk.usage) { tokens = chunk.usage.completion_tokens; tokensPerSecond = chunk.usage.extra?.decode_tokens_per_s; }
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) { rawText += delta; output(rawText); }
        }
      }
      if (ttftMs === null || !text.trim()) throw errorWithCode('empty_output', '빈 답변이 생성되었습니다.');
      result = { text, ttftMs, tokens, tokensPerSecond, elapsedMs: performance.now() - started };
    } else throw new Error('알 수 없는 실행 요청입니다.');
    self.postMessage({ id, done: true, result });
  } catch (error) {
    self.postMessage({ id, done: true, error: { code: error.code, message: String(error.message ?? error).slice(0, 500) } });
  }
};
