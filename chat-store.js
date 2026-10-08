export const CHAT_DB_NAME = 'molu-chat-memory';
export const CHAT_DB_VERSION = 2;
const MIGRATION_KEY = 'legacy-momotalk-v1';
const SOURCES = new Set(['user-input', 'model-output', 'script', 'app', 'legacy-unknown']);
const STATUSES = new Set(['complete', 'pending', 'failed', 'cancelled', 'interrupted']);
export const BUNDLE_FORMAT = 'molu-chat-memory';
export const BUNDLE_VERSION = 2;
export const MEMORY_MAX_LENGTH = 500;
const MEMORY_FIELDS = new Set(['id', 'profileId', 'roomId', 'text', 'sourceMessageId', 'sourceText', 'createdAt', 'updatedAt', 'enabled', 'expiresAt']);
const BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const BUNDLE_MAX_ROOMS = 2_000;
const BUNDLE_MAX_MESSAGES = 100_000;
const SPEAKER_TYPES = ['user', 'character', 'app'];
const ROOM_FIELDS = new Set(['id', 'profileId', 'characterId', 'participants', 'nextSeq', 'revision', 'userMessageCount', 'lastMessageId']);
const MESSAGE_FIELDS = new Set(['id', 'profileId', 'roomId', 'seq', 'speakerId', 'speakerType', 'text', 'sourceKind',
  'status', 'createdAt', 'replyToMessageId', 'importedAt', 'legacyTimeLabel', 'legacyData']);

function conflict(message) {
  const error = new Error(message);
  error.name = 'ChatStorageConflict';
  return error;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError(`${label}이 올바르지 않습니다.`);
  return value;
}
function content(value) {
  if (typeof value !== 'string' || value.length > 100_000) throw new TypeError('메시지 본문이 올바르지 않습니다.');
  return value; // Preserve the original text, including whitespace.
}
function roomRecord(id) {
  return { id, profileId: 'local', characterId: id, participants: ['sensei', id],
    nextSeq: 1, revision: 0, userMessageCount: 0, lastMessageId: null };
}

// Normalize outside the transaction. Invalid records remain available in the exact raw snapshot.
export function normalizeLegacyTranscript(raw, importedAt = Date.now()) {
  if (raw !== null && (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024)) {
    throw new TypeError('기존 대화 snapshot이 올바르지 않거나 너무 큽니다.');
  }
  if (!Number.isSafeInteger(importedAt) || importedAt < 0) throw new TypeError('이관 시각이 올바르지 않습니다.');
  const parsed = raw === null ? {} : JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new TypeError('기존 대화 형식이 올바르지 않습니다.');
  const entries = Array.isArray(parsed) ? [['Arona', parsed]] : Object.entries(parsed);
  const rooms = [], messages = [], issues = [];
  for (const [roomId, records] of entries) {
    if (!roomId || roomId.length > 256 || !Array.isArray(records)) {
      issues.push({ roomId, index: null, reason: '대화방 ID 또는 메시지 배열이 올바르지 않음' });
      continue;
    }
    const room = roomRecord(roomId);
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          typeof record.text !== 'string' || record.text.length > 100_000 || typeof record.me !== 'boolean' ||
          (record.pending !== undefined && typeof record.pending !== 'boolean') ||
          (record.time !== undefined && (typeof record.time !== 'string' || record.time.length > 100))) {
        issues.push({ roomId, index, reason: '본문·화자·시간·pending 형식이 올바르지 않음' });
        return;
      }
      const message = {
        id: `legacy:${encodeURIComponent(roomId)}:${index}`, profileId: 'local', roomId,
        seq: room.nextSeq++, speakerId: record.me ? 'sensei' : roomId,
        speakerType: record.me ? 'user' : 'character', text: record.text,
        status: record.pending ? 'pending' : 'complete', sourceKind: 'legacy-unknown',
        createdAt: null, importedAt, legacyTimeLabel: record.time ?? null,
        legacyData: record, replyToMessageId: null,
      };
      messages.push(message);
      if (record.me) room.userMessageCount++;
      room.lastMessageId = message.id;
    });
    rooms.push(room);
  }
  return { rooms, messages, report: { imported: messages.length, rooms: rooms.length,
    rejected: issues.length, issues, importedAt } };
}

