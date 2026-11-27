#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mode="${1:-all}"
case "$mode" in
    all) scenarios=(mix capacity auth websocket) ;;
    mix|capacity|auth|websocket|soak|browser) scenarios=("$mode") ;;
    *) echo 'Использование: bash scripts/load.sh [all|mix|capacity|auth|websocket|soak|browser]' >&2; exit 2 ;;
esac

if docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    compose=(docker-compose)
else
    echo 'Требуется Docker Compose.' >&2
    exit 1
fi

project="currency-load-$(date +%s)-$$"
compose+=(-p "$project" -f compose.load.yaml)
export LOAD_OUTPUT="${LOAD_OUTPUT:-$PWD/load/results/$project}"
export LOAD_UID="$(id -u)" LOAD_GID="$(id -g)"
if [[ "$mode" == soak ]]; then
    export LOAD_GO_DEBUG=schedtrace=30000,scheddetail=1
fi
build_flag=--build
if [[ "${LOAD_SKIP_BUILD:-0}" == 1 ]]; then
    build_flag=--no-build
    needed=("${LOAD_API_IMAGE:-currency-tracker-load-api:local}"
            "${LOAD_DEVSEED_IMAGE:-currency-tracker-load-devseed:local}")
    if [[ "$mode" == websocket || "$mode" == all ]]; then
        needed+=("${LOAD_TICKGEN_IMAGE:-currency-tracker-load-tickgen:local}")
    fi
    docker image inspect "${needed[@]}" >/dev/null
fi
mkdir -p "$LOAD_OUTPUT"
LOAD_OUTPUT="$(cd "$LOAD_OUTPUT" && pwd -P)"
stats_pid=
cleanup() {
    local status=$?
    trap - EXIT
    if [[ -n "$stats_pid" ]]; then
        kill "$stats_pid" 2>/dev/null || true
        wait "$stats_pid" 2>/dev/null || true
    fi
    if [[ "$mode" == soak ]]; then
        "${compose[@]}" logs --no-color api > "$LOAD_OUTPUT/soak-api.log" 2>&1 || true
    fi
    "${compose[@]}" --profile tools --profile browser down --volumes --remove-orphans || status=1
    echo "Отчёты: $LOAD_OUTPUT"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker info --format 'Docker: {{.Architecture}}, CPU: {{.NCPU}}, RAM: {{.MemTotal}} bytes, {{.OSType}} {{.ServerVersion}}' | tee "$LOAD_OUTPUT/host.txt"
"${compose[@]}" up -d "$build_flag" --wait --wait-timeout 120 api
# API применяет миграции. Останавливаем его на время заполнения, чтобы
# первая свёртка после старта увидела сразу всю историю.
"${compose[@]}" stop api
if [[ "$build_flag" == --build ]]; then
    "${compose[@]}" build devseed
fi
"${compose[@]}" run --rm devseed -days=8
"${compose[@]}" up -d --wait --wait-timeout 120 api

sample_stats() {
    local scenario=$1
    local containers
    containers=$("${compose[@]}" ps -q api db)
    while true; do
        date -u +%FT%TZ
        if [[ -n "$containers" ]]; then
            # Docker Compose возвращает по одному ID на строку.
            printf '%s\n' "$containers" | xargs docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}} {{.PIDs}}'
        fi
        "${compose[@]}" exec -T db psql -U tracker -d tracker_load -Atc \
            "SELECT state, count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY state ORDER BY state" || true
        sleep 5
    done >> "$LOAD_OUTPUT/$scenario-stats.txt" 2>&1
}

result=0
for scenario in "${scenarios[@]}"; do
    if [[ "$scenario" == browser ]]; then
        "${compose[@]}" up -d --build --wait --wait-timeout 120 web
        "${compose[@]}" run --build --rm -u "$LOAD_UID:$LOAD_GID" browser || result=1
        continue
    fi
    if [[ "$scenario" == websocket ]]; then
        "${compose[@]}" up -d "$build_flag" tickgen
    fi
    sample_stats "$scenario" &
    stats_pid=$!
    "${compose[@]}" run --rm -e LOAD_CASE="$scenario" k6 run "/scenarios/$scenario.js" || result=1
    kill "$stats_pid" 2>/dev/null || true
    wait "$stats_pid" 2>/dev/null || true
    stats_pid=
    if [[ "$scenario" == websocket ]]; then
        "${compose[@]}" logs --no-color tickgen > "$LOAD_OUTPUT/tickgen.log"
        "${compose[@]}" stop tickgen
    fi
done
exit "$result"
