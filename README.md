# MOLU — 샬레 일정 보드

블루 아카이브 비공식 팬메이드 캘린더입니다. JSON으로 가져온 일정을 월별 캘린더·목록·날짜별 브리핑으로 보여줍니다. 분류 필터(점검·픽업·이벤트·캠페인), 북마크(localStorage 저장), 이벤트 배너, 목록 보기, KST 기준 시각 표시를 지원합니다. 모든 시각은 한국 시간(Asia/Seoul) 기준입니다.

## 종속성

- Node.js 22+
- 런타임: 의존성 없음 (vanilla DOM + ES modules)
- 빌드·개발: `esbuild`, `three`, `@moeru/three-mmd` (선택형 PMX 캐릭터, `GawrGura/` 모델은 별도 준비 필요)

## Quick Start

```sh
npm install
npm run dev
# → http://127.0.0.1:5173

npm test
```

- `dev`는 먼저 `npm run build`(esbuild 캐릭터 번들) 후 `node server.js`로 정적 서버를 띄웁니다.
- 최초 실행은 가상 샘플 데이터로 표시되며, 일정 데이터는 브라우저 `localStorage`에만 저장됩니다.
- 데이터 형식은 [`schema.json`](./schema.json), 실행 샘플은 [`example.json`](./example.json)을 참고하세요.

## 모모톡 학생 데이터

`resource/momotalk/students.json` — 144명(기본 학생, 시즌 한정 의상 제외). 앱이 부팅 시 fetch하고, 실패하면 아로나만 남습니다.

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `id` | ✓ | 대화방 키. `molu.momotalk.v1`의 방 키와 일치해야 함 |
| `img` |  | `resource/momotalk/` 안의 아바타 파일명(확장자 포함). 비면 이름 첫 글자로 대체 |
| `name` | ✓ | 전체 이름 |
| `short` | ✓ | 목록·말풍선 이름표에 쓰는 짧은 이름 |
| `school` · `year` · `club` |  | 소속 학교 · 학년 · 동아리 |
| `status` |  | 모모톡 상태 메시지 |
| `birthday` · `age` · `height` |  | 프로필 카드 정보 |
| `hobby` · `voice` · `illust` |  | 취미 · 성우 · 일러스트레이터 |
| `intro` |  | 학생 소개 전문 |

### 출처와 재생성

| 데이터 | 출처 |
| --- | --- |
| 이름·학교·동아리·상태메시지·취미·소개·성우 (KR) | [blue-utils.me](https://blue-utils.me) 학생 목록·상세 페이지 |
| 120×120 아바타 아이콘 | [SchaleDB](https://github.com/SchaleDB/SchaleDB) `images/student/icon/<id>.webp` |
| 아이콘이 없는 학생의 아바타 | [closure-talk](https://github.com/ClosureTalk/closure-talk) 캐릭터 에셋 |

```sh
python3 tools/vendor_students.py   # students.json + 아바타를 다시 생성(사이트 예의상 1요청/0.8초)
```

시즌 한정 의상(수영복 등)은 기본 학생과 같은 캐릭터라 제외했고, 아직 아이콘이 공개되지 않은 12명은 아바타 없이 이름 첫 글자로 표시됩니다.

## 라이선스 관련

NEXON / NEXON Games와 무관한 비공식 팬 프로젝트입니다.
