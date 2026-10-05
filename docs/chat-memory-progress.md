# 메모리 구현 진행 결과

## 완료: P0 계약 / P1 IndexedDB 기반 / P2 모모톡 전환

앱의 모모톡은 이제 IndexedDB(`molu-chat-memory`)에 원문을 저장한다. 기존 `localStorage`의 `molu.momotalk.v1`은 이관 원본으로 한 번만 읽고 그대로 남긴다. 방별 최근 60개 제한은 없다.

### 추가·변경한 파일

- `docs/chat-memory-contract.md`: 화자/출처/이관/날짜/삭제/입력 한도 계약.
- `chat-store.js`: 네이티브 IndexedDB schema v1. 읽기/추가/이관에 더해 `deleteRoom`, `deleteAll`, `exportBundle`, `importBundle`(백업 검증 `parseChatBundle` 포함)을 제공한다.
- `chat-transcript.js`: DOM 없는 세션 계층. 페이지 창(50개씩, 방마다 300개 상한), 방 요약·정렬, 답변 대상(`retryTarget`), 백업·삭제를 담당한다.
- `app.js`: 비동기 저장소 초기화, 페이지 조회, 진행도 분리, 저장 실패 배너(재시도·내보내기), 방별 삭제(프로필), 전체 초기화 연동, 탭 간 알림·생성 감지를 연결했다.
- `index.html`, `styles.css`: 저장 상태 배너, `이전 대화 불러오기`, 프로필의 기록 삭제 버튼.
- `local-ai-settings.js`: 대화 기록 삭제를 IndexedDB까지 연결하고 JSON 내보내기·가져오기를 추가했다.
- `server.js`: `chat-store.js`, `chat-transcript.js`를 서빙 목록에 추가했다.
- `tools/momo-memory-check.mjs`: 실제 앱 UI로 이관·페이지·진행도·삭제·백업 왕복을 확인하는 선택형 브라우저 점검.
- `chat-store.test.js`, `chat-transcript.test.js`: 저장소와 세션 계층 회귀 검사(신규 16개).

### 저장소에서 제공하는 것

```js
const transcript = await ChatTranscript.open({ legacyRaw });
await transcript.seed([{ roomId: 'Arona', speakerType: 'character', text: '…', sourceKind: 'app' }]);
await transcript.refreshSummaries();          // [{ roomId, last, userMessageCount, activityAt }]
const cache = await transcript.load('Yuuka'); // 최근 50개 + hasMore
const older = await transcript.loadOlder('Yuuka');
await transcript.append('Yuuka', { speakerType: 'user', text: '안녕', sourceKind: 'user-input' });
const target = transcript.retryTarget('Yuuka'); // 답 없는 마지막 선생님 메시지
await transcript.exportBundle();               // JSON 문자열
await transcript.importBundle(raw, { replace: true });
await transcript.deleteRoom('Yuuka');
```

- 조회는 방별 인덱스로 최근 페이지만 읽고, 메모리 창은 방마다 최근 300개로 제한한다. 창을 넘긴 과거는 다시 `loadOlder`로 읽는다.
- 스크립트 진행도는 저장된 방 카운터(`userMessageCount`)를 쓴다. 화면에 불러온 개수와 무관하며 새로고침을 견딘다.
- 사용자 메시지는 생성 전에 저장하고 완료한 답변만 저장한다. 중단·실패한 답변은 저장하지 않으며, 늦게 도착한 응답은 작업 식별자·삭제 시점(`momoEpoch`)·방 캐시 유무로 거부한다.
- 백업 가져오기는 형식·버전·크기(32 MiB, 방 2,000, 메시지 100,000)·ID 중복·방별 순서 중복·참조·진행 카운터·마지막 메시지 참조를 검증한다. 기록이 있으면 자동 병합하지 않고, 사용자가 확인한 `replace`일 때만 한 트랜잭션에서 교체한다.
- 저장 실패는 배너로 표시하고 그동안 새 전송을 막는다. localStorage로 조용히 우회하지 않는다.

### 검증 결과

```sh
npm test          # 103 passed / 0 failed (앱·Worker 빌드 포함)
node tools/momo-memory-check.mjs   # 실제 Chromium UI 점검 통과
```

브라우저 점검(Chromium, 실제 앱·실제 IndexedDB)에서 확인한 것:

