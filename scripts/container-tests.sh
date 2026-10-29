#!/bin/sh
set -u

# Без адреса базы интеграционные тесты молча пропускаются, что здесь недопустимо.
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must be set}"

go test ./... -count=1 -v -timeout=5m
status=$?
printf '\nСервер: '
if [ "$status" -eq 0 ]; then
    printf 'все тесты пройдены\n'
else
    printf 'тесты завершились с ошибкой (код %s)\n' "$status"
fi
exit "$status"
