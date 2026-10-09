import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { openChatStore, normalizeLegacyTranscript, parseChatBundle } from '../../src/lib/chat/store.ts';

const fresh = () => openChatStore({ indexedDB: new IDBFactory() });
const append = (store, roomId, text, id, options) => store.appendMessage({
  roomId, id, text, speakerType: 'user', sourceKind: 'user-input', createdAt: 123,
}, options);
const legacy = JSON.stringify({
  Yuuka: [{ me: false, text: '인사', time: '10:30' }, { me: true, text: '  질문\n', time: '10:31', custom: 42 },
    { me: false, text: '답변', time: '10:32' }, { me: true, text: '재시도', pending: true }],
  CH0069: [{ me: false, text: '미카' }],
});

test('legacy normalization retains exact text, source uncertainty, unknown dates and pending progress', () => {
  const result = normalizeLegacyTranscript(legacy, 456);
  assert.equal(result.report.imported, 5);
  assert.equal(result.report.rejected, 0);
  assert.equal(result.rooms[0].userMessageCount, 2);
  const message = result.messages[1];
  assert.equal(message.text, '  질문\n');
  assert.equal(message.createdAt, null);
  assert.equal(message.importedAt, 456);
  assert.equal(message.legacyTimeLabel, '10:31');
  assert.equal(message.legacyData.custom, 42);
  assert.equal(message.sourceKind, 'legacy-unknown');
  assert.equal(result.messages[3].status, 'pending');
  assert.equal(normalizeLegacyTranscript('[{"me":false,"text":"아로나"}]').rooms[0].id, 'Arona');
});

test('malformed records are reported, unknown rooms stay separate, special keys are not prototypes', () => {
  const raw = '{"Unknown":[{"text":"화자 없음"},{"me":true,"text":"보존"},null],"__proto__":[{"me":false,"text":"별도 방"}],"bad":42}';
  const result = normalizeLegacyTranscript(raw);
  assert.equal(result.report.rejected, 3);
  assert.equal(result.report.imported, 2);
  assert.deepEqual(result.rooms.map(room => room.id), ['Unknown', '__proto__']);
  assert.throws(() => normalizeLegacyTranscript('{'));
  assert.throws(() => normalizeLegacyTranscript('null'));
  assert.throws(() => normalizeLegacyTranscript('42'));
  assert.throws(() => normalizeLegacyTranscript(4));
});

test('migration is atomic, snapshot-bound, repeatable, and persists across connections', async () => {
  const indexedDB = new IDBFactory();
  const store = await openChatStore({ indexedDB });
  const report = await store.migrateLegacy(legacy, { importedAt: 456 });
  assert.deepEqual(await store.migrateLegacy(legacy, { importedAt: 789 }), report);
  assert.equal((await store.readMessages('Yuuka')).length, 4);
  assert.equal((await store.readMessages('CH0069'))[0].speakerId, 'CH0069');
  assert.equal((await store.getRoom('Yuuka')).userMessageCount, 2);
  await assert.rejects(store.migrateLegacy('{}'), { name: 'ChatStorageConflict' });
  assert.equal((await store.getMigration()).raw, legacy);
  store.close();
  const reopened = await openChatStore({ indexedDB });
  assert.equal((await reopened.readMessages('Yuuka'))[1].text, '  질문\n');
  assert.equal((await reopened.listRooms()).length, 2);
  reopened.close();
});

test('rejected input remains recoverable in the exact migration snapshot', async () => {
  const store = await fresh();
  const raw = JSON.stringify({ Yuuka: [null, { text: '화자 불명' }, { me: true, text: '정상' }] });
  assert.equal((await store.migrateLegacy(raw)).rejected, 2);
  assert.equal((await store.getMigration()).raw, raw);
  assert.equal((await store.readMessages('Yuuka')).length, 1);
  store.close();
});

test('aborted migration leaves no marker or records and can be explicitly retried', async () => {
  const store = await fresh();
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = original.apply(this, args);
    if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
    return tx;
  };
  try { await assert.rejects(store.migrateLegacy(legacy), { name: 'AbortError' }); }
  finally { IDBDatabase.prototype.transaction = original; }
  assert.equal(await store.getMigration(), null);
  assert.deepEqual(await store.listRooms(), []);
  assert.deepEqual(await store.readMessages('Yuuka'), []);
  assert.equal((await store.migrateLegacy(legacy)).imported, 5);
  store.close();
});

