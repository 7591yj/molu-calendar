// MOLU calendar 사용성 점검: 실제 브라우저 엔진에서 주요 흐름을 걸어 보고 휴리스틱을 측정한다.
// 실행: node server.js & node tools/usability-check.mjs
// 필요: npm i --no-save playwright && npx playwright install webkit chromium
import { webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT ?? '/tmp/molu-ux';
await mkdir(OUT, { recursive: true });

const audit = () => {
  const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = el => (el.getAttribute('aria-label') || el.textContent.trim() || el.title || '').replace(/\s+/g, ' ').slice(0, 40);
  const px = c => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lum = ([r, g, b]) => { const f = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const out = { vw: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth, small: [], unnamed: [], contrast: [] };
  for (const el of document.querySelectorAll('button,a[href],input,select,textarea,[role=button],[role=tab]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) out.small.push({ el: el.id || String(el.className).split(' ')[0], text: name(el), w: Math.round(r.width), h: Math.round(r.height) });
    if (!name(el)) out.unnamed.push(`${el.tagName}#${el.id}.${String(el.className).split(' ')[0]}`);
  }
  for (const el of document.querySelectorAll('body *')) {
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
    if (!text || !vis(el)) continue;
    let bg = null, solid = null;
    for (let n = el, d = 0; n && d < 4; n = n.parentElement, d++) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') { solid = false; break; }
      const c = px(s.backgroundColor);
      if (c && c[3] > 0.9) { solid = true; bg = c; break; }
    }
    if (!solid) continue;
    const cs = getComputedStyle(el), fg = px(cs.color);
    if (!fg || fg[3] < 0.9) continue;
    const size = parseFloat(cs.fontSize), big = size >= 24 || (parseInt(cs.fontWeight, 10) >= 700 && size >= 18.66);
    const r = ratio(fg, bg);
    if (r < (big ? 3 : 4.5)) out.contrast.push({ el: el.id || String(el.className).split(' ')[0], text: text.slice(0, 26), color: cs.color, bg: `rgb(${bg.slice(0, 3).join(',')})`, size: Math.round(size), ratio: Math.round(r * 100) / 100 });
  }
  return out;
};

const layout = () => {
  const box = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  return { calendar: box('#calendar'), sidebar: box('.sidebar'), overlap: Math.round(document.querySelector('#calendar').getBoundingClientRect().bottom) > Math.round(document.querySelector('.sidebar').getBoundingClientRect().top),
    scrollable: document.documentElement.scrollHeight > innerHeight, pageH: document.documentElement.scrollHeight, viewH: innerHeight,
    monthRowsVisible: [...document.querySelectorAll('#calendar-grid > .day')].filter(d => d.getBoundingClientRect().top < innerHeight && d.getBoundingClientRect().bottom > 0).length };
};

const report = { passes: {}, consoleErrors: [] };
const browser = await webkit.launch();

async function pass(name, opts, fn) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(`${name}: ${m.text().slice(0, 140)}`); });
  page.on('pageerror', e => report.consoleErrors.push(`${name}: ${e.message.slice(0, 140)}`));
  page.on('requestfailed', r => { if (!r.url().includes('country.is')) report.consoleErrors.push(`${name}: ${r.url().slice(-40)} ${r.failure()?.errorText ?? ''}`); });
  const steps = [];
  const step = async (label, f) => { try { steps.push({ label, ok: true, note: String(await f()).slice(0, 300) }); } catch (e) { steps.push({ label, ok: false, error: e.message.split('\n')[0].slice(0, 160) }); } };
  const shot = n => page.screenshot({ path: `${OUT}/${name}-${n}.png` });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#calendar-grid .day', { timeout: 15000 });
  await page.waitForTimeout(800);
  report.passes[name] = { steps, audit: await page.evaluate(audit), layout: await page.evaluate(layout) };
  await shot('00-initial');
  await fn({ page, step, shot });
  await context.close();
}

