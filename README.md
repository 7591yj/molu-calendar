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

## 라이선스 관련

NEXON / NEXON Games와 무관한 비공식 팬 프로젝트입니다. 공식 게임 에셋은 사용하지 않습니다. `GawrGura/` 모델 파일은 이용조건 확인 전까지 저장소에서 제외합니다.