test('never auto-merge a legacy snapshot into a nonempty new transcript', async () => {
  const store = await fresh();
  await append(store, 'Yuuka', '새 기록', 'new');
  await assert.rejects(store.migrateLegacy(legacy), { name: 'ChatStorageConflict' });
  assert.equal(await store.getMigration(), null);
  assert.equal((await store.readMessages('Yuuka')).length, 1);
  store.close();
});

test('page reads preserve room isolation/order and do not load all messages', async () => {
  const store = await fresh();
  const raw = JSON.stringify({ A: Array.from({ length: 10_000 }, (_, i) => ({ me: i % 2 === 0, text: String(i) })),
    B: [{ me: true, text: '다른 방' }] });
  await store.migrateLegacy(raw);
  const last = await store.readMessages('A');
  assert.equal(last.length, 50);
  assert.equal(last[0].seq, 9951);
  assert.equal(last.at(-1).seq, 10_000);
  const previous = await store.readMessages('A', { before: last[0].seq, limit: 3 });
  assert.deepEqual(previous.map(message => message.seq), [9948, 9949, 9950]);
  assert.deepEqual(await store.readMessages('A', { before: 1 }), []);
  assert.deepEqual(await store.readMessages('0'), []);
  assert.deepEqual(await store.readMessages('AA'), []);
  assert.deepEqual(await store.readMessages('Z'), []);
  assert.equal((await store.readMessages('B'))[0].text, '다른 방');
  assert.throws(() => store.readMessages('A', { limit: 101 }));
  store.close();
});

test('duplicate IDs roll back room metadata and stale revisions cannot write', async () => {
  const store = await fresh();
  await append(store, 'Yuuka', '첫 질문', 'same', { expectedRevision: 0 });
  await assert.rejects(append(store, 'Yuuka', '중복', 'same'), { name: 'ConstraintError' });
  assert.equal((await store.getRoom('Yuuka')).revision, 1);
  assert.equal((await store.getRoom('Yuuka')).nextSeq, 2);
  await assert.rejects(append(store, 'Yuuka', '이전 화면', 'stale', { expectedRevision: 0 }), { name: 'ChatStorageConflict' });
  assert.equal((await store.readMessages('Yuuka')).length, 1);
  store.close();
});

test('simultaneous connections allocate stable sequence numbers without lost room counts', async () => {
  const indexedDB = new IDBFactory();
  const one = await openChatStore({ indexedDB }), two = await openChatStore({ indexedDB });
  await Promise.all(Array.from({ length: 20 }, (_, i) => append(i % 2 ? one : two, 'Yuuka', String(i), `id-${i}`)));
  const rows = await one.readMessages('Yuuka');
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await two.getRoom('Yuuka')).userMessageCount, 20);
  one.close(); two.close();
});