- 레거시 75건(방 4개) 이관, `localStorage` 원문 보존, 화면 순서·읽지 않음·읽기 전용 표시.
- 최근 50개 → **이전 대화 불러오기** → 71개(레거시 70 + 진행 중 질문), 원문 순서 보존.
- 스크립트 진행도: 새로고침 뒤에도 질문이 중복 생성되지 않고 다음 답장이 이어진다.
- 프로필에서 방 삭제: 페이지가 빈 상태가 되고 목록에서 사라진다. 원본 snapshot은 남는다.
- 백업 내보내기(81건) → 전체 삭제(첫 인사만) → 가져오기(방 4개 복원, 마지막 메시지 일치).
- 페이지 오류 0건.
- 가짜 Worker로 페이지→Worker 입력 조립: 기억 문구 전달, user/assistant 역할만 전송, 두 번째 질문에 완료 왕복 포함, 관련 기억만 선택(관련 없는 질문에서는 제외), 개발자 도구의 예산·참고 자료 표시.
- 중단·재시도: 생성 중 새로고침으로 답이 사라지면 사용자 메시지는 한 번만 남고, 모델을 다시 준비한 뒤 '답변 다시 시도'가 같은 질문으로 재생성한다(문맥에 질문 중복 없음). 세 엔진에서 확인.
- 저장 실패: 메시지 쓰기를 강제로 실패시키면(쿼터 오류 모사) 배너·'저장 안 됨' 표시가 나타나고 새 전송이 막힌다. 재시도하면 실제로 저장되고 새로고침 뒤에도 남는다. 페이지 오류는 주입한 오류 외에 없음.
- 두 탭 동시성: 보낸 탭의 메시지·답변이 다른 탭 화면에 반영되고, 같은 방을 동시에 생성하려는 두 번째 탭은 감지로 거부되어 저장되지 않는다(잠금 아님). 다른 탭/이전 버전이 `molu.momotalk.v1` 원문을 바꾸면 배너로 알리고 자동 병합하지 않는다.

AI 생성 경로(사전 저장·재시도 버튼·늦은 응답 거부)는 실제 모델이 필요해 이 점검에 포함하지 않았다. 해당 규칙은 `chat-transcript.test.js`의 `retryTarget` 검사와 코드 경로로만 확인했으며, GPU 실측 검증은 별도다. P4에서 가짜 Worker로 페이지→Worker 입력 조립만 추가 확인했다.

## 완료: P3 명시적 기억·범위 제한 검색

- `chat-store.js` schema v2: `memories` store(`roomCreated`, `sourceMessage` 인덱스). 저장·수정·삭제·조회 API와 백업 포함(v2).
- `chat-memory.js`: 순수 함수. `relevance`(어절·2-gram dice), `selectMemories`(방 비공개 필터 → 사용 중 → 미만료 → 관련성 → 개수·문자 예산), `searchMessages`(기간 필터·관련성·개수 제한), `memoryDraftFromMessage`.
- UI: 프로필 오버레이의 '이 대화의 기억'(추가·수정·사용 중지·만료·삭제·키워드 검색), 메시지 길게 누르기/오른쪽 클릭 → '기억하기'.
- 무효화: 방 삭제·전체 삭제가 그 방의 기억을 한 트랜잭션에서 함께 지운다. 백업 가져오기도 `sourceMessageId` 참조가 깨진 기억을 거부한다.
- 검증: `chat-memory.test.js` 5건, `chat-store.test.js` 기억 3건(방 격리·수정·만료·중복 참조 거부·무효화·v1→v2 업그레이드), 실제 브라우저에서 메시지→기억 생성·검색·수정·삭제·방 삭제 시 무효화까지 확인.

## 완료: P4 모델 입력 연결·문맥 예산

- `persona.js`: `normalizeMemories`/`normalizeExcerpts`(개수·길이·필드 검증), `referenceMessage`(`[참고 자료]` system 블록), `chatMessagesWithReferences`(예시 뒤·대화 앞에 참고 자료 배치), `promptCharsFor`(카드·예시 길이).
- `local-ai-worker.js`: 기억 ≤5·≤1,200자, 발췌 ≤2·≤800자 DTO만 받아 Worker가 system 블록을 조립한다. 임의 system 주입 경로는 없다. `trace` 이벤트로 개수·문자 수를 알린다(본문 로그 없음).
- `momotalk.js`: `momoPromptPlan` — 카드+예시(고정) + 참고 자료(남은 예산의 절반) + 완결된 최근 왕복 2턴 + 현재 질문을 **문자 예산 4,000자**에 맞춘다. 초과 시 항목 단위로 제거하고 현재 질문은 자르지 않는다.
- 근거: 앱 형태 프롬프트 실측(Qwen3 토크나이저) 1.18~1.31자/토큰 → 가장 나쁜 값과 템플릿 오버헤드를 가정해 4,000자 ≈ 3,550토큰으로 4,096 문맥 − 출력 256 안에 맞춘다. 토큰 수를 직접 세지 않는다.
- 개발자 도구 '모모톡 프롬프트': 마지막 조립의 예산·선택된 참고 자료·Worker 확인 값. 전체 대화 본문은 남기지 않는다.
- 검증: `chat-memory-contract.test.js`(4건: 완료 왕복만·길이 거부·항목 단위 축소·예산 상한), `local-ai.test.js`의 Worker 검사(참고 자료 system 블록 조립, 잘못된 DTO 거부, characterId 없으면 미적용), 브라우저 점검(가짜 Worker로 페이지→Worker 페이로드 확인: 기억 문구·user/assistant 역할만·두 번째 질문에 완료 왕복 포함·관련 기억만 선택).

