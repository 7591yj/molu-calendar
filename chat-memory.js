// Explicit memory selection and bounded search. Pure functions over stored rows:
// no DOM, no storage and no model calls here. chat-transcript.js does the reading.
import { dice, grams, words } from './momotalk.js';

export const MEMORY_LIMIT = 5;          // 기억은 한 번에 최대 5개
export const MEMORY_CHAR_BUDGET = 1_200; // 기억 본문 합계 상한(문자)
export const MESSAGE_LIMIT = 20;        // 검색 결과 상한
export const MESSAGE_SCAN_LIMIT = 2_000; // 한 번에 검사하는 원문 수 상한
export const QUERY_MAX_LENGTH = 200;
const MIN_SCORE = .34;                  // 실측: 관련 문장 ≥.4, 무관한 문장 ≤.2

const clamp = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

// 질의와 문장의 어절·2-gram dice 유사도. 형태소 분석기 없이 한국어 어미 변화를 흡수한다.
export function relevance(query, text) {
  if (typeof query !== 'string' || typeof text !== 'string') throw new TypeError('검색어와 본문은 문자열이어야 합니다.');
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError('검색어를 입력해 주세요.');
  if (trimmed.length > QUERY_MAX_LENGTH) throw new TypeError(`검색어는 ${QUERY_MAX_LENGTH}자 이하여야 합니다.`);
  const queryWords = new Set(words(trimmed));
  const textWords = new Set(words(text));
  const queryGrams = grams(trimmed);
  const textGrams = grams(text);
  const wordScore = queryWords.size ? dice(queryWords, textWords) : 0;
  const gramScore = queryGrams.size ? dice(queryGrams, textGrams) : 0;
  // 정확히 같은 어절이 있으면 그 자체로 관련성이 있다 (짧은 문장 보정).
  let exact = 0;
  for (const word of queryWords) if (textWords.has(word)) exact = Math.max(exact, .6);
  return Math.max(wordScore * .8 + gramScore * .2, exact);
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
  const selected = [];
  let used = 0;
  for (const entry of scored.sort((a, b) => b.score - a.score || (b.memory.updatedAt ?? 0) - (a.memory.updatedAt ?? 0))) {
    if (query && entry.score < MIN_SCORE) continue;
    if (selected.length >= limit) break;
    if (used + entry.memory.text.length > charBudget) continue;
    selected.push(entry.memory);
    used += entry.memory.text.length;
  }
  return selected;
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