test('version changes close old connections and blocked opens notify the caller', async () => {
  const indexedDB = new IDBFactory();
  const store = await openChatStore({ indexedDB, name: 'versions' });
  const upgraded = await new Promise((resolve, reject) => {
    const request = indexedDB.open('versions', 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await assert.rejects(store.listRooms(), /닫혔습니다/);
  upgraded.close();
  await assert.rejects(openChatStore({ indexedDB, name: 'versions' }), { name: 'VersionError' });

  const blocker = await new Promise(resolve => {
    const request = indexedDB.open('blocked');
    request.onsuccess = () => resolve(request.result);
  });
  let noticed = false;
  // Force an upgrade over a deliberately held version-1 connection.
  const upgradingFactory = { open: (name, version) => indexedDB.open(name, version + 1) };
  const next = await openChatStore({ indexedDB: upgradingFactory, name: 'blocked',
    onBlocked: () => { noticed = true; blocker.close(); } });
  assert.equal(noticed, true);
  next.close();
});

test('missing DB and closed connections fail explicitly without alternate writes', async () => {
  await assert.rejects(openChatStore({ indexedDB: null }), /IndexedDB/);
  const store = await fresh();
  assert.throws(() => append(store, '', '입력', 'id'));
  assert.throws(() => store.appendMessage({ roomId: 'A', id: 'id', speakerType: 'user', text: 42, sourceKind: 'user-input' }));
  store.close();
  await assert.rejects(store.listRooms(), /닫혔습니다/);
});

test('room deletion removes exactly one room and stays idempotent', async () => {
  const store = await fresh();
  await append(store, 'Yuuka', '하나', 'y1');
  await store.appendMessage({ roomId: 'Yuuka', id: 'y2', speakerType: 'character', text: '둘', sourceKind: 'script' });
  await append(store, 'CH0069', '미카', 'c1');
  assert.deepEqual(await store.deleteRoom('Yuuka'), { messages: 2, memories: 0 });
  assert.equal(await store.getRoom('Yuuka'), null);
  assert.deepEqual(await store.readMessages('Yuuka'), []);
  assert.equal((await store.readMessages('CH0069')).length, 1);
  assert.deepEqual(await store.deleteRoom('Yuuka'), { messages: 0, memories: 0 });
  // A deleted room restarts at sequence 1 without reviving old rows.
  await append(store, 'Yuuka', '다시', 'y3');
  assert.deepEqual((await store.readMessages('Yuuka')).map(row => [row.seq, row.text]), [[1, '다시']]);
  store.close();
});

test('deleteAll clears transcript but keeps the migration marker and its snapshot', async () => {
  const store = await fresh();
  await store.migrateLegacy(legacy, { importedAt: 456 });
  assert.deepEqual(await store.deleteAll(), { rooms: 2, messages: 5, memories: 0 });
  assert.deepEqual(await store.listRooms(), []);
  assert.deepEqual(await store.readMessages('Yuuka'), []);
  assert.equal((await store.getMigration()).raw, legacy);
  // The same snapshot is still the recorded one, so a different transcript cannot silently take its place.
  await assert.rejects(store.migrateLegacy('{}'), { name: 'ChatStorageConflict' });
  store.close();
});

test('export/import round-trips every field, including legacy snapshot data', async () => {
  const store = await fresh();
  await store.migrateLegacy(legacy, { importedAt: 456 });
  await append(store, 'Yuuka', '새 메시지', 'new-1');
  const room = await store.getRoom('Yuuka');
  const exported = await store.exportBundle(789);
  const bundle = parseChatBundle(exported);
  assert.equal(bundle.exportedAt, 789);
  assert.deepEqual(bundle.rooms.find(entry => entry.id === 'Yuuka'), room);
  assert.equal(bundle.messages.length, 6);
  // Sorted by room then sequence, so a restore keeps the same order.
  assert.deepEqual(bundle.messages.filter(row => row.roomId === 'Yuuka').map(row => row.seq), [1, 2, 3, 4, 5]);
  const expected = bundle.messages.find(row => row.id === 'legacy:Yuuka:1');
  assert.equal(expected.legacyTimeLabel, '10:31');
  assert.equal(expected.legacyData.custom, 42);

  const restored = await fresh();
  assert.deepEqual(await restored.importBundle(exported), { rooms: 2, messages: 6, memories: 0 });
  assert.deepEqual(await restored.readMessages('Yuuka'), await store.readMessages('Yuuka'));
  assert.equal((await restored.getRoom('CH0069')).lastMessageId, (await store.getRoom('CH0069')).lastMessageId);
  assert.equal(await restored.exportBundle(789), exported);
  store.close();
  restored.close();
});

test('import refuses nonempty transcripts and malformed bundles', async () => {
  const store = await fresh();
  await append(store, 'Yuuka', '기존', 'own-1');
  const good = JSON.parse(await fresh().then(async empty => {
    await empty.migrateLegacy(legacy, { importedAt: 456 });
    return empty.exportBundle(789);
  }));
  await assert.rejects(store.importBundle(JSON.stringify(good)), { name: 'ChatStorageConflict' });
  assert.deepEqual((await store.readMessages('Yuuka')).map(row => row.text), ['기존']);
  store.close();

  const empty = await fresh();
  const corrupt = mutate => {
    const copy = structuredClone(good);
    mutate(copy);
    return JSON.stringify(copy);
  };
  assert.throws(() => parseChatBundle('{'), /JSON/);
  assert.throws(() => parseChatBundle('[]'), /형식/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.version = 3; })), /형식/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.extra = 1; })), /형식/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.messages[0].extra = 1; })), /메시지/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.messages[1].id = bundle.messages[0].id; })), /메시지/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.messages[2].seq = bundle.messages[1].seq; })), /중복된 순서/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.messages[0].roomId = 'Missing'; })), /메시지/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.rooms[0].nextSeq += 1; })), /진행 정보/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.rooms[0].userMessageCount += 1; })), /진행 정보/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.rooms[0].lastMessageId = null; })), /진행 정보/);
  assert.throws(() => parseChatBundle(corrupt(bundle => { bundle.messages[0].text = 'x'.repeat(100_001); })), /메시지/);
  assert.throws(() => parseChatBundle('x'.repeat(32 * 1024 * 1024 + 1)), /큽니다/);
  assert.throws(() => empty.importBundle(corrupt(bundle => { bundle.rooms[0].participants = 'sensei'; })), TypeError);
  assert.deepEqual(await empty.listRooms(), []);
  assert.equal((await empty.importBundle(JSON.stringify(good))).messages, 5);
  empty.close();
});