// Backup files are validated strictly before a single atomic write. Unknown fields are version errors,
// not silently dropped extensions: a newer format must bump BUNDLE_VERSION instead of reusing v1.
export function parseChatBundle(raw) {
  if (typeof raw !== 'string' || raw.length > BUNDLE_MAX_BYTES) throw new TypeError('백업 파일이 올바르지 않거나 너무 큽니다.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new TypeError('백업 파일의 JSON을 읽을 수 없습니다.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      parsed.format !== BUNDLE_FORMAT || parsed.version !== BUNDLE_VERSION ||
      !Number.isSafeInteger(parsed.exportedAt) || parsed.exportedAt < 0 ||
      !Array.isArray(parsed.rooms) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.memories) ||
      Object.keys(parsed).some(key => !['format', 'version', 'exportedAt', 'rooms', 'messages', 'memories'].includes(key))) {
    throw new TypeError('지원하지 않는 백업 형식입니다.');
  }
  if (parsed.rooms.length > BUNDLE_MAX_ROOMS || parsed.messages.length > BUNDLE_MAX_MESSAGES ||
      parsed.memories.length > BUNDLE_MAX_MESSAGES) {
    throw new TypeError('백업 파일의 기록 수가 한도를 넘습니다.');
  }
  const rooms = new Map();
  for (const room of parsed.rooms) {
    if (!room || typeof room !== 'object' || Array.isArray(room) ||
        Object.keys(room).some(key => !ROOM_FIELDS.has(key)) || room.profileId !== 'local' ||
        !room.id || room.id.length > 256 || !room.characterId || room.characterId.length > 256 ||
        !Array.isArray(room.participants) || !room.participants.length || room.participants.length > 8 ||
        room.participants.some(value => typeof value !== 'string' || !value || value.length > 256) ||
        !Number.isSafeInteger(room.nextSeq) || room.nextSeq < 1 ||
        !Number.isSafeInteger(room.revision) || room.revision < 0 ||
        !Number.isSafeInteger(room.userMessageCount) || room.userMessageCount < 0 ||
        (room.lastMessageId !== null && typeof room.lastMessageId !== 'string')) {
      throw new TypeError('백업 파일의 대화방 정보가 올바르지 않습니다.');
    }
    if (rooms.has(room.id)) throw new TypeError('백업 파일에 중복된 대화방 ID가 있습니다.');
    rooms.set(room.id, room);
  }
  const ids = new Set();
  const seqs = new Map();
  const counts = new Map();
  const lastIds = new Map();
  const messages = [];
  for (const message of parsed.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        Object.keys(message).some(key => !MESSAGE_FIELDS.has(key)) || message.profileId !== 'local' ||
        !rooms.has(message.roomId) || !SPEAKER_TYPES.includes(message.speakerType) ||
        !message.id || message.id.length > 256 || ids.has(message.id) ||
        !message.speakerId || message.speakerId.length > 256 ||
        typeof message.text !== 'string' || message.text.length > 100_000 ||
        !SOURCES.has(message.sourceKind) || !STATUSES.has(message.status) ||
        !Number.isSafeInteger(message.seq) || message.seq < 1 ||
        (message.createdAt !== null && (!Number.isSafeInteger(message.createdAt) || message.createdAt < 0)) ||
        (message.replyToMessageId !== null && typeof message.replyToMessageId !== 'string') ||
        (message.importedAt !== undefined && (!Number.isSafeInteger(message.importedAt) || message.importedAt < 0)) ||
        (message.legacyTimeLabel !== undefined && message.legacyTimeLabel !== null &&
          (typeof message.legacyTimeLabel !== 'string' || message.legacyTimeLabel.length > 100))) {
      throw new TypeError('백업 파일의 메시지 정보가 올바르지 않습니다.');
    }
    if (message.legacyData !== undefined && JSON.stringify(message.legacyData ?? null)?.length > 20_000) {
      throw new TypeError('백업 파일의 원본 메시지 정보가 너무 큽니다.');
    }
    const roomSeq = seqs.get(message.roomId) ?? new Set();
    if (roomSeq.has(message.seq)) throw new TypeError('백업 파일에 같은 방의 중복된 순서가 있습니다.');
    roomSeq.add(message.seq);
    seqs.set(message.roomId, roomSeq);
    ids.add(message.id);
    counts.set(message.roomId, (counts.get(message.roomId) ?? 0) + (message.speakerType === 'user' ? 1 : 0));
    if ((lastIds.get(message.roomId)?.seq ?? 0) < message.seq) lastIds.set(message.roomId, { seq: message.seq, id: message.id });
    messages.push(message);
  }
  for (const room of rooms.values()) {
    const last = lastIds.get(room.id) ?? null;
    if (room.nextSeq !== (last?.seq ?? 0) + 1 || room.userMessageCount !== (counts.get(room.id) ?? 0) ||
        room.lastMessageId !== (last?.id ?? null)) {
      throw new TypeError('백업 파일의 대화방 진행 정보가 메시지와 다릅니다.');
    }
  }
  messages.sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : a.seq - b.seq);
  const memoryIds = new Set();
  const memories = parsed.memories.map(memory => {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory) ||
        Object.keys(memory).some(key => !MEMORY_FIELDS.has(key)) || memory.profileId !== 'local' ||
        !rooms.has(memory.roomId) || typeof memory.text !== 'string' || !memory.text.trim() || memory.text.length > MEMORY_MAX_LENGTH ||
        !memory.id || memory.id.length > 256 || memoryIds.has(memory.id) ||
        (memory.sourceMessageId !== null && (typeof memory.sourceMessageId !== 'string' || !ids.has(memory.sourceMessageId))) ||
        (memory.sourceText !== null && (typeof memory.sourceText !== 'string' || memory.sourceText.length > 2_000)) ||
        typeof memory.enabled !== 'boolean' ||
        !Number.isSafeInteger(memory.createdAt) || memory.createdAt < 0 ||
        !Number.isSafeInteger(memory.updatedAt) || memory.updatedAt < 0 ||
        (memory.expiresAt !== null && (!Number.isSafeInteger(memory.expiresAt) || memory.expiresAt < 0))) {
      throw new TypeError('백업 파일의 기억 정보가 올바르지 않습니다.');
    }
    memoryIds.add(memory.id);
    return memory;
  });
  memories.sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : a.createdAt - b.createdAt);
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: parsed.exportedAt,
    rooms: [...rooms.values()], messages, memories };
}

