# MOLU

Unofficial Blue Archive calendar for KR server, built from Nexon's official notices.

[Open the calendar](https://7591yj.github.io/molu-calendar/)

## Development

Requires Node.js 22.18+ and pnpm. Nix users can run `nix develop`.

```sh
pnpm install
pnpm dev              # http://localhost:4321
pnpm check            # Formatting, linting, types, and tests
pnpm build            # Build to dist/
pnpm preview          # Preview at http://127.0.0.1:8787
```

To refresh schedule data:

```sh
pnpm scrape           # Latest notices
pnpm scrape:backfill  # Older notices too
```

## Deployment

GitHub Actions refreshes schedules every Monday at 19:00 KST and deploys to GitHub Pages. Code pushes to `main` also trigger deployment.

## Browser-local chat and AI

MomoTalk stores transcripts and explicit memories in IndexedDB. Existing
`molu.momotalk.v1` localStorage history migrates once; the original snapshot is
preserved. Use the chat controls to page older messages, save or edit memories,
export/import backups, delete history, or request persistent browser storage.
Back up important conversations: browser storage can be cleared or evicted.

AI is optional. The pinned LiteRT-LM 0.17.1 runtime runs Gemma 4 E2B in a classic
browser Web Worker using WASM and WebGPU. Users explicitly download roughly 2 GB
from Hugging Face. No Cloudflare Worker or inference server is involved. Target
Chrome/Edge on a GPU-capable device; unsupported devices retain scripted chat and
the full calendar. A compatible browser does not guarantee adequate GPU memory
or acceptable inference speed.

`pnpm dev` and `pnpm build` generate the Worker and copy LiteRT's runtime assets.
GitHub Pages deployments set `SITE_BASE=/molu-calendar`; Worker and WASM URLs are
relative to that project path. Model weights are not included in the Pages
artifact. `public/_headers` applies only on hosts that recognize that format;
GitHub Pages does not consume it. Keep runtime/model versions pinned together.

The official KR schema-v2 feed remains authoritative for the calendar. Upstream's
multi-region schema-v1 data and banners are retained under `public/resource/`
for vendoring and research, rather than merged into the live KR feed.

## Upstream tools and checks

`pnpm test` runs the typed calendar/scraper tests and upstream's storage, memory,
transcript, persona and AI regressions. `python3 -B tools/test_vendor_publication.py`
checks atomic vendor publication. The root legacy calendar module remains a
schema-v1 validation utility; it does not render the React calendar.

`tools/vendor_momotalk.py` refreshes the persona dialogue corpus;
`tools/vendor_momotalk_ui.py` retains the UI asset downloader. Vendor scripts write
into `public/resource/`. `training/lora/` contains a separate experimental
Python/uv training pipeline and its own documentation. Training outputs are not
loaded by the browser app. `tools/upstream-browser/` contains archived browser
checks for the replaced vanilla UI, not checks for this React interface.

## Credits

Schedules and banners come from the [official Blue Archive community](https://forum.nexon.com/bluearchive). MomoTalk assets come from [blue-utils.me](https://blue-utils.me), [SchaleDB](https://github.com/SchaleDB/SchaleDB), [closure-talk](https://github.com/ClosureTalk/closure-talk), [Blue Archive Wiki](https://bluearchive.wiki), and [pizza-studio/momotalk](https://github.com/pizza-studio/momotalk). Fonts are [Gyeonggi Millennium Title](https://www.gg.go.kr/contents/contents.do?ciIdx=679&menuId=2457) and [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR).

This fan project is not affiliated with NEXON or NEXON Games. Game assets belong to their respective owners.
