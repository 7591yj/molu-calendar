// Explicit memory selection and bounded search. Pure functions over stored rows:
// no DOM, no storage and no model calls here. chat-transcript.js does the reading.
import { dice, grams, words } from './momotalk.js';

export const MEMORY_LIMIT = 5;          // 기억은 한 번에 최대 5개
export const MEMORY_CHAR_BUDGET = 1_200; // 기억 본문 합계 상한(문자)
export const MESSAGE_LIMIT = 20;        // 검색 결과 상한
export const MESSAGE_SCAN_LIMIT = 2_000; // 한 번에 검사하는 원문 수 상한
export const QUERY_MAX_LENGTH = 200;
const MIN_SCORE = .34;                  // 실측: 관련 문장 ≥.4, 무관한 문장 ≤.2
// 흔한 기능어는 어절 일치로 세지 않는다: '있어' 하나로 무관한 기억이 걸리는 것을 막는다.
const FUNCTION_WORDS = new Set(['있어', '있나', '있는', '있다', '있었', '없어', '하는', '하고', '해서', '했다', '해요', '네요',
  '거야', '거지', '같아', '같은', '이야', '이지', '되는', '된', '하는지', '했지', '했어']);

const clamp = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

// 질의와 문장의 관련도. 형태소 분석기 없이 한국어 어미·조사 변화를 흡수한다:
// 1) 어절 일치(접두 일치 허용: '게임' ↔ '게임하기로'), 2) 2-gram dice, 3) 일치 비율에 비례하는 보정.
export function relevance(query, text) {
  if (typeof query !== 'string' || typeof text !== 'string') throw new TypeError('검색어와 본문은 문자열이어야 합니다.');
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError('검색어를 입력해 주세요.');
  if (trimmed.length > QUERY_MAX_LENGTH) throw new TypeError(`검색어는 ${QUERY_MAX_LENGTH}자 이하여야 합니다.`);
  const queryWords = new Set(words(trimmed));
  const textWords = [...new Set(words(text))];
  const matched = new Set();
  for (const word of queryWords) {
    if (FUNCTION_WORDS.has(word)) continue;
    if (textWords.includes(word)) { matched.add(word); continue; }
    // 어미·파생형은 접두로 흡수한다(2자 이상 겹칠 때만).
    if (word.length >= 2 && textWords.some(other => other.length >= 2 && (other.startsWith(word) || word.startsWith(other)))) matched.add(word);
  }
  const queryGrams = grams(trimmed);
  const textGrams = grams(text);
  const wordScore = queryWords.size ? matched.size / queryWords.size : 0;
  const gramScore = queryGrams.size ? dice(queryGrams, textGrams) : 0;
  // 일치하는 어절이 많을수록 강하다. 한 단어만 겹치는 흔한 단어(예: '하루')로 상위에 오르지 않게 한다.
  const ratio = queryWords.size ? matched.size / queryWords.size : 0;
  const exact = matched.size ? .35 + .45 * ratio : 0;
  return Math.max(wordScore * .7 + gramScore * .3, exact);
}

// 관리 UI용 검색: 사용 중지·만료된 기억도 숨기지 않고 관련성으로만 좁힌다.
// 모델 입력 후보는 아래 selectMemories가 방·상태·만료를 먼저 필터링한다.
export function filterMemories(memories, query) {
  if (!Array.isArray(memories)) throw new TypeError('기억 목록이 배열이 아닙니다.');
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return memories;
  return memories.filter(memory => memory && typeof memory.text === 'string' && relevance(trimmed, memory.text) >= MIN_SCORE);
}

