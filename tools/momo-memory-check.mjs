// Optional browser check: npm i --no-save --package-lock=false playwright && npx playwright install chromium
// node tools/momo-memory-check.mjs
// Drives the real app UI for momo transcript migration, paging, script flow, deletion and backup.
// The local AI model is not downloaded; AI generation paths are covered by unit tests instead.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../server.js';
import { BENCHMARK, DEFAULT_MODEL_ID, WEBGPU_LIMITS } from '../local-ai.js';

// 페이지→Worker 입력 조립만 확인하는 가짜 Worker. 실제 추론·모델 다운로드는 하지 않는다.
const fakeWorker = (delayMs = 0, failFirst = false) => FAKE_WORKER
  .replace('__DELAY__', String(delayMs))
  .replace('__FAIL_FIRST__', failFirst ? 'true' : 'false');
const FAKE_WORKER = `
self.onmessage = async ({ data }) => {
  const { id, action } = data;
  const delay = __DELAY__;   // 탭별로 생성 지연을 넣어 동시 생성 감지를 시험한다
  const failFirst = __FAIL_FIRST__;   // 첫 생성만 실패시켜 '답변 다시 시도' 경로를 시험한다
  let generations = 0;
  const echo = (label, payload) => fetch('./__momo-ai-capture__?data=' + encodeURIComponent(JSON.stringify({ label, ...payload })), { method: 'GET' });
  if (action === 'load') { self.postMessage({ id, done: true, result: { loadMs: 1 } }); return; }
  if (action === 'generate') {
    generations += 1;
    if (failFirst && generations === 1) {
      self.postMessage({ id, done: true, error: { code: 'runtime', message: '가짜 Worker 실패(재시도 시험)' } });
      return;
    }
    self.postMessage({ id, event: 'started' });
    self.postMessage({ id, event: 'trace', characterId: data.characterId, messageChars: 1, promptChars: 2,
      memories: (data.memories ?? []).length, excerpts: (data.excerpts ?? []).length, referenceChars: (data.memories ?? []).length + (data.excerpts ?? []).length });
    await echo('generate', { characterId: data.characterId, memories: data.memories ?? [], excerpts: data.excerpts ?? [], messages: data.messages ?? [] });
    const text = '가짜 답변이 도착했어요';
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    self.postMessage({ id, event: 'token', text });
    self.postMessage({ id, done: true, result: { text, ttftMs: 1, tokens: 5, tokensPerSecond: 10, elapsedMs: 2 } });
    return;
  }
  self.postMessage({ id, done: true, result: action === 'cache' ? { counts: {}, bytes: {}, runtimeBytes: 0 } : { counts: {}, bytes: {}, runtimeBytes: 0 } });
};
`;