test('deletion and restore follow the same transaction rules as appends', async () => {
  const store = await fresh();
  await store.migrateLegacy(legacy, { importedAt: 456 });
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = original.apply(this, args);
    if (args[1] === 'readwrite' && args[0].includes('messages') && !args[0].includes('meta')) queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    await assert.rejects(store.deleteRoom('Yuuka'), { name: 'AbortError' });
    assert.equal((await store.readMessages('Yuuka')).length, 4);
    await assert.rejects(store.deleteAll(), { name: 'AbortError' });
    assert.equal((await store.listRooms()).length, 2);
  } finally { IDBDatabase.prototype.transaction = original; }
  assert.deepEqual(await store.deleteAll(), { rooms: 2, messages: 5, memories: 0 });
  assert.equal((await store.exportBundle(1)).includes('"messages":[]'), true);
  store.close();
});

test('memories are stored per room, editable, and exported with their transcript', async () => {
  const store = await fresh();
  await store.migrateLegacy(legacy, { importedAt: 456 });
  const source = (await store.readMessages('Yuuka'))[1];
  const saved = await store.saveMemory({ roomId: 'Yuuka', text: '선생님은 커피를 좋아해', sourceMessageId: source.id, sourceText: source.text, createdAt: 100 });
  assert.equal(saved.updatedAt, 100);
  await store.saveMemory({ roomId: 'Yuuka', text: '두 번째 기억', createdAt: 200 });
  await store.saveMemory({ roomId: 'CH0069', text: '미카 기억', createdAt: 300 });
  assert.deepEqual((await store.listMemories('Yuuka')).map(memory => memory.text), ['선생님은 커피를 좋아해', '두 번째 기억']);
  assert.deepEqual((await store.listMemories('CH0069')).map(memory => memory.text), ['미카 기억']);
  assert.deepEqual(await store.listMemories('Aris'), []);
  assert.equal((await store.getMemory(saved.id)).sourceMessageId, source.id);

  const updated = await store.updateMemory(saved.id, { text: '선생님은 커피를 아주 좋아해', enabled: false, expiresAt: 9_000 });
  assert.equal(updated.text, '선생님은 커피를 아주 좋아해');
  assert.equal(updated.enabled, false);
  assert.equal(updated.expiresAt, 9_000);
  assert.ok(updated.updatedAt >= 100);
  await assert.rejects(store.updateMemory('missing', { text: 'x' }), /없는 기억/);
  assert.throws(() => store.updateMemory(saved.id, { roomId: '다른 방' }), /수정 항목/);
  assert.throws(() => store.saveMemory({ roomId: 'Yuuka', text: '' }), /기억은 1~/);
  assert.throws(() => store.saveMemory({ roomId: 'Yuuka', text: 'x'.repeat(501) }), /기억은 1~/);
  assert.throws(() => store.saveMemory({ roomId: 'Yuuka', text: 'x', expiresAt: 1.5 }), /만료/);

  const exported = JSON.parse(await store.exportBundle(500));
  assert.equal(exported.memories.length, 3);
  const restored = await fresh();
  assert.deepEqual(await restored.importBundle(JSON.stringify(exported)), { rooms: 2, messages: 5, memories: 3 });
  assert.deepEqual(await restored.listMemories('Yuuka'), await store.listMemories('Yuuka'));
  assert.equal(await restored.deleteMemory(saved.id), true);
  assert.equal(await restored.deleteMemory(saved.id), false);
  assert.equal((await restored.listMemories('Yuuka')).length, 1);

  // 잘못된 기억 참조는 백업 가져오기에서 거부된다.
  const broken = structuredClone(exported);
  broken.memories[0].sourceMessageId = 'missing-message';
  assert.throws(() => parseChatBundle(JSON.stringify(broken)), /기억 정보/);
  const unknownRoom = structuredClone(exported);
  unknownRoom.memories[0].roomId = '없는 방';
  assert.throws(() => parseChatBundle(JSON.stringify(unknownRoom)), /기억 정보/);
  const duplicate = structuredClone(exported);
  duplicate.memories[1].id = duplicate.memories[0].id;
  assert.throws(() => parseChatBundle(JSON.stringify(duplicate)), /기억 정보/);
  store.close(); restored.close();
});