// ─── 데스크톱: 기능 흐름 ────────────────────────────────────────────
await pass('desktop', { viewport: { width: 1280, height: 860 } }, async ({ page, step, shot }) => {
  await step('하루 3건 초과 일정이 달력에서 잘리는지', async () => {
    const r = await page.evaluate(() => {
      const more = [...document.querySelectorAll('.more-events')].map(e => e.textContent.trim());
      const chips = [...document.querySelectorAll('.day')].map(d => d.querySelectorAll('.day-event:not(.span-bar)').length);
      return { moreIndicators: more.length, sample: more.slice(0, 3), maxChipsPerDay: Math.max(...chips) };
    });
    return JSON.stringify(r);
  });
  await step('날짜 클릭 → 브리핑 갱신', async () => {
    await page.click('#today-button'); await page.waitForTimeout(300);
    const today = await page.evaluate(() => document.querySelector('.day-number[aria-current=date]').dataset.date);
    await page.click(`[data-date="${today}"]`); await page.waitForTimeout(400);
    await shot('01-day-selected');
    return `${today} 선택 → 브리핑 "${(await page.textContent('#selected-date')).trim()}", 카드 ${await page.locator('.day-event-card').count()}개`;
  });
  await step('일정 상세(제목·기간·출처·태그)', async () => {
    await page.locator('.day-event-card').first().click(); await page.waitForTimeout(500);
    await shot('02-event-detail');
    const info = await page.evaluate(() => ({ title: document.querySelector('#event-title')?.textContent.trim(), range: document.querySelector('#event-range')?.textContent.trim(), tags: document.querySelector('#event-tags')?.textContent.trim(), source: document.querySelector('#event-dialog a')?.href?.slice(0, 60), bannerShown: !!document.querySelector('#event-banner:not([hidden])') }));
    return JSON.stringify(info);
  });
  await step('북마크 → 새로고침 후 유지', async () => {
    const pressed0 = await page.getAttribute('#bookmark-button', 'aria-pressed');
    await page.click('#bookmark-button'); await page.waitForTimeout(200);
    const pressed1 = await page.getAttribute('#bookmark-button', 'aria-pressed');
    const title = (await page.textContent('#event-title')).trim();
    await page.keyboard.press('Escape'); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#calendar-grid .day'); await page.waitForTimeout(800);
    await page.locator('.day-event-card').first().click(); await page.waitForTimeout(400);
    const after = await page.getAttribute('#bookmark-button', 'aria-pressed');
    await shot('03-bookmark-after-reload');
    await page.keyboard.press('Escape');
    return `최초 ${pressed0} → 토글 ${pressed1} → 새로고침 후 "${(await page.textContent('#event-title') ?? '').trim() === title ? '같은 일정' : '다른 일정'}" pressed=${after}`;
  });
  await step('목록 보기', async () => {
    await page.click('#list-view'); await page.waitForTimeout(400);
    await shot('04-list');
    return `agenda 표시=${await page.isVisible('#agenda')}, 행 ${await page.locator('#agenda .agenda-row').count()}개, 달력 숨김=${!(await page.isVisible('#calendar-view'))}`;
  });
  await step('분류 필터 (픽업 모집)', async () => {
    await page.click('#month-view'); await page.waitForTimeout(300);
    const before = await page.locator('.day-event, .day-event-card').count();
    await page.getByRole('button', { name: '픽업 모집' }).first().click();
    await page.waitForTimeout(400);
    await shot('05-filter-pickup');
    const pressed = await page.evaluate(() => [...document.querySelectorAll('#filters button')].map(b => `${b.textContent.trim()}:${b.getAttribute('aria-pressed')}`).join(' '));
    return `달력 칩 ${before} → ${await page.locator('.day-event, .day-event-card').count()} · 상태 ${pressed}`;
  });
  await step('월 이동 · 오늘', async () => {
    const a = (await page.textContent('#month-heading')).trim();
    await page.click('#next-month'); await page.click('#next-month'); await page.waitForTimeout(400);
    const b2 = (await page.textContent('#month-heading')).trim();
    await page.click('#today-button'); await page.waitForTimeout(300);
    return `${a} → ${b2} → 오늘 ${(await page.textContent('#month-heading')).trim()} (prev 비활성=${await page.getAttribute('#prev-month', 'disabled')})`;
  });
  await step('가져오기: 빈 제출 → 잘못된 JSON', async () => {
    await page.click('[data-import]'); await page.waitForTimeout(400);
    await shot('06-import');
    await page.click('#import-form button[type=submit]'); await page.waitForTimeout(300);
    const empty = (await page.textContent('#import-error')).trim();
    await page.fill('#json-input', '{"schema_version":1,"events":[{"id":1}]}');
    await page.click('#import-form button[type=submit]'); await page.waitForTimeout(300);
    const bad = (await page.textContent('#import-error')).trim();
    await shot('07-import-invalid');
    return `빈 제출="${empty}" · 스키마 오류="${bad}"`;
  });
  await step('저장 실패 시 오류 안내', async () => {
    await page.click('#fill-example'); await page.waitForTimeout(300);
    await page.evaluate(() => { window.__set = localStorage.setItem; localStorage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
    await page.click('#import-form button[type=submit]'); await page.waitForTimeout(400);
    const msg = (await page.textContent('#import-error')).trim();
    await shot('08-import-storage-fail');
    await page.evaluate(() => { localStorage.setItem = window.__set; });
    return msg || '오류 문구 없음';
  });
  await step('홈 · 설정 · 하위 페이지', async () => {
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    await page.click('#home-indicator'); await page.waitForTimeout(500);
    await shot('09-home');
    await page.click('[data-app="settings"]'); await page.waitForTimeout(600);
    await shot('10-settings');
    const rows = await page.locator('#set-body button').count();
    await page.locator('#set-body button').first().click(); await page.waitForTimeout(600);
    await shot('11-settings-detail');
    const title = (await page.textContent('#set-detail-title')).trim();
    const back = (await page.locator('#app-settings [class*=back]').first().textContent().catch(() => ''))?.trim();
    return `설정 행 ${rows}개 · 하위 페이지 "${title}" · 뒤로가기 "${back?.slice(0, 20) ?? '없음'}"`;
  });
  await step('모모톡 목록 → 대화 → 전송', async () => {
    await page.click('[data-app="momo-list"]'); await page.waitForTimeout(600);
    await page.click('[data-mpane="chat"]'); await page.waitForTimeout(300);
    await shot('12-momotalk-list');
    const rows = await page.locator('#momo-chats .chat-row').count();
    if (!rows) return `대화 ${rows}개 (친구 탭에서 시작해야 함)`;
    await page.locator('#momo-chats .chat-row').first().click(); await page.waitForTimeout(700);
    await shot('13-momotalk-room');
    await page.fill('#momo-input', '사용성 점검'); await page.press('#momo-input', 'Enter'); await page.waitForTimeout(900);
    await shot('14-momotalk-sent');
    const log = await page.textContent('#momo-messages');
    return `대화 ${rows}개 · 내 메시지 반영=${log.includes('사용성 점검')} · 답장 선택지=${await page.locator('.momo-reply-option').count()}개`;
  });
  await step('키보드 탭 순서 · 포커스 링', async () => {
    await page.click('[data-app="calendar"]'); await page.waitForTimeout(400);
    const seq = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      seq.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'BODY';
        const s = getComputedStyle(el);
        return `${el.id || el.tagName.toLowerCase()}${s.outlineStyle === 'none' && s.boxShadow === 'none' ? '⚠' : ''}`;
      }));
    }
    return seq.join(' → ');
  });
});