const legacy = JSON.stringify({
  Arona: Array.from({ length: 70 }, (_, i) => ({ me: i % 2 === 0, text: `legacy-${i}`, time: '12:00' })),
  Yuuka: [{ me: false, text: '유우카 레거시', time: '09:10' }, { me: true, text: '질문', time: '09:11' }],
  Airi: [{ me: false, text: '에어리 레거시', time: '08:00' }],
});
// 엔진 선택: MOMO_CHECK_BROWSER=chromium|firefox|webkit (기본 chromium).
const ENGINES = { chromium, firefox, webkit };
const engineName = (process.env.MOMO_CHECK_BROWSER ?? 'chromium').toLowerCase();
const engine = ENGINES[engineName];
if (!engine) throw new Error(`지원하지 않는 브라우저: ${engineName}`);
const server = makeServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await engine.launch(process.env[`${engineName.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`${engineName.toUpperCase()}_EXECUTABLE`] } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  // WebKit/Firefox는 첫 렌더가 느릴 때가 있다: 기본 동작 제한을 넉넉히 둔다.
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  // Seed once per tab: the app overwrites its own screen state on every navigation.
  await page.addInitScript(({ raw }) => {
    if (sessionStorage.getItem('momo-check-seeded')) return;
    sessionStorage.setItem('momo-check-seeded', '1');
    localStorage.setItem('molu.momotalk.v1', raw);
    localStorage.setItem('molu.momotalk.unread.v1', JSON.stringify({ Yuuka: 3 }));
    localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momo-list', room: null, tab: 'general' }));
  }, { raw: legacy });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length >= 2);
  await page.locator('[data-mpane="chat"]').click();
  const listRows = () => page.$$eval('#momo-chats .chat-row', rows => rows.map(row => ({
    name: row.querySelector('.chat-name').textContent,
    preview: row.querySelector('.chat-preview').textContent,
    unread: row.querySelector('.chat-unread')?.textContent ?? null,
  })));
  const rowTexts = () => page.$$eval('#momo-messages .momo-row', rows => rows
    .filter(row => !row.querySelector('.momo-typing')).map(row => row.querySelector('.momo-bubble').textContent));
  // Typing rows are DOM-only placeholders; count stored messages only.
  const waitRows = count => page.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, count, { timeout: 15000 });
  assert.deepEqual((await listRows()).map(row => row.name), ['프라나', '아이리', '아로나', '유우카'], '최근 활동 순, 같은 시각이면 방 ID 순');
  assert.equal((await listRows())[3].unread, '3', '읽지 않은 메시지 배지');
  assert.match((await listRows())[1].preview, /읽기 전용 · 에어리 레거시/, '페르소나 없는 학생은 읽기 전용 표시');
  // 레거시 원문은 db로만 넘어가고 브라우저 localStorage에 그대로 남는다.
  assert.equal(await page.evaluate(() => localStorage.getItem('molu.momotalk.v1')), legacy, '원본 snapshot 보존');

  await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
  await waitRows(51);
  assert.equal((await rowTexts()).length, 51, '첫 페이지는 최근 50개 + 진행 중 질문');
  assert.equal((await rowTexts())[0], 'legacy-20', '첫 페이지는 최근 50개부터');
  assert.equal(await page.locator('#momo-store-status').isHidden(), true, '저장 오류 없음');
  await page.getByRole('button', { name: '이전 대화 불러오기' }).click();
  await waitRows(71);
  assert.equal((await rowTexts())[0], 'legacy-0', '원문 순서 보존');
  assert.equal(await page.getByRole('button', { name: '이전 대화 불러오기' }).count(), 0, '더 이상 이전 페이지 없음');
  assert.equal(await page.evaluate(() => localStorage.getItem('molu.momotalk.v1')), legacy);

  // 스크립트 모드: 진행도는 저장된 방 카운터를 쓰므로 새로고침 뒤에도 질문이 중복되지 않는다.
  const ask = (await rowTexts()).at(-1);
  await page.locator('#momo-replies .momo-reply-option').first().click();
  await waitRows(74);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await waitRows(50);   // 새로고침 뒤에는 최근 페이지만 다시 읽는다
  assert.equal(await page.getByRole('button', { name: '이전 대화 불러오기' }).count(), 1, '새로고침 뒤에도 이전 페이지를 읽을 수 있다');
  await page.getByRole('button', { name: '이전 대화 불러오기' }).click();
  await waitRows(74);
  assert.equal((await rowTexts())[0], 'legacy-0', '이전 페이지 순서 유지');
  assert.equal((await rowTexts()).filter(text => text === ask).length, 1, '질문이 중복 생성되지 않음');
  assert.equal(await page.locator('#momo-store-status').isHidden(), true, '새로고침 후에도 저장 오류 없음');
  await page.locator('#momo-replies .momo-reply-option').first().click();
  await waitRows(77);

  // 명시적 기억: 메시지에서 만들고, 손으로 추가·수정·중지하고, 검색으로 좁힌다.
  await page.locator('#momo-messages .momo-row').filter({ hasText: '아로나가 도와줄래?' }).click({ button: 'right' });
  await page.locator('#momo-message-save').click();
  await page.waitForFunction(() => document.querySelector('#momo-profile').hidden === false);
  const memoryTexts = () => page.$$eval('#momo-memory-list .momo-memory-row', rows => rows.map(row => row.querySelector('.momo-memory-text').textContent));
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  assert.deepEqual(await memoryTexts(), ['아로나가 도와줄래?'], '메시지에서 만든 기억');
  assert.match(await page.locator('#momo-memory-list .momo-memory-meta').first().textContent(), /이 방에서만/);
  await page.locator('#momo-memory-input').fill('선생님은 커피를 좋아해');
  await page.locator('#momo-memory-add button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 2);
  await page.locator('#momo-memory-query').fill('커피');
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  assert.deepEqual(await memoryTexts(), ['선생님은 커피를 좋아해'], '기억 검색은 방 안에서만 동작');
  await page.locator('#momo-memory-row button, #momo-memory-list button').first().click();
  await page.locator('#momo-memory-list .momo-memory-edit input').fill('선생님은 커피를 아주 좋아해');
  await page.locator('#momo-memory-list .momo-memory-edit button[type="submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#momo-memory-list .momo-memory-text')].some(node => node.textContent === '선생님은 커피를 아주 좋아해'));
  await page.locator('#momo-memory-query').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 2);
  await page.locator('#momo-memory-list .momo-memory-row').filter({ hasText: '아로나가 도와줄래?' }).getByRole('button', { name: '삭제' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  await page.locator('#momo-profile-close').click();

  // 설정에서 내보내기: 레거시 원문·스크립트 진행도가 그대로 백업에 담긴다.
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings'));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '모모톡 기록 내보내기 (JSON)' }).click(),
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'molu-momo-'));
  const backup = join(dir, 'backup.json');
  await download.saveAs(backup);
  const parsed = JSON.parse(await readFile(backup, 'utf8'));
  assert.equal(parsed.format, 'molu-chat-memory');
  assert.equal(parsed.messages.length, 81, '아로나 77 + 에어리 1 + 유우카 2 + 프라나 인사 1');
  const aronaLast = parsed.messages.filter(message => message.roomId === 'Arona').sort((a, b) => a.seq - b.seq).at(-1).text;
  assert.equal(parsed.memories.length, 1, '기억도 백업에 담긴다');
  assert.equal(parsed.memories[0].roomId, 'Arona');
  assert.equal(parsed.memories[0].text, '선생님은 커피를 아주 좋아해');

  // 프로필에서 방 기록 삭제: 저장된 원문이 사라지고 목록에서도 빠진다. 원본 snapshot은 남는다.
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="momo-list"]').click();
  await page.locator('[data-mpane="chat"]').click();
  await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
  await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await page.locator('#momo-profile-open').click();
  await page.locator('#momo-profile-delete').click();
  await page.waitForFunction(() => document.querySelector('#momo-messages .chat-empty'));
  assert.deepEqual((await listRows()).map(row => row.name), ['프라나', '아이리', '유우카'], '삭제한 방은 목록에서 사라짐');
  assert.equal(await page.evaluate(() => localStorage.getItem('molu.momotalk.v1')), legacy, '부분 삭제는 원본 snapshot을 건드리지 않음');

  // 방을 지우면 그 방의 파생 기억도 함께 무효화된다.
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings'));
  const [afterDeleteDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '모모톡 기록 내보내기 (JSON)' }).click(),
  ]);
  const afterDeletePath = join(dir, 'after-delete.json');
  await afterDeleteDownload.saveAs(afterDeletePath);
  const afterDelete = JSON.parse(await readFile(afterDeletePath, 'utf8'));
  assert.deepEqual(afterDelete.memories, [], '방 삭제는 파생 기억도 무효화한다');
  assert.ok(afterDelete.messages.every(message => !message.text.startsWith('legacy-')), '삭제한 방의 원문은 백업에도 없다');
  const aronaAfterDelete = afterDelete.messages.filter(message => message.roomId === 'Arona').length;
  assert.ok(aronaAfterDelete >= 1 && aronaAfterDelete <= 2, `아로나 방은 새 첫 인사만 남는다: ${aronaAfterDelete}건`);

  // 전체 삭제 → 첫 인사만 남는다.
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings'));
  await page.getByRole('button', { name: '모모톡 대화 기록 삭제' }).click();
  await page.waitForFunction(() => /삭제했습니다/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length === 2);
  assert.deepEqual((await listRows()).map(row => row.name).sort(), ['아로나', '프라나'], '첫 인사만 남는다');

  // 백업 가져오기: 기록이 남아 있어도 사용자가 확인하면 백업 내용으로 대체한다.
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings'));
  await page.setInputFiles('input[aria-label="모모톡 기록 백업 파일"]', backup);
  await page.waitForFunction(() => /가져왔습니다/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''), null, { timeout: 15000 });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length === 4);
  const restored = await listRows();
  assert.deepEqual(restored.map(row => row.name).sort(), ['아이리', '아로나', '유우카', '프라나'].sort(), '백업 + 첫 인사');
  assert.equal(restored.find(row => row.name === '아로나').preview, aronaLast, '가져온 마지막 메시지');
  // AI 경로: 실제 Worker 대신 가짜 Worker로 페이지가 조립한 모델 입력을 확인한다(모델 다운로드 없음).
  const aiContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  aiContext.setDefaultTimeout(60_000);
  const aiPage = await aiContext.newPage();
  const aiErrors = [];
  aiPage.on('pageerror', error => aiErrors.push(error.message));
  aiPage.on('dialog', dialog => dialog.accept());
  const captured = [];
  await aiPage.route('**/__momo-ai-capture__*', route => {
    captured.push(JSON.parse(new URL(route.request().url()).searchParams.get('data')));
    return route.fulfill({ status: 204, body: '' });
  });
  await aiPage.route('**/local-ai-worker.bundle.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeWorker() }));
  await aiPage.addInitScript(({ settings, limits }) => {
    localStorage.setItem('molu.local-ai.v1', settings);
    localStorage.setItem('molu.prefs.v1', JSON.stringify({ devMode: true }));
    // 페이지의 환경 확인만 통과시킨다: 실제 GPU 장치·모델은 만들지 않는다.
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({
      info: { vendor: 'check' }, features: new Set(['shader-f16']), limits, requestDevice: async () => null }) } });
  }, { settings: JSON.stringify({ catalogVersion: BENCHMARK.version, modelId: DEFAULT_MODEL_ID, momoEnabled: true }), limits: WEBGPU_LIMITS });
  await aiPage.goto(base);
  await aiPage.locator('#home-indicator').click();
  await aiPage.locator('[data-app="settings"]').click();
  await aiPage.locator('[data-set="ai"]').click();
  await aiPage.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
  await aiPage.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  await aiPage.waitForFunction(() => /준비 완료/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''), null, { timeout: 30000 });
  // 대화 저장소 섹션: 사용량 추정과 보존 요청이 실제 API 결과를 표시한다.
  const rowValue = label => aiPage.evaluate(text => {
    const row = [...document.querySelectorAll('.local-ai-settings .ios-row')].find(node => node.textContent.includes(text));
    return row?.querySelector('.ios-value')?.textContent ?? '';
  }, label);
  assert.match(await rowValue('대화 저장소 사용량'), /(B|KB|MB|GB)|확인할 수 없습니다/);
  assert.match(await rowValue('브라우저 보존 상태'), /보존 허용됨|보존 미허용|확인할 수 없습니다/);
  await aiPage.getByRole('button', { name: '대화 저장소 보존 요청' }).click();
  // 결과는 엔진에 따라 즉시 오거나(Chromium·WebKit), 브라우저 확인을 기다린다(Firefox 프롬프트).
  // 상태 행만 본다: 패널 전체 텍스트에는 '지원하지 않습니다' 같은 다른 문구도 있다.
  const statusValue = () => aiPage.evaluate(() => {
    const row = [...document.querySelectorAll('.local-ai-settings .ios-row')].find(node => node.textContent.includes('실행 상태'));
    return row?.querySelector('.ios-value')?.textContent ?? '';
  });
  let persistResolved = true;
  try {
    await aiPage.waitForFunction(() => {
      const row = [...document.querySelectorAll('.local-ai-settings .ios-row')].find(node => node.textContent.includes('실행 상태'));
      return /보존을 허용했|보존을 허용하지 않았|지원하지 않습니다/.test(row?.querySelector('.ios-value')?.textContent ?? '');
    }, null, { timeout: 12_000 });
  } catch { persistResolved = false; }
  if (persistResolved) {
    assert.match(await statusValue(), /보존을 허용했|보존을 허용하지 않았|지원하지 않습니다/);
    assert.match(await rowValue('브라우저 보존 상태'), /보존 허용됨|보존 미허용|확인할 수 없습니다/);
  } else {
    // 사용자 확인을 기다리는 동안: 진행 중 표시와 버튼 잠금이 보여야 한다.
    assert.match(await statusValue(), /저장소 보존을 요청했습니다/);
    assert.equal(await aiPage.getByRole('button', { name: '대화 저장소 보존 요청' }).isDisabled(), true, '보존 요청 대기 중에는 버튼이 잠긴다');
    console.log(`[storage] ${engineName}: 보존 요청이 브라우저 확인 대기 중(엔진별 프롬프트) — 진행 중 표시·버튼 잠금 확인`);
  }

  // 모모톡으로 이동해 기억을 하나 만들고 메시지를 보낸다.
  await aiPage.locator('#home-indicator').click();
  await aiPage.locator('[data-app="momo-list"]').click();
  await aiPage.locator('[data-mpane="chat"]').click();
  await aiPage.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
  await aiPage.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await aiPage.locator('#momo-profile-open').click();
  await aiPage.locator('#momo-memory-input').fill('선생님은 커피를 좋아해');
  await aiPage.locator('#momo-memory-add button[type="submit"]').click();
  await aiPage.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  await aiPage.locator('#momo-profile-close').click();
  const beforeAi = await aiPage.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
  await aiPage.locator('#momo-input').fill('오늘 커피 마실래?');
  await aiPage.locator('#momo-form .momo-send').click();
  await aiPage.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, beforeAi + 2, { timeout: 30000 });
  assert.equal(await aiPage.locator('#momo-messages .momo-bubble').last().textContent(), '가짜 답변이 도착했어요', 'Worker 스트리밍 저장');
  assert.equal(captured.length, 1, 'Worker가 한 번 생성 요청을 받는다');
  const payload = captured[0];
  assert.equal(payload.characterId, 'Arona');
  assert.deepEqual(payload.memories.map(memory => memory.text), ['선생님은 커피를 좋아해'], '기억이 Worker로 전달된다');
  assert.ok(payload.messages.at(-1).content === '오늘 커피 마실래?', '현재 질문이 마지막 user 메시지');
  assert.ok(payload.messages.every(message => ['user', 'assistant'].includes(message.role)), '클라이언트는 system 역할을 보내지 않는다');
  // 두 번째 질문: 방금 완료된 왕복이 문맥으로 들어간다(완료된 최근 2왕복 이하).
  await aiPage.locator('#momo-input').fill('내일도 커피 마실래?');
  await aiPage.locator('#momo-form .momo-send').click();
  await aiPage.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, beforeAi + 4, { timeout: 30000 });
  assert.equal(captured.length, 2, '두 번째 생성 요청');
  assert.deepEqual(captured[1].messages.map(message => [message.role, message.content]), [
    ['user', '오늘 커피 마실래?'], ['assistant', '가짜 답변이 도착했어요'], ['user', '내일도 커피 마실래?'],
  ], '완료된 왕복이 문맥으로 전달된다');
  assert.deepEqual(captured[1].memories.map(memory => memory.text), ['선생님은 커피를 좋아해'], '질문과 관련된 기억만 전달된다');
  // 모델이 말한 내용은 자동으로 기억이 되지 않는다: 실제 답변 뒤에도 사용자가 저장한 기억만 남는다.
  await aiPage.locator('#momo-profile-open').click();
  await aiPage.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  assert.deepEqual(await aiPage.$$eval('#momo-memory-list .momo-memory-text', nodes => nodes.map(node => node.textContent)),
    ['선생님은 커피를 좋아해'], '생성된 답변은 기억으로 저장되지 않는다');
  await aiPage.locator('#momo-profile-close').click();

  // 개발자 도구가 마지막 조립 결과(개수·문자 수·선택된 참고 자료)를 보여 준다.
  await aiPage.locator('#home-indicator').click();
  await aiPage.locator('[data-app="settings"]').click();
  await aiPage.locator('[data-set="dev"]').click();
  await aiPage.getByRole('button', { name: '모모톡 프롬프트' }).click();
  await aiPage.waitForFunction(() => document.querySelector('#set-detail-title')?.textContent === '모모톡 프롬프트');
  const tracePanel = await aiPage.locator('#set-body').innerText();
  assert.match(tracePanel, /기억 1/, '조립 추적: 기억 1건');
  assert.match(tracePanel, /선생님은 커피를 좋아해/, '조립 추적: 선택된 기억 본문');
  assert.match(tracePanel, /\/ 4000자/, '조립 추적: 문자 예산');
  assert.deepEqual(aiErrors, [], 'AI 경로 페이지 오류 없음');
  await aiContext.close();

  // 두 탭: 다른 탭의 추가·삭제 반영과 같은 방 동시 생성 감지(잠금이 아니라 신호).
  const multiContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  multiContext.setDefaultTimeout(60_000);
  const multiErrors = [];
  const prepareAiTab = async (page, delayMs) => {
    page.on('pageerror', error => multiErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/__momo-ai-capture__*', route => route.fulfill({ status: 204, body: '' }));
    await page.route('**/local-ai-worker.bundle.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeWorker(delayMs) }));
    await page.addInitScript(({ settings, limits }) => {
      localStorage.setItem('molu.local-ai.v1', settings);
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({
        info: { vendor: 'check' }, features: new Set(['shader-f16']), limits, requestDevice: async () => null }) } });
    }, { settings: JSON.stringify({ catalogVersion: BENCHMARK.version, modelId: DEFAULT_MODEL_ID, momoEnabled: true }), limits: WEBGPU_LIMITS });
    await page.goto(base);
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="settings"]').click();
    await page.locator('[data-set="ai"]').click();
    await page.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: '다운로드·로드', exact: true }).click();
    await page.waitForFunction(() => /준비 완료/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''), null, { timeout: 30000 });
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="momo-list"]').click();
    await page.locator('[data-mpane="chat"]').click();
    await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
    await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  };
  const sender = await multiContext.newPage();
  const watcher = await multiContext.newPage();
  await prepareAiTab(sender, 2500);
  await prepareAiTab(watcher, 0);
  const senderRows = () => sender.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
  const watcherRows = () => watcher.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
  const watcherBefore = await watcherRows();
  await sender.locator('#momo-input').fill('두 탭 확인');
  await sender.locator('#momo-form .momo-send').click();
  await sender.waitForFunction(() => document.querySelector('#momo-messages .momo-typing'), null, { timeout: 10000 });
  // 다른 탭이 같은 방을 만들고 있는 동안 보내면 감지해 거부한다.
  await watcher.locator('#momo-input').fill('동시에 보내기');
  await watcher.locator('#momo-form .momo-send').click();
  await watcher.waitForFunction(() => /다른 탭에서 같은 대화방의 답변을 만들고 있습니다/.test(document.querySelector('#momo-store-text')?.textContent ?? ''), null, { timeout: 10000 });
  assert.equal(await watcher.evaluate(() => document.querySelector('#momo-messages').textContent.includes('동시에 보내기')), false, '거부된 전송은 저장되지 않는다');
  assert.equal(await watcherRows(), watcherBefore + 1, '보낸 탭의 사용자 메시지만 다른 탭에 반영된다');
  // 보낸 탭의 답변이 저장되면 다른 탭 화면도 갱신된다.
  await sender.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, (await senderRows()) + 1, { timeout: 30000 });
  await watcher.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, watcherBefore + 2, { timeout: 15000 });
  assert.deepEqual(multiErrors, [], '두 탭 페이지 오류 없음');
  await multiContext.close();

  // 중단·재시도 경로: 생성 중 새로고침으로 답이 사라지면 사용자 메시지는 남고,
  // 모델을 다시 준비한 뒤 '답변 다시 시도'가 같은 메시지로 재생성한다(중복 0건).
  const retryContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  retryContext.setDefaultTimeout(60_000);
  const retryPage = await retryContext.newPage();
  const retryErrors = [];
  retryPage.on('pageerror', error => retryErrors.push(error.message));
  retryPage.on('dialog', dialog => dialog.accept());
  const retryCaptures = [];
  await retryPage.route('**/__momo-ai-capture__*', route => {
    retryCaptures.push(JSON.parse(new URL(route.request().url()).searchParams.get('data')));
    return route.fulfill({ status: 204, body: '' });
  });
  await retryPage.route('**/local-ai-worker.bundle.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeWorker(3000) }));
  await retryPage.addInitScript(({ settings, limits }) => {
    localStorage.setItem('molu.local-ai.v1', settings);
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({
      info: { vendor: 'check' }, features: new Set(['shader-f16']), limits, requestDevice: async () => null }) } });
    sessionStorage.removeItem('momo-retry-seeded');
  }, { settings: JSON.stringify({ catalogVersion: BENCHMARK.version, modelId: DEFAULT_MODEL_ID, momoEnabled: true }), limits: WEBGPU_LIMITS });
  const loadModel = async page => {
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="settings"]').click();
    await page.locator('[data-set="ai"]').click();
    await page.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: '다운로드·로드', exact: true }).click();
    await page.waitForFunction(() => /준비 완료/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  };
  const openArona = async page => {
    await page.locator('#home-indicator').click();
    await page.locator('[data-app="momo-list"]').click();
    await page.locator('[data-mpane="chat"]').click();
    await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
    await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  };
  await retryPage.goto(base);
  await loadModel(retryPage);
  await openArona(retryPage);
  // 방 로딩이 끝나고 입력이 열릴 때까지 기다린 뒤 기준 행 수를 잰다.
  await retryPage.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length > 0);
  await retryPage.waitForFunction(() => document.querySelector('#momo-input').hidden === false, null, { timeout: 30_000 });
  const retryRows = () => retryPage.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
  const beforeRetry = await retryRows();
  await retryPage.locator('#momo-input').fill('중단되어도 남아 있어야 해');
  await retryPage.locator('#momo-form .momo-send').click();
  await retryPage.waitForFunction(() => document.querySelector('#momo-messages .momo-typing'), null, { timeout: 30_000 });
  await retryPage.reload();   // 생성 중 새로고침: 답변은 저장되지 않는다
  await retryPage.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false, null, { timeout: 30_000 });
  await retryPage.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, beforeRetry + 1, { timeout: 30_000 });
  assert.equal(await retryPage.evaluate(() => document.querySelector('#momo-messages').textContent.includes('가짜 답변이 도착했어요')), false, '중단된 답변은 저장되지 않는다');
  // 모델을 다시 준비하면 같은 사용자 메시지로 재시도할 수 있다.
  await loadModel(retryPage);
  await openArona(retryPage);
  await retryPage.waitForFunction(() => document.querySelectorAll('#momo-replies .momo-reply-option').length > 0, null, { timeout: 30_000 });
  assert.match(await retryPage.locator('#momo-replies .momo-reply-option').first().textContent(), /답변 다시 시도/);
  const countText = text => retryPage.evaluate(value => document.querySelector('#momo-messages').textContent.split(value).length - 1, text);
  assert.equal(await countText('중단되어도 남아 있어야 해'), 1, '사용자 메시지는 한 번만 저장');
  await retryPage.locator('#momo-replies .momo-reply-option').first().click();
  await retryPage.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
    .filter(row => !row.querySelector('.momo-typing')).length === expected, beforeRetry + 2, { timeout: 30_000 });
  assert.equal(await countText('중단되어도 남아 있어야 해'), 1, '재시도해도 사용자 메시지는 한 번뿐');
  assert.ok(retryCaptures.length >= 1, '재시도가 Worker 요청을 보낸다');
  const retryPayload = retryCaptures.at(-1);
  assert.equal(retryPayload.messages.at(-1).content, '중단되어도 남아 있어야 해', '재시도는 같은 질문으로 생성');
  assert.equal(retryPayload.messages.filter(message => message.content === '중단되어도 남아 있어야 해').length, 1, '문맥에 질문이 한 번만 들어간다');
  assert.ok(retryPayload.messages.every(message => message.role === 'user' || message.role === 'assistant'));
  assert.deepEqual(retryErrors, [], '재시도 경로 페이지 오류 없음');
  await retryContext.close();

  // 저장 실패 경로: 메시지 저장이 실패하면 '저장됨'으로 보이지 않고, 배너에서 재시도해 실제로 저장된다.
  const failContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  failContext.setDefaultTimeout(60_000);
  const failPage = await failContext.newPage();
  const failErrors = [];
  failPage.on('pageerror', error => failErrors.push(error.message));
  failPage.on('dialog', dialog => dialog.accept());
  // 한 번만 시드한다: 앱이 저장한 화면 상태를 새로고침마다 덮어쓰면 안 된다.
  await failPage.addInitScript(() => {
    if (sessionStorage.getItem('momo-fail-seeded')) return;
    sessionStorage.setItem('momo-fail-seeded', '1');
    localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momo-list', room: null, tab: 'general' }));
  });
  await failPage.goto(base);
  await failPage.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length >= 1);
  await failPage.locator('[data-mpane="chat"]').click();
  await failPage.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
  await failPage.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await failPage.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length > 0);
  const failRows = () => failPage.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
  const beforeFail = await failRows();
  // 첫 messages 쓰기만 강제로 실패시킨다(쿼터/디스크 오류 모사). 원복 함수는 나중에 호출한다.
  await failPage.evaluate(() => {
    const store = IDBObjectStore.prototype;
    const original = store.add;
    window.__restoreStore = () => { store.add = original; };
    store.add = function (...args) {
      if (this.name === 'messages') { window.__restoreStore(); throw new DOMException('quota', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  await failPage.locator('#momo-input').fill('저장 실패 시험');
  await failPage.locator('#momo-form .momo-send').click();
  await failPage.waitForFunction(() => document.querySelector('#momo-store-status').hidden === false, null, { timeout: 30_000 });
  assert.match(await failPage.locator('#momo-store-text').textContent(), /저장하지 못했습니다/);
  assert.equal(await failRows(), beforeFail + 1, '실패한 메시지도 화면에는 남는다');
  assert.equal(await failPage.locator('#momo-messages .momo-row.unsaved').count(), 1, '저장 안 됨 표시');
  assert.equal(await failPage.locator('#momo-input').isHidden(), true, '저장 실패 동안 새 전송을 막는다');
  const listPreviewDuringFailure = await failPage.evaluate(() => document.querySelector('#momo-chats .chat-preview')?.textContent ?? '');
  await failPage.locator('#momo-store-retry').click();
  await failPage.waitForFunction(() => document.querySelector('#momo-store-status').hidden === true, null, { timeout: 30_000 });
  assert.equal(await failPage.locator('#momo-messages .momo-row.unsaved').count(), 0, '재시도 뒤 저장 표시가 사라진다');
  assert.equal(await failPage.locator('#momo-input').isHidden(), false, '재시도 뒤 입력이 다시 열린다');
  await failPage.reload();
  await failPage.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false, null, { timeout: 30_000 });
  await failPage.waitForFunction(() => document.querySelector('#momo-messages')?.textContent.includes('저장 실패 시험') === true, null, { timeout: 30_000 });
  assert.equal((await failRows()) >= beforeFail + 1, true, '재시도한 메시지가 새로고침 뒤에도 남는다');
  // 주입한 쿼터 오류는 IDB 이벤트 핸들러 안에서 던져져 브라우저가 uncaught로 보고한다: 테스트 산출물이므로 걸러낸다.
  assert.deepEqual(failErrors.filter(message => !/quota/.test(message)), [], '저장 실패 경로에 주입 외 페이지 오류 없음');
  void listPreviewDuringFailure;
  await failContext.close();

  console.log(`momo memory check (${engineName}): ok`, JSON.stringify({ restored: restored.map(row => row.name), backupMessages: parsed.messages.length }));
} finally {
  await browser?.close();
  server.close();
}
