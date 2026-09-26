#!/usr/bin/env bash
#
# agent-api.sh — run every services/agent-api command from one place.
#
# Usage:
#   ./scripts/agent-api.sh <command>
#
# Commands:
#   run            start the FastAPI dev server (uvicorn, port 8000)
#   test           run the agent-api pytest suite (needs Redis)
#   format         format services/agent-api Python with black
#   format:check   verify formatting without writing (black --check)
#   lint           eslint over the repo
#   typecheck      tsc build + project references
#   js:format:check prettier --check over the repo
#   build          pnpm -r build
#   protocol:check zero protocol drift
#   redis          start the local Redis docker container for tests
#   all            format:check + lint + typecheck + test + build + protocol:check
#   help           show this message

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' RED='' CYAN='' RESET=''
fi

banner() {
  printf '\n%s=== %s ===%s\n' "$BOLD$CYAN" "$1" "$RESET"
}

info() {
  printf '%s%s%s\n' "$DIM" "$1" "$RESET"
}

ok() {
  printf '%s[ok]%s %s\n' "$GREEN" "$RESET" "$1"
}

fail() {
  printf '%s[failed]%s %s\n' "$RED" "$RESET" "$1" >&2
}

# run <label> <command...>
run() {
  local label="$1"
  shift
  banner "$label"
  info "$*"
  if "$@"; then
    ok "$label"
  else
    local status=$?
    fail "$label (exit $status)"
    exit "$status"
  fi
}

cmd_run() {
  banner "Starting agent-api dev server"
  info "uvicorn privacagent_agent_api.app:app --port 8000 --no-access-log"
  info "docs: http://localhost:8000/docs  (ctrl-c to stop)"
  exec uv run --locked uvicorn privacagent_agent_api.app:app \
    --port 8000 --no-access-log
}

cmd_test() {
  run "pytest services/agent-api" \
    uv run --locked pytest services/agent-api/tests
}

cmd_format() {
  run "black services/agent-api (write)" uv run black services/agent-api
}

cmd_format_check() {
  run "black services/agent-api (check)" \
    uv run black --check services/agent-api
}

cmd_lint() {
  run "eslint" pnpm lint
}

cmd_typecheck() {
  run "tsc typecheck" pnpm typecheck
}

cmd_js_format_check() {
  run "prettier --check" pnpm format:check
}

cmd_build() {
  run "pnpm build" pnpm build
}

cmd_protocol_check() {
  run "protocol drift check" pnpm protocol:check
}

cmd_redis() {
  banner "Starting local Redis for tests"
  if docker ps --format '{{.Names}}' | grep -qx 'pa-redis'; then
    info "container pa-redis already running"
  else
    if docker ps -a --format '{{.Names}}' | grep -qx 'pa-redis'; then
      info "reusing existing container pa-redis"
      docker start pa-redis
    else
      info "docker run --name pa-redis -p 6379:6379 -d redis:7-alpine"
      docker run --name pa-redis -p 6379:6379 -d redis:7-alpine
    fi
  fi
  ok "Redis ready on redis://127.0.0.1:6379"
}

cmd_all() {
  banner "Running the full agent-api check suite"
  cmd_format_check
  cmd_lint
  cmd_typecheck
  cmd_test
  cmd_build
  cmd_protocol_check
  banner "All checks passed"
}

usage() {
  sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    run) cmd_run ;;
    test) cmd_test ;;
    format) cmd_format ;;
    format:check) cmd_format_check ;;
    lint) cmd_lint ;;
    typecheck) cmd_typecheck ;;
    js:format:check) cmd_js_format_check ;;
    build) cmd_build ;;
    protocol:check) cmd_protocol_check ;;
    redis) cmd_redis ;;
    all) cmd_all ;;
    help | -h | --help) usage ;;
    *)
      printf '%sUnknown command:%s %s\n\n' "$RED" "$RESET" "$cmd" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