프롬프트 수준 확인은 `training/lora/memory_probe.py`(로컬 Qwen3-1.7B, 앱 조립 코드로 만든 30개 프롬프트)로 했다. 말투는 `training/lora/voice_probe.py`(고정 평가셋 56프롬프트 × 3표본)로 측정한다. 결과는 [RESULTS.md](../training/lora/RESULTS.md)에 정리했고, **앱 모델(Gemma 4 LiteRT)의 품질 보장이 아니라 프롬프트 구조 검증**이다.

말투 측정에서 나온 결론 하나: 프롬프트에 `[말투]`·`[분량]` 같은 지침 블록을 더 넣어도 지표가 나아지지 않았고(각 A/B), 모델은 지침보다 예시 대화의 리듬을 더 강하게 따랐다. 그래서 지침은 늘리지 않고 예시 선택 기준만 앱 규칙 쪽으로 맞췄다. 남은 실패는 반말 캐릭터가 존대 종결을 섞는 `register`(10%)다.

## 완료: P5 규모 점검 (합성 1만 메시지)

`tools/momo-scale-check.mjs`(옵트인, 실제 Chromium + 실제 IndexedDB + 가짜 Worker)로 확인했다.

| 항목 | 측정 |
|---|---|
| 레거시 이관(1만 건, 방 2개) | 628 ms |
| 방 열기(최근 50개 적재) | 58 ms · DOM 행 50개 |
| 이전 페이지 8회(각 50개) | 43~120 ms · 최종 300행(메모리 창 상한) |
| 방 전환 | 89 ms |
| 전체 DOM 노드 | 2,593개 |
| 모델 입력(새 방 첫 질문) | 메시지 5개 · 52자 |
| JS 힙 | 약 10 MB |

- 화면에는 최근 페이지만 올라가고(50행), 페이지를 더 읽어도 메모리 창 상한 300행을 넘지 않는다.
- 1만 건이 있어도 모델 입력은 최근 왕복만 들어간다(52자, 예산 4,000자).
- 단일 실행 측정값이며 성능 보장이 아니다. 앱 모델 추론 시간은 포함하지 않는다.

## 완료: P5 브라우저 엔진 확인 (Chromium·WebKit·Firefox)

`MOMO_CHECK_BROWSER=chromium|firefox|webkit node tools/momo-memory-check.mjs`로 같은 앱 점검을 세 엔진에서 실행했다.

| 엔진 | 실행 | 결과 |
|---|---|---|
| Chromium (Playwright 번들 1243) | 3회 | 통과 |
| WebKit (Playwright 번들 2359) | 4회 | 통과(동작 타임아웃을 60초로 올린 뒤 3회 연속 통과) |
| Firefox (Playwright 1543) | 3회 | 통과 |

- 검사 항목은 Chromium과 동일하다: 이관·페이지·진행도·방 삭제·백업 왕복·기억 UI·두 탭 동시성·가짜 Worker 입력 조립.
- Safari 애플리케이션 자체나 실제 사용자 프로필에서의 동작을 검증한 것은 아니다. WebKit 엔진 기준이다.
- 실패한 실행은 조용히 재시도하지 않는다: 실패하면 종료 코드가 0이 아니고 로그가 남는다. 처음 WebKit 1회는 두 탭 준비 단계에서 타임아웃이 났고, 기본 동작 제한을 60초로 올린 뒤 반복 통과를 확인했다.

## 완료: P5 저장 공간·보존 요청 (앱 UI)

설정 → 로컬 AI → **대화 저장소** 섹션에 추가했다.

