import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_LIMIT, MESSAGE_LIMIT, filterMemories, memoryDraftFromMessage, relevance, searchMessages, selectExcerpts, selectMemories } from '../../src/lib/chat/memory.ts';

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

test('relevance absorbs Korean endings and ranks multi-word matches above single shared words', () => {
  // 어미·파생형: '게임' ↔ '게임하기로', '적어' ↔ '적는'
  assert.ok(relevance('나랑 게임 약속 기억해?', '우리는 밤에 같이 게임하기로 했어') > .34);
  assert.ok(relevance('내가 기록 어떻게 적는다고 했지?', '선생님은 지출 기록을 수첩에 적어') > .34);
  // 한 단어만 겹치는 흔한 표현보다, 두 단어 이상 겹치는 사실이 높게 나온다(발췌 상위 선택).
  const question = '나 커피 하루에 몇 잔 마신다고 했지?';
  const fact = '선생님은 커피를 하루 두 잔 마셔';
  const distractor = '오늘 하루 어땠어? 잘 지내고 있어.';
  assert.ok(relevance(question, fact) > relevance(question, distractor), `${relevance(question, fact)} > ${relevance(question, distractor)}`);
});

test('natural phrasings retrieve the saved memory from distractors', () => {
  const NOW = 1_700_000_000_000;
  const memory = (id, text) => ({ id, roomId: 'Yuuka', text, enabled: true, expiresAt: null, createdAt: NOW, updatedAt: NOW,
    sourceMessageId: null, sourceText: null });
  const cases = [
    { fact: '선생님은 커피를 하루 두 잔 마셔', questions: ['나 커피 하루에 몇 잔 마신다고 했지?', '내가 커피 몇 잔 마시는지 기억해?', '내 커피 습관 알지?'] },
    { fact: '선생님은 지출 기록을 수첩에 적어', questions: ['내가 지출 기록 어디에 적는다고 했지?', '내 지출 기록 어떻게 하고 있어?'] },
    { fact: '우리는 밤에 같이 게임하기로 했어', questions: ['우리 게임 언제 하기로 했지?', '나랑 게임 약속 기억해?', '게임 하기로 한 거 있었나?'] },
    { fact: '선생님은 아침에 산책을 해', questions: ['내가 아침에 뭐 한다고 했지?', '내 산책 습관 기억해?'] },
  ];
  const distractors = ['선생님은 라면을 좋아해', '선생님은 야근이 많아', '선생님은 낮잠을 잘 자', '선생님은 커피 값에 예민해', '오늘 하루 어땠어? 잘 지내고 있어.'];
  for (const { fact, questions } of cases) {
    const rows = [memory('fact', fact), ...distractors.map((text, index) => memory(`d${index}`, text))];
    for (const question of questions) {
      const selected = selectMemories(rows, { roomId: 'Yuuka', query: question, now: NOW });
      const chosen = selected.map(entry => entry.text);
      assert.equal(chosen[0], fact, `"${question}" 최상위가 사실이어야 함: ${chosen.join(' | ')}`);
      // 무관한 기억은 상대 하한(최상위의 80%)에서 걸러진다: 흔한 단어 하나만 겹치는 항목은 들어오지 않는다.
      assert.ok(!chosen.includes('오늘 하루 어땠어? 잘 지내고 있어.'), `"${question}" → ${chosen.join(' | ')}`);
      assert.ok(chosen.length <= 2, `"${question}" → ${chosen.join(' | ')}`);
    }
  }
});

test('excerpt selection drops the current question and window messages, and honours the char budget', () => {
  const hits = [
    { message: { id: 'old', text: '예전에 했던 약속 이야기' } },
    { message: { id: 'window', text: '방금 나눈 대화' } },
    { message: { id: 'now', text: '현재 질문' } },
    { message: { id: 'long', text: '가'.repeat(600) } },
  ];
  const chosen = selectExcerpts(hits, { currentId: 'now', recentIds: ['window'], itemChars: 500, maxChars: 800 });
  assert.deepEqual(chosen.map(entry => entry.id), ['old', 'long']);
  assert.equal(chosen[1].text.length, 500);
  const tinyBudget = selectExcerpts(hits, { currentId: 'now', recentIds: ['window'], itemChars: 500, maxChars: 10 });
  assert.deepEqual(tinyBudget, []);
  assert.throws(() => selectExcerpts('nope'), /배열/);
});