test('deleting a room or the transcript invalidates its derived memories', async () => {
  const store = await fresh();
  await store.migrateLegacy(legacy, { importedAt: 456 });
  await store.saveMemory({ roomId: 'Yuuka', text: '유우카 기억', createdAt: 1 });
  await store.saveMemory({ roomId: 'CH0069', text: '미카 기억', createdAt: 2 });
  assert.deepEqual(await store.deleteRoom('Yuuka'), { messages: 4, memories: 1 });
  assert.deepEqual(await store.listMemories('Yuuka'), []);
  assert.equal((await store.listMemories('CH0069')).length, 1);
  assert.deepEqual(await store.deleteAll(), { rooms: 1, messages: 1, memories: 1 });
  assert.deepEqual(await store.listMemories('CH0069'), []);
  assert.deepEqual(await store.deleteRoom('Yuuka'), { messages: 0, memories: 0 });
  store.close();
});

test('v1 databases upgrade to v2 without losing transcript or migration marker', async () => {
  // v1 스키마를 그대로 만들어 둔 뒤 새 코드로 연다.
  const indexedDB = new IDBFactory();
  const legacyDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open('upgrade', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('rooms', { keyPath: 'id' });
      const messages = db.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('roomSeq', ['roomId', 'seq'], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const seed = legacyDb.transaction(['meta', 'rooms', 'messages'], 'readwrite');
  seed.objectStore('meta').add({ key: 'legacy-momotalk-v1', raw: '{}', report: { imported: 0, rooms: 0, rejected: 0, issues: [], importedAt: 1 } });
  seed.objectStore('rooms').add({ id: 'Yuuka', profileId: 'local', characterId: 'Yuuka', participants: ['sensei', 'Yuuka'], nextSeq: 2, revision: 1, userMessageCount: 1, lastMessageId: 'm1' });
  seed.objectStore('messages').add({ id: 'm1', profileId: 'local', roomId: 'Yuuka', seq: 1, speakerId: 'sensei', speakerType: 'user', text: '이전 버전 기록', sourceKind: 'user-input', status: 'complete', createdAt: 10, replyToMessageId: null });
  await new Promise((resolve, reject) => { seed.oncomplete = resolve; seed.onerror = () => reject(seed.error); });
  legacyDb.close();

  const store = await openChatStore({ indexedDB, name: 'upgrade' });
  assert.equal((await store.readMessages('Yuuka'))[0].text, '이전 버전 기록');
  assert.equal((await store.getMigration()).raw, '{}');
  const memory = await store.saveMemory({ roomId: 'Yuuka', text: '업그레이드 뒤 기억', createdAt: 20 });
  assert.equal((await store.listMemories('Yuuka'))[0].id, memory.id);
  store.close();
});