export function openChatStore({ indexedDB = globalThis.indexedDB, name = CHAT_DB_NAME, onBlocked = () => {} } = {}) {
  if (!indexedDB) return Promise.reject(new Error('이 브라우저에서 IndexedDB를 사용할 수 없습니다.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, CHAT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 버전이 올라갈 때 기존 store는 그대로 두고 새 store만 만든다.
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('rooms')) db.createObjectStore('rooms', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('roomSeq', ['roomId', 'seq'], { unique: true });
      }
      if (!db.objectStoreNames.contains('memories')) {
        const memories = db.createObjectStore('memories', { keyPath: 'id' });
        memories.createIndex('roomCreated', ['roomId', 'createdAt']);
        memories.createIndex('sourceMessage', 'sourceMessageId');
      }
    };
    request.onblocked = onBlocked;
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(new ChatStore(request.result));
  });
}

class ChatStore {
  #db;
  constructor(db) {
    this.#db = db;
    db.onversionchange = () => this.close();
    db.onclose = () => { this.#db = null; };
  }
  close() { this.#db?.close(); this.#db = null; }

  // Queue only IDB requests synchronously or from their callbacks; never await model/network work.
  #transaction(stores, mode, enqueue) {
    return new Promise((resolve, reject) => {
      if (!this.#db) { reject(new Error('대화 저장소 연결이 닫혔습니다. 다시 열어 주세요.')); return; }
      const tx = this.#db.transaction(stores, mode);
      let result, failure;
      const fail = error => { failure = error; tx.abort(); };
      // Request success is provisional; report writes only after the transaction commits.
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('대화 저장이 중단되었습니다.', 'AbortError'));
      try { enqueue(tx, value => { result = value; }, fail); }
      catch (error) { fail(error); }
    });
  }

  migrateLegacy(raw, { importedAt = Date.now() } = {}) {
    const normalized = normalizeLegacyTranscript(raw, importedAt);
    return this.#transaction(['meta', 'rooms', 'messages'], 'readwrite', (tx, done, fail) => {
      const meta = tx.objectStore('meta');
      const marker = meta.get(MIGRATION_KEY);
      marker.onsuccess = () => {
        if (marker.result) {
          if (marker.result.raw !== raw) { fail(conflict('기존 대화가 이관 snapshot과 다릅니다. 자동 병합하지 않습니다.')); return; }
          done(marker.result.report);
          return;
        }
        const roomsCount = tx.objectStore('rooms').count();
        roomsCount.onsuccess = () => {
          const count = tx.objectStore('messages').count();
          count.onsuccess = () => {
            if (count.result || roomsCount.result) { fail(conflict('기록이 있는 DB에 기존 대화를 자동 이관할 수 없습니다.')); return; }
            for (const room of normalized.rooms) tx.objectStore('rooms').add(room);
            for (const message of normalized.messages) tx.objectStore('messages').add(message);
            meta.add({ key: MIGRATION_KEY, raw, report: normalized.report });
            done(normalized.report);
          };
        };
      };
    });
  }

  getMigration() {
    return this.#transaction(['meta'], 'readonly', (tx, done) => {
      const request = tx.objectStore('meta').get(MIGRATION_KEY);
      request.onsuccess = () => done(request.result ?? null);
    });
  }
  getRoom(roomId) {
    identifier(roomId, '대화방');
    return this.#transaction(['rooms'], 'readonly', (tx, done) => {
      const request = tx.objectStore('rooms').get(roomId);
      request.onsuccess = () => done(request.result ?? null);
    });
  }
  listRooms() {
    return this.#transaction(['rooms'], 'readonly', (tx, done) => {
      const request = tx.objectStore('rooms').getAll();
      request.onsuccess = () => done(request.result);
    });
  }
  readMessages(roomId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    identifier(roomId, '대화방');
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('메시지 조회 범위가 올바르지 않습니다.');
    }
    return this.#transaction(['messages'], 'readonly', (tx, done) => {
      const rows = [];
      // Index seek avoids loading/scanning all rooms. Stop after one page, returned oldest-first.
      const request = tx.objectStore('messages').index('roomSeq').openCursor(undefined, 'prev');
      let sought = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(rows.reverse()); return; }
        if (!sought) {
          sought = true;
          const [id, seq] = cursor.key;
          if (id > roomId || (id === roomId && seq >= before)) {
            cursor.continue([roomId, before - 1]);
            return;
          }
        }
        if (cursor.key[0] !== roomId || cursor.key[1] >= before) { done(rows.reverse()); return; }
        rows.push(cursor.value);
        if (rows.length === limit) done(rows.reverse());
        else cursor.continue();
      };
    });
  }

  appendMessage({ roomId, id = globalThis.crypto.randomUUID(), speakerType, text, sourceKind,
    status = 'complete', createdAt = Date.now() }, { expectedRevision, expectedLastMessageId } = {}) {
    if (expectedLastMessageId !== undefined) identifier(expectedLastMessageId, '응답 대상');
    identifier(roomId, '대화방'); identifier(id, '메시지 ID'); content(text);
    if (!['user', 'character', 'app'].includes(speakerType) || !SOURCES.has(sourceKind) || !STATUSES.has(status) ||
        !Number.isSafeInteger(createdAt) || createdAt < 0 ||
        (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
      throw new TypeError('메시지 메타데이터가 올바르지 않습니다.');
    }
    return this.#transaction(['rooms', 'messages'], 'readwrite', (tx, done, fail) => {
      const rooms = tx.objectStore('rooms');
      const request = rooms.get(roomId);
      request.onsuccess = () => {
        const room = request.result ?? roomRecord(roomId);
        if ((expectedRevision !== undefined && room.revision !== expectedRevision) ||
            (expectedLastMessageId !== undefined && room.lastMessageId !== expectedLastMessageId)) {
          fail(conflict('대화방이 변경되었습니다. 다시 읽은 뒤 저장해 주세요.')); return;
        }
        const message = { id, profileId: 'local', roomId, seq: room.nextSeq++,
          speakerId: speakerType === 'user' ? 'sensei' : speakerType === 'app' ? 'app' : roomId,
          speakerType, text, sourceKind, status, createdAt, replyToMessageId: null };
        room.revision++;
        if (speakerType === 'user') room.userMessageCount++;
        room.lastMessageId = id;
        tx.objectStore('messages').add(message);
        rooms.put(room);
        done(message);
      };
    });
  }

  memoryRecord({ id = globalThis.crypto.randomUUID(), roomId, text, sourceMessageId = null, sourceText = null,
    expiresAt = null, enabled = true, createdAt = Date.now(), updatedAt = createdAt }) {
    identifier(roomId, '대화방'); identifier(id, '기억 ID');
    if (typeof text !== 'string' || !text.trim() || text.length > MEMORY_MAX_LENGTH) {
      throw new TypeError(`기억은 1~${MEMORY_MAX_LENGTH}자로 입력해 주세요.`);
    }
    if (sourceMessageId !== null && (typeof sourceMessageId !== 'string' || !sourceMessageId || sourceMessageId.length > 256)) {
      throw new TypeError('기억 출처 메시지 ID가 올바르지 않습니다.');
    }
    if (sourceText !== null && (typeof sourceText !== 'string' || sourceText.length > 2_000)) {
      throw new TypeError('기억 출처 본문이 올바르지 않습니다.');
    }
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new TypeError('기억 만료 시각이 올바르지 않습니다.');
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new TypeError('기억 상태가 올바르지 않습니다.');
    }
    return { id, profileId: 'local', roomId, text, sourceMessageId, sourceText, createdAt, updatedAt, enabled, expiresAt };
  }

  saveMemory(payload) {
    const record = this.memoryRecord(payload);
    return this.#transaction(['memories'], 'readwrite', (tx, done) => {
      tx.objectStore('memories').put(record);
      done(record);
    });
  }

  updateMemory(id, patch) {
    identifier(id, '기억 ID');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !['text', 'enabled', 'expiresAt'].includes(key))) {
      throw new TypeError('기억 수정 항목이 올바르지 않습니다.');
    }
    return this.#transaction(['memories'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('memories');
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) { fail(new Error('없는 기억입니다.')); return; }
        let updated;
        try { updated = this.memoryRecord({ ...request.result, ...patch, updatedAt: Date.now() }); }
        catch (error) { fail(error); return; }
        store.put(updated);
        done(updated);
      };
    });
  }

  getMemory(id) {
    identifier(id, '기억 ID');
    return this.#transaction(['memories'], 'readonly', (tx, done) => {
      const request = tx.objectStore('memories').get(id);
      request.onsuccess = () => done(request.result ?? null);
    });
  }

  listMemories(roomId) {
    identifier(roomId, '대화방');
    return this.#transaction(['memories'], 'readonly', (tx, done) => {
      const rows = [];
      const request = tx.objectStore('memories').index('roomCreated').openCursor();
      let sought = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(rows); return; }
        if (!sought) {
          sought = true;
          if (cursor.key[0] !== roomId) {
            // 현재 위치보다 작은 키로 continue하면 DataError가 난다.
            if (cursor.key[0] > roomId) { done(rows); return; }
            cursor.continue([roomId]);
            return;
          }
        }
        if (cursor.key[0] !== roomId) { done(rows); return; }
        rows.push(cursor.value);
        cursor.continue();
      };
    });
  }

  deleteMemory(id) {
    identifier(id, '기억 ID');
    return this.#transaction(['memories'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('memories');
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) { done(false); return; }
        store.delete(id);
        done(true);
      };
    });
  }

  // Room deletion is idempotent: the caller may already have deleted it in another tab.
  deleteRoom(roomId) {
    identifier(roomId, '대화방');
    return this.#transaction(['rooms', 'messages', 'memories'], 'readwrite', (tx, done) => {
      const rooms = tx.objectStore('rooms');
      const request = rooms.get(roomId);
      request.onsuccess = () => {
        if (!request.result) { done({ messages: 0, memories: 0 }); return; }
        const keys = [];
        const memoryKeys = [];
        // Seek straight to the room's first sequence instead of scanning every room's messages.
        const cursorRequest = tx.objectStore('messages').index('roomSeq').openKeyCursor();
        let sought = false;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          const finish = () => {
            const messages = tx.objectStore('messages');
            for (const key of keys) messages.delete(key);
            rooms.delete(roomId);
            // 파생 기억은 출처가 사라지면 함께 무효화한다.
            const memories = tx.objectStore('memories');
            const memoryRequest = memories.index('roomCreated').openKeyCursor();
            let memorySought = false;
            memoryRequest.onsuccess = () => {
              const memoryCursor = memoryRequest.result;
              const finishMemories = () => {
                for (const key of memoryKeys) memories.delete(key);
                done({ messages: keys.length, memories: memoryKeys.length });
              };
              if (!memoryCursor) { finishMemories(); return; }
              if (!memorySought) {
                memorySought = true;
                if (memoryCursor.key[0] !== roomId) {
                  if (memoryCursor.key[0] > roomId) { finishMemories(); return; }
                  memoryCursor.continue([roomId]);
                  return;
                }
              }
              if (memoryCursor.key[0] !== roomId) { finishMemories(); return; }
              memoryKeys.push(memoryCursor.primaryKey);
              memoryCursor.continue();
            };
          };
          if (!cursor) { finish(); return; }
          if (!sought) {
            sought = true;
            if (cursor.key[0] !== roomId) {
              if (cursor.key[0] > roomId) { finish(); return; }
              cursor.continue([roomId]);
              return;
            }
          }
          if (cursor.key[0] !== roomId) { finish(); return; }
          keys.push(cursor.primaryKey);
          cursor.continue();
        };
      };
    });
  }

  deleteAll() {
    return this.#transaction(['rooms', 'messages', 'memories'], 'readwrite', (tx, done) => {
      const rooms = tx.objectStore('rooms');
      const messages = tx.objectStore('messages');
      const memories = tx.objectStore('memories');
      const counts = {};
      const roomCount = rooms.count();
      roomCount.onsuccess = () => {
        counts.rooms = roomCount.result;
        const messageCount = messages.count();
        messageCount.onsuccess = () => {
          counts.messages = messageCount.result;
          const memoryCount = memories.count();
          memoryCount.onsuccess = () => {
            counts.memories = memoryCount.result;
            rooms.clear();
            messages.clear();
            memories.clear();
            done(counts);
          };
        };
      };
    });
  }

  exportBundle(exportedAt = Date.now()) {
    if (!Number.isSafeInteger(exportedAt) || exportedAt < 0) throw new TypeError('내보내기 시각이 올바르지 않습니다.');
    return this.#transaction(['rooms', 'messages', 'memories'], 'readonly', (tx, done, fail) => {
      const rooms = tx.objectStore('rooms').getAll();
      const messages = tx.objectStore('messages').getAll();
      const memories = tx.objectStore('memories').getAll();
      rooms.onsuccess = () => {
        messages.onsuccess = () => {
          memories.onsuccess = () => {
            if (messages.result.length > BUNDLE_MAX_MESSAGES) {
              fail(new Error('내보낼 메시지가 한도를 넘습니다.')); return;
            }
            const bundle = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt,
              rooms: rooms.result,
              messages: messages.result.slice().sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : a.seq - b.seq),
              memories: memories.result.slice().sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : a.createdAt - b.createdAt) };
            const text = JSON.stringify(bundle);
            if (text.length > BUNDLE_MAX_BYTES) { fail(new Error('내보낼 백업이 크기 한도를 넘습니다.')); return; }
            done(text);
          };
        };
      };
    });
  }

  // Restore is explicit and never merges: a nonempty transcript needs replace:true from the user's own confirm.
  importBundle(raw, { replace = false } = {}) {
    const bundle = parseChatBundle(raw);
    return this.#transaction(['rooms', 'messages', 'memories'], 'readwrite', (tx, done, fail) => {
      const rooms = tx.objectStore('rooms');
      const messages = tx.objectStore('messages');
      const memories = tx.objectStore('memories');
      const roomCount = rooms.count();
      roomCount.onsuccess = () => {
        const messageCount = messages.count();
        messageCount.onsuccess = () => {
          const memoryCount = memories.count();
          memoryCount.onsuccess = () => {
            if ((roomCount.result || messageCount.result || memoryCount.result) && !replace) {
              fail(conflict('기록이 있는 상태에서는 백업을 가져올 수 없습니다. 먼저 기록을 삭제해 주세요.')); return;
            }
            if (roomCount.result || messageCount.result || memoryCount.result) { rooms.clear(); messages.clear(); memories.clear(); }
            for (const room of bundle.rooms) rooms.add(room);
            for (const message of bundle.messages) messages.add(message);
            for (const memory of bundle.memories) memories.add(memory);
            done({ rooms: bundle.rooms.length, messages: bundle.messages.length, memories: bundle.memories.length });
          };
        };
      };
    });
  }
}
