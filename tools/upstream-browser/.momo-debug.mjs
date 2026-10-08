import { chromium } from 'playwright';
import { once } from 'node:events';
import { makeServer } from '../server.js';
const legacy = JSON.stringify({
  Arona: Array.from({ length: 70 }, (_, i) => ({ me: i % 2 === 0, text: `legacy-${i}`, time: '12:00' })),
  Yuuka: [{ me: false, text: '유우카 레거시', time: '09:10' }, { me: true, text: '질문', time: '09:11' }],
  Airi: [{ me: false, text: '에어리 레거시', time: '08:00' }],
});
const server = makeServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.addInitScript(({ raw }) => {
  if (sessionStorage.getItem('momo-check-seeded')) return;
  sessionStorage.setItem('momo-check-seeded', '1');
  localStorage.setItem('molu.momotalk.v1', raw);
  localStorage.setItem('molu.screen.v1', JSON.stringify({ screen: 'momo-list', room: null, tab: 'general' }));
}, { raw: legacy });
await page.goto(base);
await page.waitForFunction(() => document.querySelectorAll('#momo-chats .chat-row').length >= 1);
await page.locator('[data-mpane="chat"]').click();
await page.locator('#momo-chats .chat-row', { hasText: '아로나' }).click();
await page.getByRole('button', { name: '이전 대화 불러오기' }).click();
await page.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length === 71);
console.log('loaded older');
await page.locator('#momo-replies .momo-reply-option').first().click();
await page.waitForFunction(() => document.querySelectorAll('#momo-messages .momo-row').length === 74);
console.log('before reload last', await page.evaluate(() => [...document.querySelectorAll('#momo-messages .momo-row')].slice(-4).map(r => r.querySelector('.momo-bubble').textContent)));
console.log('saved screen', await page.evaluate(() => localStorage.getItem('molu.screen.v1')));
await page.reload();
await page.waitForTimeout(2500);
console.log('after reload', await page.evaluate(() => ({
  rows: document.querySelectorAll('#momo-messages .momo-row').length,
  screens: { home: document.querySelector('#home-screen').hidden, list: document.querySelector('#app-momo-list').hidden, talk: document.querySelector('#app-momotalk').hidden },
  status: document.querySelector('#momo-store-status').hidden ? '' : document.querySelector('#momo-store-text').textContent,
  screen: localStorage.getItem('molu.screen.v1'),
  last: [...document.querySelectorAll('#momo-messages .momo-row')].slice(-3).map(r => r.querySelector('.momo-bubble').textContent),
  first: [...document.querySelectorAll('#momo-messages .momo-row')].slice(0, 1).map(r => r.querySelector('.momo-bubble').textContent),
})));
await browser.close();
server.close();
