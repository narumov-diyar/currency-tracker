#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    compose=(docker-compose)
else
    echo 'Нужен Docker Compose v2 или новее.' >&2
    exit 1
fi
compose+=(-f compose.yaml)

case "${1:-up}" in
    up)
        "${compose[@]}" up --build --detach --wait --wait-timeout 120
        ;;
    seed)
        shift
        "${compose[@]}" up --build --detach --wait --wait-timeout 120 api
        "${compose[@]}" --profile tools run --build --rm --no-deps devseed "$@"
        ;;
    down)
        # Том базы сохраняется; удалять его для обычной остановки не нужно.
        "${compose[@]}" down
        ;;
    logs)
        "${compose[@]}" logs --follow api db collector web
        ;;
    *)
        echo 'Использование: bash scripts/dev.sh {up|seed [-days=3]|down|logs}' >&2
        exit 2
        ;;
esac