- **사용량(추정)**: `navigator.storage.estimate()` 값으로 `72.0 KB / 3.00 GB · origin 전체 추정`처럼 표시한다. origin 전체 값이며 대화 DB만의 크기가 아니라고 푸터에 명시한다.
- **보존 요청**: `navigator.storage.persist()`를 호출하고 결과를 그대로 표시한다(허용/미허용/미지원). 요청 직후 "저장소 보존을 요청했습니다" 상태를 먼저 보여 주고 버튼을 잠근다 — Firefox에서는 브라우저가 사용자에게 묻는 동안 응답이 없어 화면이 멈춘 것처럼 보이면 안 되기 때문이다(브라우저 점검에서 Firefox만 대기 상태로 남는 것을 확인).
- 보존은 요청일 뿐이라는 점, 비공개 모드·사이트 데이터 삭제·포트(origin) 변경 시 기록이 사라지거나 보이지 않는다는 점을 같은 섹션 푸터에 적었다. 백업은 JSON 내보내기를 안내한다.
- 검증: Chromium(즉시 미허용), WebKit(즉시 결과), Firefox(브라우저 확인 대기 → 진행 중 표시·버튼 잠금) 세 엔진에서 앱 점검이 통과한다.

## 아직 하지 않은 것

- **실제 GPU 추론과 앱 모델 품질**: 브라우저 점검은 가짜 Worker를 쓰고, 프롬프트 검증은 Qwen3로 했다. Gemma 4 LiteRT/WebLLM으로 기억 활용·말투 품질을 측정한 적은 아직 없다(P5).
- P5의 브라우저 복구·용량·persist·성능 측정과 P6 자동 요약은 미착수다.
- 방 목록 정렬이 인게임의 "최근 활동 순"으로 바뀌었다(이관 전 순서는 유지하지 않는다). 방 안의 원문 순서는 그대로다.
- 대화 검색 UI는 없다. 원문 검색 함수는 모델 입력 발췌 용도로만 쓰인다(전체 기록을 훑지 않고 메모리 창 + 2페이지).

## 이전 단계 요약 (P0·P1)

앱을 전환하기 전에 저장소를 독립적으로 구현·검증했다. 사용자 원본 데이터는 읽거나 변경하지 않았고, 검증은 분리된 테스트 DB와 임시 origin에서 수행했다. 계약·이관·중복·충돌·페이지 조회·동시 연결·버전 변경은 지금도 같은 코드다.

## 실모델 라이브 검증 시도 (2026-10, 부분 차단)

앱 모델로 기억 기능을 직접 확인하려고 `tools/local-ai-live-check.mjs`를 실행했다(헤드리스 아님 + `--enable-unsafe-webgpu`).

- 환경 확인은 통과했다: Chrome, GPU `apple · metal-3`, LiteRT-LM 실행 조건·공유 실행 파일 모두 실행 가능.
- 다운로드는 빨랐다(1.4 GB / 20초). 그러나 약 90%(1.8 GB)에서 **"브라우저 저장 공간이 부족하거나 저장이 차단되었습니다"**로 중단됐다. 이 Mac의 디스크가 98% 사용(여유 5.5 GiB)이라 Chromium 캐시 쓰기가 막힌 것으로 보인다. 앱은 실패를 숨기지 않고 실행 상태에 그대로 표시했다.
- 아직 확인하지 못한 것: **앱 모델(Gemma 4 E2B LiteRT)의 실제 기억 활용·말투 품질.** 프롬프트 구조는 로컬 Qwen3로, 페이지→Worker 입력은 가짜 Worker로 검증했지만 실제 Gemma 추론은 별개다.
- 다른 컴퓨터나 디스크 여유가 있는 환경에서 `node tools/local-ai-live-check.mjs`로 이어서 확인할 수 있다(2 GB 다운로드 + 실제 GPU 추론). 스크립트는 진행 상황과 실패 사유를 `training/lora/runs/live-model-check/`에 기록한다.

## 다음: P5 브라우저·복구·품질 검증

- Chromium/Safari/Firefox의 실제 IndexedDB에서 조회·갱신·이관·삭제 검사(P1에서 한 번 수행, 앱 전환 후 재확인 필요). blocked upgrade·용량 부족·persist 권한 경로.
- 백업→새 DB 복원, 중복 가져오기, 잘못된 파일 거부, 원본/파생 자료 삭제 검증(일부는 브라우저 점검에 있음).
- 합성 1만 메시지에서 방별 페이지 조회·DOM 적재·프롬프트 크기 측정.
- **실제 모델(Gemma 4 LiteRT/WebLLM)로 기억 사용 전/후 비교**: 올바른 회상, 수정된 정보, 모르는 정보, 다른 방 정보, 삭제된 정보. WebGPU 지원 브라우저에서 모델을 준비해야 한다. 위 라이브 검증 시도가 디스크 부족으로 막혀 있어, 여유 공간이 있는 환경에서 이어서 실행한다.
- 프롬프트 수준 검증은 `training/lora/memory_probe.py`로 계속 재사용한다.
