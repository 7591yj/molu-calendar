# Repository Guidelines

## Project Overview

MOLU is an unofficial Blue Archive schedule board: a KST calendar, event banners and filters, MomoTalk-style character chat, and optional browser-local AI. It is a vanilla JavaScript single-page app, not a framework application; the Node server serves static files and does not store user data.

## Architecture & Data Flow

- `index.html` loads `app.js`, which owns DOM wiring, screen navigation, application state and rendering. State changes require explicit render calls; there is no reactive store.
- Calendar: `resource/events.json` → `calendar.js` parsing/validation → application state → calendar/list/briefing views. User imports pass through `parseBundle` and `mergeEvents`, then persist in localStorage. Keep date arithmetic in the UTC-based helpers and display in `Asia/Seoul`; reuse `span`/`overlaps` for event boundaries.
- Banners: event image metadata plus `raid-banners.js` → language selection/fallback → `resource/event_banner_img/`; `banner-crop.js` provides pure crop calculations.
- Chat: `momotalk.js` provides scripted replies and calendar-query detection; `persona.js` constructs prompts from `resource/persona/characters.json`. `app.js` resolves calendar queries against live schedules.
- Local AI: chat and `local-ai-settings.js` share the `localAISession` singleton → `LocalAIClient` in `local-ai.js` → bundled `local-ai-worker.js` → WebLLM/LiteRT-LM. A session lease covers the whole workflow, including benchmark gaps. Cancellation terminates the Worker; backgrounding the page cancels active work.
- Current persistence uses versioned `molu.<feature>.v1` localStorage keys. `chat-store.js` implements an independent IndexedDB store but **is not wired into the app**. Read `docs/chat-memory-contract.md` and `docs/chat-memory-progress.md` before changing this boundary; the plan is not implemented behavior.

## Key Directories

- Application modules and colocated `*.test.js` live at the repository root; there is no `src/` tree.
- `resource/`: vendored event data, banners, student portraits, persona/chat corpora and fonts.
- `tools/`: Python data-vendoring/curation scripts and optional browser QA scripts.
- `training/lora/`: separate LoRA experiment with its own Python environment, lockfile and tests; not part of app runtime.
- `docs/`: chat-memory contract, plan and implementation progress. `reference/` contains research/snapshots, not application specifications.

## Development Commands

Run from the repository root unless noted:

```sh
npm ci                         # Install locked dependencies
npm run dev                    # Both bundle watchers + static server
npm start                      # Build once, then serve
npm run build                  # Regenerate both bundles
npm run watch                  # Watch bundles only; no server
npm test                       # pretest builds, then node --test
node --test calendar.test.js    # Focused suite; build first if bundles matter
python3 -B tools/test_vendor_publication.py  # Offline vendor regression
```

The server defaults to `http://127.0.0.1:5173`; `HOST` and `PORT` override it. `node server.js` serves existing artifacts without rebuilding. No lint or formatter command is configured.

## Code Conventions & Common Patterns

- Match existing style: two-space indentation, semicolons, single-quoted strings, camelCase functions/variables, PascalCase classes and UPPER_SNAKE_CASE constants. Internal ESM imports use explicit `.js` extensions; persona JSON uses import attributes.
- Keep reusable domain logic free of DOM globals (`calendar.js`, `banner-crop.js`, `momotalk.js`); put UI/state orchestration in `app.js`. Reuse the existing settings row/section helpers and `DEV_TOOLS` registry rather than creating another settings framework.
- Dependency injection is lightweight: `LocalAISession(client, storage)`, the client's Worker factory, and `openChatStore({ indexedDB })` support isolated tests. Preserve these seams; no DI container is used.
- Async work uses promises/`async` functions, explicit timeouts and streamed Worker events. Use session ownership/cancellation checks to reject stale results; release workflow state in `finally`.
- Validation throws descriptive errors; AI errors carry codes via `errorWithCode`, and storage conflicts use `ChatStorageConflict`. Surface failures in the relevant UI. Storage fallback catches are deliberate, not a general license to suppress errors.
- Event imports enforce a 1 MiB limit and 1,000-event cap. Preserve URL, field and duplicate-ID validation rather than bypassing it in UI code.
- IndexedDB operations resolve on transaction completion, not individual request success; migration must preserve the legacy snapshot and remain atomic/idempotent.

