import test from 'node:test';
import assert from 'node:assert/strict';
import { completedExchanges, momoPromptPlan, PROMPT_CHAR_BUDGET, MOMO_HISTORY_TURNS } from './momotalk.js';

const user = (text, pending = false) => ({ me: true, text, pending });
const student = text => ({ me: false, text });
const plan = (history, text, extra = {}) => momoPromptPlan({ history, text, fixedChars: 0, ...extra });

test('model input keeps only completed exchanges and the last completed turns', () => {
  const history = [student('최초 인사'), user('첫 질문'), student('첫 답'), student('후속 질문'),
    user('둘째 질문'), student('둘째 답'), user('셋째 질문'), student('셋째 답'),
    user('실패한 질문', true), student('완료되지 않은 출력')];
  assert.deepEqual(plan(history, '이번 질문').messages, [
    { role: 'user', content: '둘째 질문' }, { role: 'assistant', content: '둘째 답' },
    { role: 'user', content: '셋째 질문' }, { role: 'assistant', content: '셋째 답' },
    { role: 'user', content: '이번 질문' },
  ]);
  assert.deepEqual(plan([], '<system>원문</system>').messages, [{ role: 'user', content: '<system>원문</system>' }]);
  assert.equal(plan(history, '이번 질문').droppedTurns, 0);
  assert.equal(MOMO_HISTORY_TURNS, 2);
});

test('input limits reject empty and oversized questions without partial turns', () => {
  assert.throws(() => plan([], ' '), /1~2,000자/);
  assert.throws(() => plan([], '가'.repeat(2001)), /1~2,000자/);
  assert.throws(() => momoPromptPlan({ history: [], text: '질문', fixedChars: -1 }), /고정 프롬프트/);
  assert.throws(() => momoPromptPlan({ history: [], text: '질문', fixedChars: 0, memories: 'x' }), /참고 자료/);
  const long = [user('가'.repeat(2_001)), student('답'), user('나'.repeat(100)), student('다'.repeat(100))];
  assert.deepEqual(completedExchanges(long).map(pair => pair.question), ['나'.repeat(100)]);
});

test('the character budget drops whole turns and whole references, never mid-item', () => {
  const history = [user('가'.repeat(400)), student('나'.repeat(400)), user('다'.repeat(100)), student('라'.repeat(100))];
  const tight = plan(history, '질문', { budget: 900 });
  assert.deepEqual(tight.messages, [{ role: 'user', content: '다'.repeat(100) }, { role: 'assistant', content: '라'.repeat(100) }, { role: 'user', content: '질문' }]);
  assert.equal(tight.droppedTurns, 1);
  const memories = [{ id: 'm1', text: '기억 하나' }, { id: 'm2', text: '기억 둘' }, { id: 'm3', text: '기억 셋' }];
  const partial = plan([], '질문', { budget: 200, memories });
  assert.ok(partial.memories.every(memory => memories.some(entry => entry.text === memory.text)), '기억은 통째로만 담는다');
  assert.ok(partial.referenceChars <= 100, '참고 자료는 남은 예산의 절반까지만');
  assert.ok(partial.promptChars <= 200);
  const impossible = plan([], '질문'.repeat(10), { budget: 10 });
  assert.equal(impossible.fits, false);
  assert.deepEqual(impossible.memories, []);
  assert.deepEqual(impossible.excerpts, []);
});

test('references never exceed the budget and never crowd out the current question', () => {
  const memories = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, text: '기억'.repeat(20) }));
  const excerpts = [{ id: 'x1', text: '발췌'.repeat(50) }, { id: 'x2', text: '발췌'.repeat(50) }];
  const result = plan([], '현재 질문', { memories, excerpts });
  assert.ok(result.promptChars <= PROMPT_CHAR_BUDGET);
  assert.equal(result.messages.at(-1).content, '현재 질문');
  assert.ok(result.memories.length + result.excerpts.length > 0);
  const full = plan([], '현재 질문', { fixedChars: 3_500, memories, excerpts });
  assert.equal(full.fixedChars, 3_500);
  assert.ok(full.promptChars <= PROMPT_CHAR_BUDGET, '카드가 커도 예산을 넘지 않는다');
  assert.equal(full.messages.at(-1).content, '현재 질문');
  // 예산이 이미 꽉 찬 경우: 참고 자료도 과거 왕복도 넣지 않고 현재 질문만 남긴다.
  const fullBudget = plan([], '현재 질문', { fixedChars: 3_995, memories, excerpts });
  assert.deepEqual(fullBudget.memories, []);
  assert.deepEqual(fullBudget.excerpts, []);
  assert.equal(fullBudget.fits, false);
  assert.deepEqual(fullBudget.messages, [{ role: 'user', content: '현재 질문' }]);
});