// ─── 모바일: 레이아웃·터치·대비 ────────────────────────────────────
await pass('mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async ({ page, step, shot }) => {
  await step('한 달 전체를 볼 수 있는가', async () => {
    const before = await page.evaluate(layout);
    await page.mouse.wheel(0, 1200); await page.waitForTimeout(400);
    const after = await page.evaluate(layout);
    await shot('01-scroll-attempt');
    return JSON.stringify({ before, afterScroll: { pageH: after.pageH, calendarTop: after.calendar?.top } });
  });
  await step('날짜 버튼 탭 (막대로 덮인 날)', async () => {
    const days = await page.evaluate(() => {
      const covered = [...document.querySelectorAll('.day')].filter(d => {
        const n = d.querySelector('.day-number').getBoundingClientRect();
        return document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2)?.closest('.day-number') !== d.querySelector('.day-number');
      }).map(d => d.querySelector('.day-number').dataset.date);
      return { covered: covered.slice(0, 5), total: covered.length };
    });
    const first = days.covered[0];
    if (!first) return `막대에 가려진 날짜 없음`;
    let clicked = false;
    try { await page.click(`[data-date="${first}"]`, { timeout: 4000 }); clicked = true; } catch {}
    return `가려진 날짜 ${days.total}개 (예: ${days.covered.join(', ')}) · 클릭 성공=${clicked}`;
  });
  await step('설정 화면', async () => {
    await page.click('#home-indicator'); await page.waitForTimeout(400);
    await shot('02-home');
    await page.click('[data-app="settings"]'); await page.waitForTimeout(600);
    await shot('03-settings');
    return `설정 행 ${await page.locator('#set-body button').count()}개 · 가로 오버플로 ${await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)}px`;
  });
});

await browser.close();
report.dataCheck = { note: '자동 측정' };
console.log(JSON.stringify(report, null, 1));