## Important Files

- `package.json` / `package-lock.json`: authoritative scripts, pinned dependencies and npm lockfile; esbuild flags live directly in scripts.
- `server.js`: explicit asset allowlist and security headers. Add new browser modules/assets to the appropriate serving rules; do not expose arbitrary repository paths.
- `index.html` / `styles.css` / `app.js`: browser shell, styling and UI entry point.
- `calendar.js`, `schema.json`, `example.json`: event behavior, import contract and sample bundle.
- `local-ai.js`, `local-ai-session.js`, `local-ai-worker.js`: model catalog, exclusive ownership and inference protocol.
- `README.md`: maintenance workflows and feature contracts. `training/lora/README.md` and `RESULTS.md` document training setup and actual quality results.

## Runtime/Tooling Preferences

- Use **Node.js 22+ and npm**. This is an ESM package; Bun/Yarn/pnpm are not the documented toolchain.
- Edit sources, never `character.bundle.js`, `local-ai-worker.bundle.js` or generated `.LEGAL.txt` files. Builds are gitignored. Keep the AI Worker bundle **IIFE/classic**, not a module Worker: the pinned LiteRT runtime uses `importScripts`.
- Local AI requires a WebGPU-capable browser; browser capability and model compatibility checks are part of the feature. `character.js` is currently outside the active page import graph; its user-supplied `GawrGura/` assets are optional and gitignored.
- Vendoring uses Python 3, with external `curl`/`cwebp` where needed; consult the relevant `tools/vendor_*.py` and README before regenerating resources. Preserve source attribution and atomic publication.
- LoRA tooling is isolated: Python 3.11 with `uv` and `training/lora/uv.lock`; do not merge its dependencies into the app toolchain.

## Testing & QA

- JavaScript uses `node:test` and `node:assert/strict`, with colocated `*.test.js`. `npm test` covers date/import contracts, resource integrity, banners, server security, AI/session behavior and chat storage. No coverage threshold or coverage tool is configured.
- Storage tests inject a fresh `fake-indexeddb` factory; AI tests inject clients/Workers. Keep tests deterministic and isolated from user storage, network downloads and real model weights.
- For browser changes, exercise the actual surface. Optional Playwright checks: `tools/local-ai-check.mjs` (AI UI/Worker regression), `tools/momo-memory-check.mjs` (MomoTalk transcript/memory UI, migration, backup, two tabs, retry and storage-failure paths; `MOMO_CHECK_BROWSER=chromium|firefox|webkit`), `tools/momo-scale-check.mjs` (10k-message scale: pages, DOM, prompt size), `tools/chat-store-browser-check.mjs` (native IndexedDB across engines), `tools/local-ai-live-check.mjs` (opt-in real model + 2 GB download), and `tools/usability-check.mjs` (visual audit, not an assertion gate). Playwright is not a saved dependency; setup instructions are in README/progress docs. Fake IndexedDB results are not browser-engine verification.
- Native storage check: `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tools/chat-store-browser-check.mjs`; engine executable overrides are documented in `docs/chat-memory-progress.md`.
- From `training/lora/`, run `uv run --locked python -m unittest test_pipeline test_stack test_loop -v`; use `uv run --locked python run.py validate` for the separate data/tokenizer validation workflow. Fixed evaluation sets for prompt work: `node build_style_probes.mjs <out>` + `uv run --locked python voice_probe.py` (voice/style metrics, supports `--rejudge`, `--compare`, `--adapter`, `--samples`) and `node build_memory_probes.mjs <out>` + `uv run --locked python memory_probe.py` (memory on/off). These use the cached local Qwen3 weights, not the app model.
