// 규모 점검(옵트인): 합성 1만 메시지를 실제 브라우저에서 이관·조회하고 화면/메모리/프롬프트 크기를 잰다.
//   npm i --no-save --package-lock=false playwright && node tools/momo-scale-check.mjs
//   MOLU_SCALE_MESSAGES=10000 MOLU_SCALE_OUT=runs/scale.json node tools/momo-scale-check.mjs
// 실제 앱 UI와 실제 IndexedDB를 쓰며, AI 모델은 가짜 Worker로 대체한다(추론 없음).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { makeServer } from '../server.js';
import { BENCHMARK, DEFAULT_MODEL_ID, WEBGPU_LIMITS } from '../local-ai.js';

const MESSAGES = Number(process.env.MOLU_SCALE_MESSAGES ?? 10_000);
const ROOM = 'Yuuka';   // 페르소나가 있는 방: 모델 입력 조립까지 확인한다
const SECOND = 'Aris';
const out = resolve(process.env.MOLU_SCALE_OUT ?? `training/lora/runs/scale/scale-${Date.now()}.json`);
// 입력 조립만 확인하는 가짜 Worker(모델·추론 없음). 받은 페이로드를 캡처 URL로 되돌려 준다.
const FAKE_WORKER = `
self.onmessage = async ({ data }) => {
  const { id, action } = data;
  if (action === 'load') { self.postMessage({ id, done: true, result: { loadMs: 0 } }); return; }
  if (action === 'generate') {
    await fetch('./__scale-capture__?data=' + encodeURIComponent(JSON.stringify({ messages: data.messages.length, chars: data.messages.reduce((sum, m) => sum + m.content.length, 0), memories: (data.memories ?? []).length })));
    self.postMessage({ id, done: true, result: { text: '규모 점검 답변', ttftMs: 1, tokens: 4, tokensPerSecond: 10, elapsedMs: 2 } });
    return;
  }
  self.postMessage({ id, done: true, result: { counts: {}, bytes: {}, runtimeBytes: 0 } });
};
`;
const report = { startedAt: new Date().toISOString(), messages: MESSAGES,
  legacy: JSON.stringify({
    [ROOM]: Array.from({ length: Math.ceil(MESSAGES * 0.8) }, (_, i) => ({ me: i % 2 === 0, text: `${i}번째 메시지`, time: '12:00' })),
    [SECOND]: Array.from({ length: MESSAGES - Math.ceil(MESSAGES * 0.8) }, (_, i) => ({ me: i % 2 === 0, text: `${i}번째 다른 방`, time: '09:00' })),
  }) };
const server = makeServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const captures = [];
  await page.route('**/__scale-capture__*', route => {
    captures.push(JSON.parse(new URL(route.request().url()).searchParams.get('data')));
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/local-ai-worker.bundle.js', route => route.fulfill({ contentType: 'text/javascript', body: FAKE_WORKER }));
  await page.addInitScript(({ settings, limits, legacy }) => {
    localStorage.setItem('molu.momotalk.v1', legacy);
    localStorage.setItem('molu.local-ai.v1', settings);
    localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momo-list', room: null, tab: 'general' }));
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({
      info: { vendor: 'scale' }, features: new Set(['shader-f16']), limits, requestDevice: async () => null }) } });
  }, { settings: JSON.stringify({ catalogVersion: BENCHMARK.version, modelId: DEFAULT_MODEL_ID, momoEnabled: true }),
    limits: WEBGPU_LIMITS, legacy: report.legacy });

  const bootStart = Date.now();
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length >= 2, null, { timeout: 120_000 });
  report.migrationMs = Date.now() - bootStart;
  await page.locator('[data-mpane="chat"]').click();

  // 방 열기: 최근 페이지만 DOM에 올라와야 한다.
  const openStart = Date.now();
  await page.locator('#momo-chats .chat-row', { hasText: '유우카' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length >= 50, null, { timeout: 60_000 });
  report.openRoomMs = Date.now() - openStart;
  const countRows = () => page.evaluate(() => [...document.querySelectorAll('#momo-messages .momo-row')].filter(row => !row.querySelector('.momo-typing')).length);
  report.rowsAfterOpen = await countRows();
  assert.ok(report.rowsAfterOpen <= 60, `첫 화면에 ${report.rowsAfterOpen}개 행이 올라왔습니다`);
  report.domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);

  // 이전 페이지 조회: 여러 번 눌러도 메모리 창(300개)이 유지되는지.
  const pageTimes = [];
  for (let i = 0; i < 8; i++) {
    const expected = Math.min(50 * (i + 2), 300);
    const clickStart = Date.now();
    await page.getByRole('button', { name: '이전 대화 불러오기' }).click();
    await page.waitForFunction(count => [...document.querySelectorAll('#momo-messages .momo-row')].filter(row => !row.querySelector('.momo-typing')).length === count, expected, { timeout: 60_000 });
    pageTimes.push(Date.now() - clickStart);
  }
  report.olderPageMs = pageTimes;
  report.rowsAfterPaging = await countRows();
  assert.equal(report.rowsAfterPaging, 300, `페이지 조회 뒤 ${report.rowsAfterPaging}개 행 — 메모리 창 상한(300)과 다름`);

  // 방 전환: 다른 방도 페이지 단위로 읽는다.
  const switchStart = Date.now();
  await page.locator('[data-momo-back]').click();
  await page.waitForFunction(() => document.querySelector('#app-momo-list').hidden === false);
  await page.locator('#momo-chats .chat-row', { hasText: '아리스' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length >= 50, null, { timeout: 60_000 });
  report.switchRoomMs = Date.now() - switchStart;
  report.rooms = await page.evaluate(() => document.querySelectorAll('#momo-chats .chat-row').length);

  // 모델 입력 조립: 전체 기록이 아니라 최근 왕복만 들어가야 한다(가짜 Worker 로드 후 전송).
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await page.waitForFunction(() => /준비 완료/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="momo-list"]').click();
  await page.locator('[data-mpane="chat"]').click();
  await page.locator('#momo-chats .chat-row', { hasText: '아리스' }).click();
  await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await page.waitForFunction(() => document.querySelector('#momo-input').hidden === false);
  await page.locator('#momo-input').fill('규모 점검 질문');
  await page.locator('#momo-form .momo-send').click();
  await page.waitForFunction(() => /규모 점검 답변/.test(document.querySelector('#momo-messages')?.textContent ?? ''), null, { timeout: 60_000 });
  assert.equal(captures.length, 1, '가짜 Worker가 한 번 요청을 받는다');
  report.prompt = captures[0];
  assert.ok(report.prompt.messages <= 5, `프롬프트 메시지 ${report.prompt.messages}개`);
  assert.ok(report.prompt.chars <= 4_000, `프롬프트 ${report.prompt.chars}자 — 예산 초과`);
  report.heapMB = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  report.errors = errors;
  assert.deepEqual(errors, [], '페이지 오류');
  console.log(JSON.stringify(report, null, 1));
} catch (error) {
  report.failure = String(error.message);
  report.errors ??= [];
  console.error('[failed]', report.failure);
  process.exitCode = 1;
} finally {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log('[saved]', out);
  await browser?.close();
  server.close();
}