// 기억 후보 필터: 방 범위 → 사용 중 → 미만료 → 관련성 → 개수·문자 예산.
// 다른 방의 비공개 기억은 점수와 무관하게 후보가 되지 않는다.
export function selectMemories(memories, { roomId, query, now = Date.now(), limit = MEMORY_LIMIT, charBudget = MEMORY_CHAR_BUDGET } = {}) {
  if (!Array.isArray(memories)) throw new TypeError('기억 목록이 배열이 아닙니다.');
  if (typeof roomId !== 'string' || !roomId) throw new TypeError('대화방 ID가 필요합니다.');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('기준 시각이 올바르지 않습니다.');
  const scoped = memories.filter(memory => memory && memory.roomId === roomId && memory.enabled !== false &&
    (memory.expiresAt === null || memory.expiresAt === undefined || memory.expiresAt > now));
  const scored = scoped.map(memory => ({ memory, score: query ? relevance(query, memory.text) : 1 }));
  // 상대 하한: 최상위 기억과 견줄 만한(80% 이상) 항목만 넣는다. 흔한 단어 하나가 겹치는 무관한 기억이
  // 예산을 차지하고 프롬프트를 흐리는 것을 막는다.
  const best = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  const floor = query ? Math.max(MIN_SCORE, best * .8) : 0;
  const selected = [];
  let used = 0;
  for (const entry of scored.sort((a, b) => b.score - a.score || (b.memory.updatedAt ?? 0) - (a.memory.updatedAt ?? 0))) {
    if (query && entry.score < floor) continue;
    if (selected.length >= limit) break;
    if (used + entry.memory.text.length > charBudget) continue;
    selected.push(entry.memory);
    used += entry.memory.text.length;
  }
  return selected;
}

// 발췌 선별: 검색 결과에서 최근 대화(창)에 이미 들어간 메시지와 현재 질문을 빼고, 길이를 자른다.
// 창에 있는 내용을 발췌로 또 넣으면 예산만 쓰고 같은 말이 두 번 들어간다.
export function selectExcerpts(hits, { currentId = null, recentIds = [], itemChars = 500, maxChars = 800 } = {}) {
  if (!Array.isArray(hits)) throw new TypeError('검색 결과가 배열이 아닙니다.');
  const seen = new Set([currentId, ...recentIds].filter(Boolean));
  const chosen = [];
  let used = 0;
  for (const hit of hits) {
    const message = hit?.message ?? hit;
    if (!message || typeof message.text !== 'string' || seen.has(message.id)) continue;
    const text = message.text.slice(0, itemChars).trim();
    if (!text || used + text.length > maxChars) continue;
    chosen.push({ id: message.id, text });
    used += text.length;
    seen.add(message.id);
  }
  return chosen;
}

// 원문 검색: 화면에 읽어온 페이지 안에서만 동작한다. 전체 기록을 메모리에 올리지 않는다.
export function searchMessages(rows, { query, from = null, to = null, limit = MESSAGE_LIMIT } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('메시지 목록이 배열이 아닙니다.');
  if (from !== null && (!Number.isSafeInteger(from) || from < 0)) throw new TypeError('시작 시각이 올바르지 않습니다.');
  if (to !== null && (!Number.isSafeInteger(to) || to < from)) throw new TypeError('끝 시각이 올바르지 않습니다.');
  const hits = [];
  for (const row of rows) {
    if (!row || typeof row.text !== 'string') continue;
    const at = row.createdAt ?? row.importedAt ?? null;
    if (from !== null && (at === null || at < from)) continue;
    if (to !== null && (at === null || at > to)) continue;
    const score = query ? relevance(query, row.text) : 1;
    if (query && score < MIN_SCORE) continue;
    hits.push({ message: row, score });
  }
  return hits.sort((a, b) => b.score - a.score || (b.message.createdAt ?? 0) - (a.message.createdAt ?? 0)).slice(0, limit);
}

// 메시지에서 기억 초안을 만든다: 본문은 자르고 출처를 함께 남긴다.
export function memoryDraftFromMessage(message, maxLength = 500) {
  if (!message || typeof message.text !== 'string' || !message.text.trim()) throw new TypeError('기억으로 만들 메시지가 아닙니다.');
  if (typeof message.roomId !== 'string' || !message.roomId) throw new TypeError('메시지에 대화방이 없습니다.');
  return { roomId: message.roomId, text: clamp(message.text.trim(), maxLength),
    sourceMessageId: message.id ?? null, sourceText: clamp(message.text.trim(), 2_000) };
}
