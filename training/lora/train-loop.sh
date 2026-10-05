#!/usr/bin/env bash
# One entry point; no global package changes, cloud provisioning, or interactive approvals.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v uv >/dev/null 2>&1; then
  echo 'uv is required: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
qlora=0
for arg in "$@"; do
  if [[ "$arg" == '--qlora' ]]; then qlora=1; fi
done
if [[ "$qlora" == 1 ]]; then
  uv sync --locked --extra qlora
  exec uv run --locked --extra qlora python loop.py "$@"
fi
uv sync --locked
exec uv run --locked python loop.py "$@"
