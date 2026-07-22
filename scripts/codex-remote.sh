#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
exec node "$project_dir/scripts/codex-remote.mjs" "$@"
