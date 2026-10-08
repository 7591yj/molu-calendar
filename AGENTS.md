# Repository guidelines

MOLU is an unofficial Blue Archive KR schedule calendar built with Astro, React,
TypeScript and Tailwind. Use Node 22.18+ and pnpm 10.11.0 through `nix develop`.

## Architecture

- `src/App.tsx` and `src/components/` own the React UI.
- `public/data/events.json` is the official Nexon KR schema-v2 feed. `scraper/`
  refreshes it; do not overwrite it with upstream's schema-v1 multi-region data.
- `src/lib/` contains typed calendar, search, feed and export logic.
- `src/hooks/useChat.ts` connects React to `chat-transcript.js`, `chat-store.js`
  and `chat-memory.js`. IndexedDB is authoritative; `molu.momotalk.v1` is read
  once for migration and preserved. Storage failures block sending and expose retry.
- Root `momotalk.js`, `persona.js`, `local-ai.js`, `local-ai-session.js` and
  `local-ai-worker.js` retain upstream's tested domain/AI logic. Matching `.d.ts`
  files define the React boundary. Never replace these declarations without
  checking their runtime API.
- `tools/build-ai.mjs` bundles a classic IIFE Worker and copies pinned LiteRT
  runtime assets into `public/`. Generated files are ignored. LiteRT requires
  `importScripts`; do not switch to a module Worker.
- `public/resource/` holds portraits, banners, persona corpora and upstream's
  schema-v1 data. Root `calendar.js`, `schema.json` and `example.json` support
  that separate data contract and its regression tests.
- `training/lora/` is an isolated Python/uv experiment, not a runtime dependency.
- `tools/upstream-browser/` archives old vanilla-app browser checks. Their DOM
  assumptions do not describe the React application; do not count them as QA.

## Checks

`pnpm check` runs formatting, ESLint, CSS lint, Astro type checks, Vitest and
upstream Node tests. `pnpm build` builds the Worker then the static Astro site.
`python3 -B tools/test_vendor_publication.py` checks atomic vendor publication.
Use the collaborative browser for actual React flows, including migration,
paging, backup/import, memory editing, cancellation/retry and storage failures.
Never count fake IndexedDB or fake Worker tests as real GPU/model validation.

## Contracts

Read `docs/chat-memory-contract.md` before changing persistence. Preserve legacy
snapshots and speaker/source attribution. Persist user messages before generation
and completed answers only. Reject stale responses after cancellation/deletion.
Use IndexedDB transaction completion, not request success, as the write boundary.
Keep memory selection room-scoped and budgeted. AI output must never become a
saved memory without an explicit user action. Maintain pinned model artifacts,
restricted CSP download hosts, and the classic Worker runtime.

Use existing UI components and tokens. Keep KST date arithmetic in UTC-based
helpers. Match Prettier formatting. Edit sources, never generated bundles.
