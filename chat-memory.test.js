import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_LIMIT, MESSAGE_LIMIT, filterMemories, memoryDraftFromMessage, relevance, searchMessages, selectMemories } from './chat-memory.js';

const memory = (roomId, text, overrides = {}) => ({ id: `${roomId}-${text}`, roomId, text, enabled: true, expiresAt: null,
  createdAt: 1, updatedAt: 1, sourceMessageId: null, sourceText: null, ...overrides });

test('relevance scores Korean wording variations above unrelated text', () => {
  assert.ok(relevance('일정 알려줘', '오늘 일정은 3건이에요') > .34);
  assert.ok(relevance('커피 좋아해?', '선생님은 커피를 좋아해') > .34);
  assert.equal(relevance('오늘 일정', '축구 경기 결과'), 0);
  assert.throws(() => relevance('   ', 'x'), /검색어/);
  assert.throws(() => relevance('x'.repeat(201), 'x'), /200자/);
});

test('memories stay room-private and skip disabled or expired rows before ranking', () => {
  const rows = [
    memory('Yuuka', '선생님은 커피를 좋아해'),
    memory('CH0069', '선생님은 커피를 좋아해'),
    memory('Yuuka', '커피 얘기 금지', { enabled: false }),
    memory('Yuuka', '커피는 이제 안 마셔', { expiresAt: 500 }),
  ];
  const selected = selectMemories(rows, { roomId: 'Yuuka', now: 1_000 });
  assert.deepEqual(selected.map(entry => entry.text), ['선생님은 커피를 좋아해']);
  const beforeExpiry = selectMemories(rows, { roomId: 'Yuuka', now: 100 });
  assert.deepEqual(beforeExpiry.map(entry => entry.text), ['선생님은 커피를 좋아해', '커피는 이제 안 마셔']);
  assert.deepEqual(selectMemories(rows, { roomId: 'Aris', now: 1_000 }), []);
  assert.throws(() => selectMemories(rows, { roomId: '', now: 1 }), /대화방/);
  assert.throws(() => selectMemories('nope', { roomId: 'Yuuka' }), /배열/);
});

test('selection prefers relevant memories and respects count and character budgets', () => {
  const rows = [
    memory('Yuuka', '선생님은 회계 장부를 좋아해'),
    memory('Yuuka', '오늘 일정은 세 건이야', { updatedAt: 5 }),
    memory('Yuuka', '내일은 시험 공부를 해야 해', { updatedAt: 9 }),
    memory('Yuuka', 'x'.repeat(60)),
  ];
  const relevant = selectMemories(rows, { roomId: 'Yuuka', query: '일정 알려줘', now: 1_000 });
  assert.deepEqual(relevant.map(entry => entry.text), ['오늘 일정은 세 건이야']);
  const limited = selectMemories(rows, { roomId: 'Yuuka', now: 1_000, limit: 2 });
  assert.deepEqual(limited.map(entry => entry.text), ['내일은 시험 공부를 해야 해', '오늘 일정은 세 건이야']);
  const budget = selectMemories(rows, { roomId: 'Yuuka', now: 1_000, charBudget: 10 });
  assert.ok(budget.every(entry => entry.text.length <= 10));
  assert.ok(budget.length <= MEMORY_LIMIT);
});

test('message search filters by date range, ranks by relevance and caps results', () => {
  const rows = [
    { id: 'a', text: '오늘 일정은 3건이야', createdAt: 1_000 },
    { id: 'b', text: '일정 정리해 줄게', createdAt: 2_000 },
    { id: 'c', text: '다른 이야기', createdAt: 3_000 },
    { id: 'd', text: '일정 메모', importedAt: 4_000, createdAt: null },
  ];
  // 짧은 문장이 dice 점수에서 유리하므로 'd'가 먼저 오고, 나머지는 관련도·최신 순이다.
  assert.deepEqual(searchMessages(rows, { query: '일정' }).map(hit => hit.message.id), ['d', 'b', 'a']);
  assert.deepEqual(searchMessages(rows, { query: '일정', from: 1_500 }).map(hit => hit.message.id), ['d', 'b']);
  assert.deepEqual(searchMessages(rows, { query: '일정', to: 2_500 }).map(hit => hit.message.id), ['b', 'a']);
  assert.equal(searchMessages(rows, { query: '일정', limit: 1 }).length, 1);
  assert.equal(searchMessages(rows, {}).length, 4);
  assert.ok(searchMessages(rows, { query: '일정', limit: MESSAGE_LIMIT }).length <= MESSAGE_LIMIT);
  assert.throws(() => searchMessages(rows, { from: -1 }), /시작 시각/);
  assert.throws(() => searchMessages(rows, { from: 10, to: 5 }), /끝 시각/);
});

test('memory drafts keep the source message and stay within the length limit', () => {
  const draft = memoryDraftFromMessage({ id: 'm1', roomId: 'Yuuka', text: '  선생님은 커피를 좋아해  ' });
  assert.deepEqual(draft, { roomId: 'Yuuka', text: '선생님은 커피를 좋아해', sourceMessageId: 'm1', sourceText: '선생님은 커피를 좋아해' });
  const long = memoryDraftFromMessage({ id: 'm2', roomId: 'Yuuka', text: '가'.repeat(900) }, 100);
  assert.equal(long.text.length, 100);
  assert.ok(long.text.endsWith('…'));
  assert.throws(() => memoryDraftFromMessage({ roomId: 'Yuuka', text: '   ' }), /기억으로 만들/);
  assert.throws(() => memoryDraftFromMessage({ id: 'm3', text: '내용' }), /대화방/);
});

test('management search keeps disabled and expired memories visible', () => {
  const rows = [memory('Yuuka', '커피 취향', { enabled: false }), memory('Yuuka', '커피 값은 아껴 쓰기', { expiresAt: 1 }),
    memory('Yuuka', '다른 이야기'), memory('Arona', '커피는 아로나 몫')];
  const hits = filterMemories(rows, '커피');
  // 방 범위 필터는 호출자(프로필 화면)가 이미 끝낸 목록을 받는다는 전제다.
  assert.deepEqual(hits.map(entry => entry.text), ['커피 취향', '커피 값은 아껴 쓰기', '커피는 아로나 몫']);
  assert.deepEqual(filterMemories(rows, '   '), rows);
  assert.throws(() => filterMemories('nope', 'x'), /배열/);
});
