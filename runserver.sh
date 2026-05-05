#!/usr/bin/env bash
# Launch the dev server. Override HOST/PORT via env, e.g.:
#   PORT=8080 ./runserver.sh
set -euo pipefail
cd "$(dirname "$0")"
exec npm run serve "$@"
