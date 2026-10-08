// Optional browser check: npm i --no-save --package-lock=false playwright
// npx playwright install chromium && node tools/local-ai-check.mjs
// Real UI/Worker boot + simulated GPU/model responses. Never downloads model weights.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { makeServer } from '../server.js';

const server = makeServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const panelModel = page => page.locator('.local-ai-settings').getByRole('button', { name: /^모델 / }).innerText();
const panelCharacter = page => page.locator('.local-ai-settings').getByRole('button', { name: /^테스트 캐릭터 / }).innerText();
async function pickModel(page) {
  await page.locator('.local-ai-settings').getByRole('button', { name: /^모델 / }).click();
  await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '모델');
  await page.getByRole('button', { name: 'Gemma 4 E2B' }).click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings'));
}
async function pickCharacter(page, label) {
  await openChat(page);
  await page.getByRole('button', { name: /^테스트 캐릭터 / }).click();
  await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '테스트 캐릭터');
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '테스트 대화');
}
async function openChat(page) {
  const title = await page.evaluate(() => document.querySelector('#set-detail-title')?.textContent);
  if (title === '테스트 대화') return;
  await page.locator('.local-ai-settings').getByRole('button', { name: /^테스트 대화 / }).click();
  await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '테스트 대화');
}
async function backToAI(page) {
  await page.locator('[data-set-back]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings') && document.querySelector('#set-detail-title').textContent === '로컬 AI');
}
async function openAI(page) {
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
}
try {
  const actual = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  actual.on('pageerror', error => errors.push(error.message));
  await openAI(actual);
  assert.match(await panelModel(actual), /Gemma 4 E2B/);
  await actual.locator('.local-ai-settings').getByRole('button', { name: /^테스트 대화 / }).click();
  await actual.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '테스트 대화');
  assert.equal(await actual.locator('#ai-prompt').isEnabled(), true, 'GPU 미지원이어도 초안은 작성 가능');
  const prompt = actual.getByRole('textbox', { name: '테스트 메시지', exact: true });
  assert.match(await prompt.getAttribute('placeholder'), /최대 800자/);
  assert.equal(await actual.locator('label[for="ai-prompt"], label[for="ai-model"], label[for="ai-character"]').count(), 0, '네이티브 select 라벨 없음');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await actual.setViewportSize(viewport);
    const height = await prompt.evaluate(input => input.getBoundingClientRect().height);
    assert.ok(height >= 60 && height <= 80, `두 줄 입력창 높이: ${height}px`);
    assert.equal(await actual.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  await actual.close();

  // Real pinned WASM + classic importScripts + production CSP. Stop at requestDevice,
  // before any model download; this is NOT a GPU inference test.
  const smoke = await browser.newPage();
  smoke.on('dialog', dialog => dialog.accept());
  const gpuMock = `Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 9, maxTextureDimension2D: 8192 }, requestDevice: async options => { throw new Error('LITERT_WASM_READY_LIMIT_' + options.requiredLimits.maxStorageBuffersPerShaderStage); } }) } });`;
  await smoke.addInitScript({ content: gpuMock });
  const bundle = await readFile(new URL('../local-ai-worker.bundle.js', import.meta.url), 'utf8');
  await smoke.route('**/local-ai-worker.bundle.js', route => route.fulfill({ contentType: 'text/javascript', body: gpuMock + '\n' + bundle }));
  let modelRequests = 0;
  await smoke.route('**/*.litertlm*', route => { modelRequests++; return route.abort(); });
  await openAI(smoke);
  await smoke.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await smoke.waitForFunction(() => document.querySelector('.local-ai-settings').getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
  assert.match(await smoke.locator('.local-ai-settings').getByRole('button', { name: /^실행 상태 / }).innerText(), /LITERT_WASM_READY_LIMIT_9/);
  assert.equal(modelRequests, 0);
  console.log('PASS: real LiteRT WASM boot under production CSP; simulated device requests 9 buffers, no weights fetched');
  await smoke.close();

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const test = window.aiTest = { requests: [], terminated: 0, mode: 'normal', cache: { counts: { 'gemma-2-2b-it-q4f16_1-MLC': 2 }, bytes: { 'gemma-2-2b-it-q4f16_1-MLC': 2000 }, runtimeBytes: 500, runtimeFiles: 1 }, bufferLimit: Number(sessionStorage.getItem('ai-test-buffer-limit') ?? 10) };
    Object.defineProperty(window, 'caches', { configurable: true, value: {
      keys: async () => [],
      open: async () => ({ keys: async () => [], match: async () => undefined, delete: async () => false }),
    } });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
      requestAdapter: async () => ({ info: { vendor: 'test-only' }, features: new Set(['shader-f16']), limits: { maxBufferSize: 1073741824, maxStorageBufferBindingSize: 1073741824, maxStorageBuffersPerShaderStage: test.bufferLimit, maxComputeWorkgroupStorageSize: 32768 } }),
    } });
    const RealWorker = window.Worker;
    window.Worker = class {
      constructor(url, options) {
        if (!String(url).includes('local-ai-worker.bundle.js')) return new RealWorker(url, options);
      }
      postMessage(message) {
        test.requests.push({ action: message.action, modelId: message.modelId, characterId: message.characterId, messages: message.messages });
        const emit = data => { if (!this.stopped) this.onmessage?.({ data: { id: message.id, ...data } }); };
        setTimeout(() => {
          if (message.action === 'load') {
            this.loaded = message.modelId;
            test.cache.counts[this.loaded] = 2;
            test.cache.bytes[this.loaded] = 2008432640;
            if (test.mode === 'hang') return;
            emit({ event: 'progress', progress: 1, text: 'Simulated download' });
            emit({ done: true, result: { loadMs: 5000 } });
          } else if (message.action === 'generate') {
            if (test.mode === 'error') { emit({ done: true, error: { code: 'runtime', message: 'GPU device lost' } }); return; }
            if (test.mode === 'hold') {
              emit({ event: 'started' });
              emit({ event: 'token', text: '아직 생성 중인 부분 답변' });
              test.lateGeneration = () => this.onmessage?.({ data: { id: message.id, done: true, result: { text: '늦게 도착한 답변', tokens: 96, ttftMs: 1000, tokensPerSecond: 5 } } });
              return;
            }
            emit({ event: 'started' });
            emit({ event: 'token', text: '테스트 답변 <b>HTML 아님</b>' });
            emit({ done: true, result: { text: '테스트 답변 <b>HTML 아님</b>', ttftMs: 1000, tokensPerSecond: this.loaded === 'gemma-4-E2B-it-web' ? 5 : 20, tokens: 96 } });
          } else if (message.action === 'delete') {
            if (message.scope === 'runtime') test.cache.runtimeBytes = 0;
            else if (message.modelId) { test.cache.counts[message.modelId] = 0; test.cache.bytes[message.modelId] = 0; }
            emit({ done: true, result: JSON.parse(JSON.stringify(test.cache)) });
          } else emit({ done: true, result: JSON.parse(JSON.stringify(test.cache)) });
        }, 20);
      }
      terminate() { this.stopped = true; test.terminated++; }
    };
  });
  await openAI(page);
  const panel = page.locator('.local-ai-settings');
  assert.match(await panelModel(page), /Gemma 4 E2B/);
  await openChat(page);
  assert.match(await panelCharacter(page), /아로나/);
  const characterNames = await page.locator('#set-body .ios-row').allTextContents();
  assert.equal(characterNames.length, 14, '데이터셋 로스터 전체가 선택지에 나옴');
  assert.equal(characterNames[0], '아로나');
  assert.ok(characterNames.includes('호시노') && characterNames.includes('와카모'));
  assert.equal(await page.locator('#set-body').getByRole('button', { name: 'Gemma 2' }).count(), 0);
  await page.locator('#ai-prompt').fill('모델 로드 전에 작성한 초안');
  assert.equal(await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).isDisabled(), true);
  await backToAI(page);
  await panel.getByRole('button', { name: '이전 Gemma 2 다운로드 삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('이전 Gemma 2 캐시 파일을 삭제'));
  await panel.getByRole('button', { name: '작은 모델부터 성능 측정·추천', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.startsWith('측정 종료'));
  assert.match(await panel.locator('.ai-results').innerText(), /Gemma 4 E2B/);
  assert.match(await panelModel(page), /Gemma 4 E2B/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('molu.local-ai.v1')));
  assert.deepEqual(saved.results.map(result => result.status), ['comfortable']);
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'generate').every(request => request.characterId === undefined)), true, '선택된 캐릭터가 벤치마크에 섞이지 않음');
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length), 1);
  await openChat(page);
  assert.equal(await page.locator('#ai-prompt').isEnabled(), true, '측정 후 메모리가 해제되어도 초안 입력 가능');
  assert.equal(await page.locator('#ai-prompt').inputValue(), '모델 로드 전에 작성한 초안');
  assert.equal(await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).isDisabled(), true);
  await backToAI(page);
  await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('준비 완료'));
  await openChat(page);
  await page.locator('#ai-prompt').fill('한국어로 응원해 줘.');
  await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent === '로컬 답변 생성 완료');
  assert.equal(await panel.locator('.ai-output b').count(), 0, '모델 출력은 HTML로 실행하지 않음');
  assert.match(await panel.locator('.ai-output').innerText(), /<b>/);
  await page.locator('#ai-prompt').fill('프라나, 오늘도 잘 부탁해.');
  await pickCharacter(page, '프라나');
  assert.equal(await panel.locator('.ai-output').innerText(), '');
  assert.equal(await page.locator('#ai-prompt').inputValue(), '프라나, 오늘도 잘 부탁해.', '캐릭터 전환은 작성 중인 초안을 지우지 않음');
  await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent === '로컬 답변 생성 완료');
  const switched = await page.evaluate(() => aiTest.requests.filter(request => request.action === 'generate').at(-1));
  assert.equal(switched.characterId, 'Prana');
  assert.deepEqual(switched.messages, [{ role: 'user', content: '프라나, 오늘도 잘 부탁해.' }], '이전 아로나 대화 문맥은 전송하지 않음');
  await page.locator('#ai-prompt').fill('계속 이야기해 줘.');
  await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent === '로컬 답변 생성 완료');
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'generate').at(-1).messages.length), 3, '같은 캐릭터의 이전 대화는 유지');
  await backToAI(page);
  await panel.getByRole('button', { name: '선택 모델 가중치 삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('가중치 파일을 삭제'));
  await openChat(page);
  assert.equal(await page.locator('#ai-prompt').isEnabled(), true);
  assert.equal(await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).isDisabled(), true);
  await backToAI(page);
  await page.evaluate(() => { aiTest.mode = 'hang'; });
  await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await openChat(page);
  assert.equal(await panel.getByRole('button', { name: /^테스트 캐릭터 / }).isDisabled(), true, '작업 도중 캐릭터 변경으로 답변이 섞이지 않음');
  await backToAI(page);
  await panel.getByRole('button', { name: '진행 중인 작업 취소', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('취소했습니다'));
  assert.equal(await panel.getByRole('button', { name: '다운로드·로드', exact: true }).isEnabled(), true);
  assert.ok(await page.evaluate(() => aiTest.terminated > 0));
  assert.equal(await panel.getByRole('button', { name: '선택 모델 가중치 삭제', exact: true }).isEnabled(), true, '취소 후 부분 캐시도 삭제 가능');
  await panel.getByRole('button', { name: '선택 모델 가중치 삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('가중치 파일을 삭제'));
  await panel.getByRole('button', { name: '공유 실행 파일 삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('공유 실행 파일을 삭제'));
  await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    aiTest.bufferLimit = 9;
  });
  const loadCount = await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length);
  await panel.getByRole('button', { name: '기기 환경·저장 공간 다시 확인', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings').getAttribute('aria-busy') === 'false');
  assert.match(await panel.getByRole('button', { name: /^측정 상태 / }).innerText(), /maxStorageBuffersPerShaderStage 현재 9 \/ 필요 10/);
  assert.match(await panel.locator('.ai-results').innerText(), /현재 실행 환경에서는 이 엔진의 모델을 추천할 수 없습니다/);
  assert.equal(await panel.getByRole('button', { name: '다운로드·로드', exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: '작은 모델부터 성능 측정·추천', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length), loadCount);
  assert.equal(await panel.getByRole('button', { name: '선택 모델 가중치 삭제', exact: true }).isEnabled(), true);
  await panel.getByRole('button', { name: '선택 모델 가중치 삭제', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('가중치 파일을 삭제'));
  await pickModel(page);
  await page.evaluate(() => { aiTest.mode = 'normal'; });
  assert.equal(await panel.getByRole('button', { name: '다운로드·로드', exact: true }).isEnabled(), true, 'WebLLM 한도 부족은 LiteRT를 차단하지 않음');
  assert.match(await panel.getByRole('button', { name: /^측정 상태 / }).innerText(), /LiteRT-LM 기본 조건 확인/);
  await panel.getByRole('button', { name: '작은 모델부터 성능 측정·추천', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.startsWith('측정 종료'));
  assert.match(await panel.locator('.ai-results').innerText(), /Gemma 4 E2B/);
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length), loadCount + 1);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('molu.local-ai.v1'));
    saved.results.find(result => result.modelId === 'gemma-4-E2B-it-web').status = 'slow';
    localStorage.setItem('molu.local-ai.v1', JSON.stringify(saved));
    sessionStorage.setItem('ai-test-buffer-limit', '9');
  });
  await openAI(page);
  await openChat(page);
  assert.match(await panelCharacter(page), /프라나/, '캐릭터 선택은 새로고침 후 유지');
  await backToAI(page);
  assert.equal(await panel.locator('.ai-result span').innerText(), '쾌적', '저장된 5 tok/s 결과는 새 기준으로 재판정');
  assert.match(await panel.locator('.ai-results').innerText(), /Gemma 4 E2B/);
  console.log('PASS: desktop/mobile, character selection/persistence/context reset, neutral benchmarks, 5 tok/s, draft input, Gemma 2 cleanup, escaping, cancellation and independent preflight');

  async function settings() {
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="settings"]').click();
    await page.locator('[data-set="ai"]').click();
  }
  async function friends(name) {
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="momo-list"]').click();
    await page.locator('[data-mpane="friends"]').click();
    await page.locator('#momo-search').fill(name);
  }
  async function room(name) {
    await friends(name);
    await page.locator('#momo-students').getByRole('button', { name: new RegExp(`${name} ·`) }).click();
  }
  async function sendMomo(text) {
    await page.locator('#momo-input').fill(text);
    await page.locator('#momo-form .momo-send').click();
  }
  async function finished() {
    await page.waitForFunction(() => document.querySelector('#momo-ai-cancel').hidden);
  }
  async function configureModel(name, keyboard = false) {
    const loads = await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length);
    const guide = page.locator('#momo-ai-settings');
    if (keyboard) { await guide.focus(); await page.keyboard.press('Enter'); }
    else await guide.click();
    await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '로컬 AI' && document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#app-settings').isVisible(), true);
    assert.equal(await page.locator('#app-settings').getAttribute('data-pane'), 'detail');
    assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length), loads, '설정 안내 클릭만으로 다운로드하지 않음');
    await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('준비 완료'));
    await room(name);
    assert.equal(await page.locator('#momo-ai-settings').isHidden(), true);
    assert.equal(await page.locator('#momo-input').isEnabled(), true);
  }
  const generations = () => page.evaluate(() => aiTest.requests.filter(request => request.action === 'generate'));
  const history = id => page.evaluate(id => JSON.parse(localStorage.getItem('molu.momotalk.v1') ?? '{}')[id] ?? [], id);
  const modeToggle = panel.getByRole('switch', { name: /모모톡 로컬 AI/ });
  await pickModel(page);
  await modeToggle.click();
  await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('준비 완료'));
  await openChat(page);
  await page.locator('#ai-prompt').fill('설정 전용 문맥입니다.');
  await panel.getByRole('button', { name: '로컬 모델로 보내기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent === '로컬 답변 생성 완료');
  await room('아로나');
  assert.equal(await page.locator('#momo-ai-prepare').count(), 0, '모모톡에 모델 준비 버튼 없음');
  assert.equal(await page.locator('#momo-ai-settings').isHidden(), true);
  assert.equal(await page.locator('#momo-replies').isHidden(), true);
  await sendMomo('아로나, 좋아하는 간식 이야기해 줘.');
  await finished();
  let request = (await generations()).at(-1);
  assert.equal(request.characterId, 'Arona', '설정에서 고른 프라나가 아니라 대화방의 아로나');
  assert.equal(request.messages.length, 1, '설정 테스트 문맥은 모모톡에 전송하지 않음');
  assert.equal(await page.locator('#momo-messages b').count(), 0);
  assert.match(await page.locator('#momo-messages').innerText(), /<b>HTML 아님<\/b>/);
  assert.equal((await history('Arona')).length, 3, '고정 후속 질문을 붙이지 않음');
  await room('프라나');
  await sendMomo('프라나, 자기소개해 줘.');
  await finished();
  request = (await generations()).at(-1);
  assert.equal(request.characterId, 'Prana');
  assert.equal(request.messages.length, 1, '다른 방 문맥은 섞지 않음');
  assert.equal(await page.evaluate(() => aiTest.requests.filter(request => request.action === 'load').length), sharedLoads, '설정과 양쪽 방이 같은 모델을 재사용');
  const beforeCalendar = (await generations()).length;
  await sendMomo('오늘 일정 알려줘');
  assert.equal((await generations()).length, beforeCalendar, '일정은 LLM 대신 실제 캘린더 조회');
  assert.match((await history('Prana')).at(-1).text, /일정/);

  await room('아로나');
  await page.evaluate(() => { aiTest.mode = 'hold'; });
  await sendMomo('취소할 질문');
  await page.waitForFunction(() => document.querySelector('#momo-messages').textContent.includes('아직 생성 중인 부분 답변'));
  assert.equal((await history('Arona')).at(-1).pending, true);
  await room('프라나');
  await page.evaluate(() => aiTest.lateGeneration());
  assert.doesNotMatch(await page.locator('#momo-messages').innerText(), /늦게 도착|부분 답변/);
  assert.equal((await history('Arona')).at(-1).pending, true, '취소·늦은 응답은 완료 답변으로 저장하지 않음');
  await room('아로나');
  const userCount = (await history('Arona')).filter(message => message.me).length;
  await page.evaluate(() => { aiTest.mode = 'normal'; });
  await configureModel('아로나');
  await page.waitForFunction(() => !document.querySelector('#momo-ai-retry').disabled);
  await page.locator('#momo-ai-retry').click();
  await finished();
  assert.equal((await history('Arona')).filter(message => message.me).length, userCount, '재시도는 사용자 메시지를 중복 저장하지 않음');
  assert.equal((await history('Arona')).at(-2).pending, false);
  assert.equal((await generations()).at(-1).messages.length, 3, '완료한 이전 왕복만 문맥에 포함');

  await page.evaluate(() => { aiTest.mode = 'error'; });
  await sendMomo('오류 처리 확인');
  await finished();
  assert.match(await page.locator('#momo-ai-status').innerText(), /GPU 오류/);
  assert.equal((await history('Arona')).at(-1).pending, true);
  assert.equal(await page.locator('#momo-ai-settings').isVisible(), true);
  assert.equal(await page.locator('#momo-input').isHidden(), true);
  await settings();
  await page.evaluate(() => { aiTest.mode = 'hang'; });
  await panel.getByRole('button', { name: '작은 모델부터 성능 측정·추천', exact: true }).click();
  await room('아로나');
  assert.equal(await page.locator('#momo-ai-settings').isEnabled(), true, '설정 작업 중에도 안내를 눌러 설정으로 이동 가능');
  assert.equal(await page.locator('#momo-input').isDisabled(), true);
  assert.match(await page.locator('#momo-ai-status').innerText(), /설정에서 로컬 AI 작업 중/);
  await page.locator('#momo-ai-settings').click();
  assert.equal(await panel.getByRole('button', { name: '진행 중인 작업 취소', exact: true }).isEnabled(), true);
  await panel.getByRole('button', { name: '진행 중인 작업 취소', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('취소했습니다'));
  await page.evaluate(() => { aiTest.mode = 'normal'; });
  await modeToggle.click();
  await room('아로나');
  assert.equal(await page.locator('#momo-ai').isHidden(), true);
  const legacyCount = (await history('Arona')).length;
  const legacyGenerations = (await generations()).length;
  await sendMomo('안녕');
  await page.waitForFunction(count => JSON.parse(localStorage.getItem('molu.momotalk.v1')).Arona.length >= count + 3, legacyCount);
  assert.equal((await generations()).length, legacyGenerations, '로컬 AI를 끄면 기존 답변·후속 질문 유지');
  await settings();
  await modeToggle.click();
  await room('유우카');
  assert.equal(await page.locator('#momo-input').isDisabled(), true);
  await page.locator('#momo-ai-settings').click();
  await page.waitForFunction(() => document.querySelector('#set-detail-title').textContent === '로컬 AI');
  await panel.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-status').textContent.includes('준비 완료'));
  await room('유우카');
  assert.equal(await page.locator('#momo-input').isEnabled(), true);
  const otherGenerations = (await generations()).length;
  await sendMomo('유우카, 자기소개해 줘.');
  await finished();
  assert.equal((await generations()).length, otherGenerations + 1);
  assert.equal((await generations()).at(-1).characterId, 'Yuuka');
  assert.equal((await generations()).at(-1).messages.length, 1, '학생 방도 독립 문맥');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await friends('모에');
  const unsupported = page.locator('#momo-students').getByRole('button', { name: /^카제쿠라 모에 ·/ });
  assert.equal(await unsupported.isDisabled(), true, '모바일에서 미지원 학생은 대화 시작 불가');
  const originalStatus = await page.evaluate(async () => {
    const students = await (await fetch('./resource/momotalk/students.json')).json();
    const student = students.find(student => student.id === 'Moe');
    return student.status || [student.year, student.club].filter(Boolean).join(' · ');
  });
  assert.equal(await unsupported.locator('.chat-status').innerText(), originalStatus, '미지원이어도 학생 상태 메시지는 원문 유지');
  await unsupported.dispatchEvent('click');
  assert.equal(await page.locator('#app-momo-list').isVisible(), true, '이벤트를 직접 보내도 새 방 생성 차단');
  assert.deepEqual(await history('Moe'), []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await unsupported.click();
  const chatStart = page.locator('#momo-friend-preview button');
  assert.equal(await chatStart.isDisabled(), true, '데스크톱은 프로필 열람만 허용');
  assert.equal(await chatStart.innerText(), '대화 시작');
  assert.equal(await unsupported.locator('.chat-status').innerText(), originalStatus);
  await chatStart.dispatchEvent('click');
  assert.equal(await page.locator('#app-momo-list').isVisible(), true);
  assert.deepEqual(await history('Moe'), []);
  assert.equal((await generations()).length, otherGenerations + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#momo-students .chat-row-main').disabled);

  await page.evaluate(() => localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momotalk', room: 'Moe' })));
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#app-momo-list').hidden);
  assert.deepEqual(await history('Moe'), [], '저장 화면 복원도 미지원 새 방을 생성하지 않음');
  const oldMoe = [{ me: false, text: '보존할 이전 대화', time: '12:00' }];
  await page.evaluate(messages => {
    const rooms = JSON.parse(localStorage.getItem('molu.momotalk.v1'));
    rooms.Moe = messages;
    localStorage.setItem('molu.momotalk.v1', JSON.stringify(rooms));
    localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momotalk', room: 'Moe' }));
  }, oldMoe);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#app-momotalk-title').textContent === '모에');
  assert.match(await page.locator('#momo-messages').innerText(), /보존할 이전 대화/);
  assert.equal(await page.locator('#momo-input').isHidden(), true);
  assert.equal(await page.locator('#momo-ai-settings').isDisabled(), true);
  assert.match(await page.locator('#momo-ai-settings').innerText(), /읽기만/);
  assert.equal(await page.locator('#momo-replies').isHidden(), true);
  await page.evaluate(() => {
    document.querySelector('#momo-input').value = '전송 금지';
    document.querySelector('#momo-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await history('Moe'), oldMoe, '미지원 기존 대화는 읽기 전용이며 고정 답변도 추가하지 않음');
  await page.locator('[data-momo-back]').click();
  await page.locator('[data-mpane="chat"]').click();
  await page.locator('#momo-chats').getByRole('button', { name: /모에와의 대화, 읽기 전용/ }).click();
  assert.deepEqual(await history('Moe'), oldMoe);
  assert.equal(await page.locator('#momo-input').isDisabled(), true);
  await room('아로나');
  assert.equal(await page.locator('#momo-input').isHidden(), true, '모드 선택은 새로고침 후 유지');
  assert.equal(await page.evaluate(() => aiTest.requests.length), 0, '설정 화면 없이 모모톡 진입해도 자동 다운로드 없음');
  assert.equal(await page.locator('#momo-input').isHidden(), true);
  assert.equal(await page.locator('#momo-input').isDisabled(), true);
  assert.equal(await page.locator('#momo-form .momo-send').isHidden(), true);
  assert.equal(await page.locator('#momo-ai-settings').isVisible(), true);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const guide = await page.locator('#momo-ai-settings').boundingBox();
    assert.ok(guide.height >= 44 && guide.x >= 0 && guide.x + guide.width <= viewport.width, '입력 위치의 안내 버튼은 모바일/데스크톱에서 접근 가능');
  }
  const blockedHistory = await history('Arona');
  await page.evaluate(() => {
    document.querySelector('#momo-input').value = '오늘 일정 알려줘';
    document.querySelector('#momo-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await history('Arona'), blockedHistory, '미준비 상태는 일정 요청 포함 전송·저장을 차단');
  assert.equal(await page.evaluate(() => aiTest.requests.length), 0);
  await configureModel('아로나', true);
  await page.evaluate(() => { aiTest.mode = 'hold'; });
  await sendMomo('백그라운드 취소 확인');
  await page.waitForFunction(() => document.querySelector('#momo-messages').textContent.includes('아직 생성 중인 부분 답변'));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await finished();
  assert.match(await page.locator('#momo-ai-status').innerText(), /백그라운드/);
  assert.equal((await history('Arona')).at(-1).pending, true);
  assert.equal(await page.locator('#momo-ai-settings').isVisible(), true);
  assert.equal(await page.locator('#momo-input').isHidden(), true);
  await page.evaluate(() => aiTest.lateGeneration());
  assert.doesNotMatch(JSON.stringify(await history('Arona')), /늦게 도착한 답변|아직 생성 중인 부분 답변/);
  assert.deepEqual(errors, []);
  console.log('PASS: settings-only model preparation, input setup guide/navigation, blocked unprepared submissions, shared model, scoped history, cancellation/retry/error, contention, persona-based eligibility and read-only unsupported history');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
