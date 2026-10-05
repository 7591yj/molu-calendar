import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ChatTranscript, ROOM_CACHE, ROOM_PAGE, viewMessage } from './chat-transcript.js';

const legacy = JSON.stringify({
  Yuuka: [{ me: false, text: '인사', time: '10:30' }, { me: true, text: '질문', time: '10:31' }],
  CH0069: [{ me: false, text: '미카', time: '09:00' }],
});
const open = options => ChatTranscript.open({ indexedDB: new IDBFactory(), ...options });
const clock = createdAt => {
  const date = new Date(createdAt);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

test('legacy snapshots migrate once and seed greetings only when the room is empty', async () => {
  const transcript = await open({ legacyRaw: legacy });
  assert.equal(transcript.migrationReport.imported, 3);
  const seeded = await transcript.seed([{ roomId: 'Arona', speakerType: 'character', text: '안녕하세요!', sourceKind: 'app' },
    { roomId: 'Yuuka', speakerType: 'character', text: '다시 인사', sourceKind: 'app' }]);
  assert.deepEqual(seeded.map(message => message.text), ['안녕하세요!']);
  const cache = await transcript.load('Arona');
  assert.deepEqual(cache.messages.map(message => [message.me, message.text]), [[false, '안녕하세요!']]);
  transcript.close();
});

test('room summaries map stored records and sort by recent activity', async () => {
  const transcript = await open({ legacyRaw: JSON.stringify({ Yuuka: [{ me: false, text: '인사', time: '10:30' }] }) });
  const future = Date.now() + 3_600_000;
  await transcript.append('Arona', { speakerType: 'character', text: '새 인사', sourceKind: 'app', createdAt: future });
  await transcript.append('CH0069', { speakerType: 'character', text: '같은 시각', sourceKind: 'app', createdAt: future + 1 });
  await transcript.append('Aris', { speakerType: 'user', text: '같은 시각', sourceKind: 'user-input', createdAt: future + 1 });
  await transcript.refreshSummaries();
  const summaries = transcript.summaries();
  // Newest activity first; equal timestamps fall back to room id order.
  assert.deepEqual(summaries.map(summary => summary.roomId), ['Aris', 'CH0069', 'Arona', 'Yuuka']);
  assert.equal(summaries[2].last.time, clock(future));
  assert.equal(summaries[2].last.me, false);
  assert.equal(summaries[2].userMessageCount, 0);
  assert.equal(summaries[0].userMessageCount, 1);
  assert.equal(summaries[3].last.time, '10:30');
  assert.equal(summaries[3].last.createdAt, null);
  transcript.close();
});

test('paged reads keep order, expose older pages and stay bounded in memory', async () => {
  const raw = JSON.stringify({ Big: Array.from({ length: ROOM_PAGE * 2 + 10 }, (_, i) => ({ me: i % 2 === 0, text: `m${i}` })) });
  const second = await open({ legacyRaw: raw });
  const cache = await second.load('Big');
  assert.equal(cache.messages.length, ROOM_PAGE);
  assert.equal(cache.messages.at(-1).text, `m${ROOM_PAGE * 2 + 9}`);
  assert.equal(cache.hasMore, true);
  const older = await second.loadOlder('Big');
  assert.equal(older.messages.length, ROOM_PAGE * 2);
  assert.deepEqual(older.messages.slice(-2).map(message => message.text), [`m${ROOM_PAGE * 2 + 8}`, `m${ROOM_PAGE * 2 + 9}`]);
  assert.equal(older.messages[0].text, 'm10');
  assert.equal(older.hasMore, true);
  const oldest = await second.loadOlder('Big');
  assert.equal(oldest.hasMore, false);
  assert.equal(oldest.messages[0].text, 'm0');
  assert.equal(oldest.messages.length, ROOM_PAGE * 2 + 10);
  // Loading more pages than the window keeps the newest ROOM_CACHE rows and remembers older ones exist.
  const wide = await open({ legacyRaw: JSON.stringify({ Wide: Array.from({ length: 1_000 }, (_, i) => ({ me: true, text: `${i}` })) }) });
  await wide.load('Wide');
  for (let i = 0; i < 20; i++) await wide.loadOlder('Wide');
  const bounded = wide.cached('Wide');
  assert.equal(bounded.messages.length, ROOM_CACHE);
  assert.equal(bounded.hasMore, true);
  assert.equal(bounded.messages.at(-1).text, '999');
  second.close(); wide.close();
});

test('appends update the cache, the room count and the retry target', async () => {
  const transcript = await open();
  await transcript.load('Aris');
  await transcript.append('Aris', { speakerType: 'user', text: '아리스야', sourceKind: 'user-input', createdAt: 5 });
  assert.deepEqual(transcript.retryTarget('Aris').text, '아리스야');
  assert.equal(transcript.cached('Aris').userMessageCount, 1);
  await transcript.append('Aris', { speakerType: 'character', text: '네!', sourceKind: 'model-output', createdAt: 6 });
  assert.equal(transcript.retryTarget('Aris'), null);
  assert.deepEqual(transcript.summaries().map(summary => [summary.roomId, summary.userMessageCount]), [['Aris', 1]]);
  // A duplicate id is rejected without touching the rendered window.
  await assert.rejects(transcript.append('Aris', { id: transcript.cached('Aris').messages.at(-1).id, speakerType: 'character', text: '중복', sourceKind: 'model-output' }),
    { name: 'ConstraintError' });
  assert.equal(transcript.cached('Aris').messages.length, 2);
  transcript.close();
});

test('deletion clears the window and summaries, and a deleted room can start over', async () => {
  const transcript = await open({ legacyRaw: legacy });
  await transcript.load('Yuuka');
  await transcript.refreshSummaries();
  assert.deepEqual(await transcript.deleteRoom('Yuuka'), { messages: 2, memories: 0 });
  assert.equal(transcript.cached('Yuuka'), null);
  assert.deepEqual(transcript.summaries().map(summary => summary.roomId), ['CH0069']);
  await transcript.append('Yuuka', { speakerType: 'user', text: '새 시작', sourceKind: 'user-input', createdAt: 7 });
  const restarted = await transcript.load('Yuuka');
  assert.deepEqual(restarted.messages.map(message => message.text), ['새 시작']);
  assert.deepEqual(await transcript.deleteAll(), { rooms: 2, messages: 2, memories: 0 });
  assert.deepEqual(transcript.summaries(), []);
  transcript.close();
});

test('export and import round-trip through the session without stale cache', async () => {
  const transcript = await open({ legacyRaw: legacy });
  await transcript.load('Yuuka');
  const bundle = await transcript.exportBundle(42);
  const restored = await open();
  assert.deepEqual(await restored.importBundle(bundle), { rooms: 2, messages: 3, memories: 0 });
  assert.deepEqual(await restored.load('Yuuka'), await transcript.load('Yuuka'));
  assert.deepEqual(restored.summaries().map(summary => summary.roomId), ['CH0069', 'Yuuka']);
  transcript.close(); restored.close();
});

test('view mapping never invents dates for legacy rows and never uses labels for new ones', () => {
  assert.deepEqual(viewMessage({ id: 'a', speakerType: 'user', text: 'x', status: 'complete', sourceKind: 'legacy-unknown',
    createdAt: null, legacyTimeLabel: '10:31' }),
  { id: 'a', me: true, text: 'x', time: '10:31', status: 'complete', speakerType: 'user', sourceKind: 'legacy-unknown', createdAt: null, importedAt: null });
  const mapped = viewMessage({ id: 'b', speakerType: 'character', text: 'y', status: 'complete', sourceKind: 'script',
    createdAt: 1_700_000_000_000, legacyTimeLabel: null, importedAt: 5 });
  assert.equal(mapped.time, clock(1_700_000_000_000));
  assert.equal(mapped.importedAt, 5);
});
