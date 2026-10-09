# Upstream integration

This branch merges upstream `main` at `7dcb841` into the Astro/React branch at
`e787064`. All twelve upstream commits are included in the merge history.

## Integration decisions

The Astro/React UI, pnpm toolchain, official Nexon KR schema-v2 feed, scraper,
static routes and GitHub Pages workflow remain the active application.
Upstream's schema-v1 multi-region datasets and assets live in `public/resource/`.
They do not replace or silently supplement the official feed.

React MomoTalk uses upstream's IndexedDB store, transcript session, explicit
memory retrieval and persona prompt logic. It exposes paging, backup/import,
delete, memory management, storage estimates and persistence requests. The
legacy localStorage snapshot is preserved. Sending takes a browser Web Lock per
room, persists the question before generation and saves only completed replies.
Cancelled/stale replies are discarded; unanswered questions can be retried.
Storage, backup and the local model live in MomoTalk settings (the header's
settings button); each AI-capable room has its own memory panel. Destructive
actions confirm inline, and the composer never starts a model download.

The browser-local AI runtime stays pinned to LiteRT-LM 0.17.1 and its matching
Gemma 4 E2B web artifact. The build emits a classic IIFE Worker and copies WASM
runtime files into the static site. Both Worker and runtime URLs work under the
GitHub Pages project base. There is no remote inference service. Model weights
are downloaded separately; the Pages artifact contains no model weights.

The old DOM settings renderer and obsolete page/server files are replaced by
React. Old UI browser checks are archived under `tools/upstream-browser/`.
The schema-v1 calendar validation utility and applicable pure tests are retained.
The UI asset downloader is preserved as `tools/vendor/vendor_momotalk_ui.py`, alongside
upstream's persona dialogue vendor. The LoRA experiment stays separate.

Integration fixes include GPU fallback detection, advancing backward pagination
past the 300-message cache limit, KST transcript timestamps, restore refreshing
loaded rooms, restricted memory DTOs, persona character-count handling, and
keeping the message input visible on small screens with expanded controls.

## Verification

- `pnpm check`: formatting, ESLint, CSS lint, Astro type checks; 77 Vitest tests
  and 102 upstream Node tests pass.
- Static build passes both at `/` and with `SITE_BASE=/molu-calendar`.
- Offline Python vendor publication regression passes.
- Python 3.11 training pipeline tests: 9 pass. Loop boundary tests: 8 pass.
- Persona card export and memory/style probe generation pass with relocated data.
- Chromium/Electron browser checks use the actual static production build,
  a project subpath, native IndexedDB and no cross-origin isolation headers.
- Scripted schedule reply, migrated history, reload persistence, 50-message
  pages and older history verified. A native 10,000-message database reaches its
  oldest record through 201 page reads while keeping a 300-message cache. Native broadcast updates reload the UI.
- Export/delete/import restores 79 messages and one explicit memory; loaded
  React rooms refresh immediately after replacement.
- Injected message-write failure blocks sending; write retry plus answer retry
  saves one question and its completed answer.
- Fake Worker integration verifies a room-scoped memory DTO, four recent
  completed exchanges, correct speaker/source attribution, cancellation,
  late-response rejection and retry without a duplicate question. Model replies
  do not add memories automatically. A held room lock prevents a second send
  before any question is saved. Replies atomically check their target question
  ID so deletion/replacement cannot resurrect a room. A native second database
  connection deletes a room during generation; the UI rejects the completed
  stale answer and the room remains empty.
- At 375×667, expanded controls cause no horizontal overflow and the message
  input remains inside the dialog viewport.
- Real LiteRT GPU inference passes through the React UI on the Pages subpath
  without cross-origin isolation. The pinned 2,008,432,640-byte artifact was
  downloaded separately from Hugging Face and staged locally for the initial
  browser cache fill. Its first Korean answer began in 1.59 seconds and finished
  in 1.98 seconds, with 19 output tokens. After a full page reload, the native
  Worker loaded the cached model through the unmodified production bundle and
  generated another Korean answer using the previous exchange. The staging
  shim is outside the repository; production downloads from Hugging Face.
  These results establish operation on the tested Chromium/Electron GPU device,
  not compatibility with every device or general model quality.
