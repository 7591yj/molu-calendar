// 실제 모델 라이브 점검(옵트인): 앱의 Gemma 4 E2B LiteRT 모델을 WebGPU 브라우저에서 내려받아
// 모모톡 로컬 AI로 기억 사용 전/후를 비교한다. 2 GB 다운로드와 실제 GPU 추론이 필요하다.
//
//   npm i --no-save --package-lock=false playwright
//   node tools/local-ai-live-check.mjs
//   MOLU_LIVE_HEADLESS=1 node tools/local-ai-live-check.mjs   # GPU가 있는 헤드리스
//   MOLU_LIVE_OUT=runs/live.json node tools/local-ai-live-check.mjs
//
// 이 점검은 다운로드·속도 판정이 아니라 기억 주입과 문맥이 실제 모델에서 어떻게 쓰이는지 본다.
// 실패(다운로드·GPU·쿼터)는 성공으로 바꾸지 않고 그대로 보고한다.
import { chromium } from 'playwright';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { makeServer } from '../server.js';

const FACT = '선생님은 커피를 좋아해';
const RELATED = '나 커피 좋아하는 거 기억해?';
const UNRELATED = '오늘 날씨 어때?';
const out = resolve(process.env.MOLU_LIVE_OUT ?? `training/lora/runs/live-model-check/live-${Date.now()}.json`);
const record = { startedAt: new Date().toISOString(), environment: null, model: null, turns: [], errors: [], notes: [] };

const server = makeServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: process.env.MOLU_LIVE_HEADLESS === '1', args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => record.errors.push(error.message));
  await page.goto(base);
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="settings"]').click();
  await page.locator('[data-set="ai"]').click();
  await page.waitForFunction(() => document.querySelector('.local-ai-settings')?.getAttribute('aria-busy') === 'false');
  const rows = await page.locator('.local-ai-settings .ios-row').allInnerTexts();
  record.environment = rows.filter(row => /GPU|실행|지원|브라우저/.test(row)).slice(0, 8);
  record.model = rows.find(row => /Gemma 4 E2B · LiteRT-LM/.test(row)) ?? null;
  console.log('[env]', record.environment.join(' | '));
  if (/실행 불가/.test(record.environment.join(' '))) throw new Error('이 브라우저에서 LiteRT-LM 실행 조건이 충족되지 않습니다.');

  const downloadStart = Date.now();
  const panelState = () => page.evaluate(() => [...document.querySelectorAll('.local-ai-settings .ios-row, .local-ai-settings .ai-detail, .local-ai-settings .ai-progress-text')]
    .map(node => node.textContent.trim()).filter(text => /다운로드|로드|실행 상태|모델|초기화|오류|중단/.test(text)).slice(0, 6));
  record.downloadTicks = [];
  await page.getByRole('button', { name: '다운로드·로드', exact: true }).click();
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const ready = await page.evaluate(() => /준비 완료/.test(document.querySelector('.local-ai-settings')?.textContent ?? ''));
    if (ready) break;
    if (Date.now() > deadline) {
      record.downloadTicks.push(await panelState());
      throw new Error(`모델 준비가 30분 안에 끝나지 않았습니다. 마지막 상태: ${JSON.stringify(record.downloadTicks.at(-1))}`);
    }
    if (record.downloadTicks.length < 40) record.downloadTicks.push(await panelState());
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  record.loadMs = Date.now() - downloadStart;
  console.log(`[load] 완료 (${(record.loadMs / 1000).toFixed(1)}초, 다운로드 포함)`);

  // 모모톡 로컬 AI 켜기
  const momoToggle = page.getByRole('switch', { name: /모모톡 로컬 AI/ });
  if ((await momoToggle.getAttribute('aria-checked')) !== 'true') await momoToggle.click();

  // 아로나 방에서 기억 하나를 저장하고 관련/무관 질문을 보낸다.
  await page.locator('#home-indicator').click();
  await page.locator('[data-app="momo-list"]').click();
  await page.locator('[data-mpane="chat"]').click();
  await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
  await page.waitForFunction(() => document.querySelector('#app-momotalk').hidden === false);
  await page.locator('#momo-profile-open').click();
  await page.locator('#momo-memory-input').fill(FACT);
  await page.locator('#momo-memory-add button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#momo-memory-list .momo-memory-row').length === 1);
  await page.locator('#momo-profile-close').click();

  const send = async (text, question, expectMemory) => {
    const before = await page.$$eval('#momo-messages .momo-row', rows => rows.filter(row => !row.querySelector('.momo-typing')).length);
    await page.locator('#momo-input').fill(text);
    await page.locator('#momo-form .momo-send').click();
    await page.waitForFunction(expected => [...document.querySelectorAll('#momo-messages .momo-row')]
      .filter(row => !row.querySelector('.momo-typing')).length === expected, before + 2, { timeout: 5 * 60 * 1000 });
    const answer = await page.locator('#momo-messages .momo-row').last().locator('.momo-bubble').textContent();
    const seconds = null;
    record.turns.push({ question, expectMemory, answer, ms: seconds });
    console.log(`[turn] ${question}\n   → ${answer.replace(/\n/g, ' ')}`);
    return answer;
  };
  const started = Date.now();
  const related = await send(RELATED, '기억 관련 질문', true);
  const relatedMs = Date.now() - started;
  const unrelated = await send(UNRELATED, '무관한 질문', false);
  record.turns[0].ms = relatedMs;
  record.behaviour = {
    relatedMentionsFact: /커피/.test(related),
    unrelatedMentionsFact: /커피/.test(unrelated),
    relatedSkippedMemory: /모르|기억.*없|기억나지/.test(related),
  };
  record.notes.push('기억 관련 답변이 사실을 언급했는지, 무관한 질문에 기억을 억지로 넣지 않았는지는 키워드 기반 참고 지표다.');
  console.log('[behaviour]', JSON.stringify(record.behaviour));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(record, null, 2) + '\n');
  console.log('[saved]', out);
} catch (error) {
  record.errors.push(String(error.message));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(record, null, 2) + '\n');
  console.error('[failed]', String(error.message), '→', out);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
