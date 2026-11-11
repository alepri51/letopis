#!/usr/bin/env bash
# Салон записи — запуск руками, без Docker.
# Нужен PostgreSQL 18 и мастер-ключ — строка подключения администратора PostgreSQL (суперпользователь или CREATEROLE).
# Проще всего поднять только базу стенда:
#   docker compose -f services/compose.yaml up -d pg
# Свою базу задайте через ADMIN_DSN. Мастер-ключ нужен только подготовке дома (шаг 4): сервис получает пропуск
# LETOPIS_PASS — в нём дом и ключ консьержа. Пропуск уже есть — задайте LETOPIS_PASS, тогда мастер-ключ не нужен.
set -euo pipefail
cd "$(dirname "$0")"
export ADMIN_DSN="${ADMIN_DSN:-postgres://postgres:guide@127.0.0.1:15440/letopis}"
export PORT="${PORT:-8081}"
echo "1/5 библиотека letopis: сборка из репозитория"
(cd ../../lib && npm ci --no-audit --no-fund && npm run build)
echo "2/5 зависимости сервиса"
npm install --no-audit --no-fund
echo "3/5 интерфейс (React + shadcnblocks)"
(cd web && npm ci --no-audit --no-fund && npm run build)
if [ -z "${LETOPIS_PASS:-}" ]; then
  echo "4/5 дом: setup() мастер-ключом печатает пропуск консьержа (повтор отдаёт тот же)"
  LETOPIS_PASS="$(node src/setup.mjs | sed -n 's/^LETOPIS_PASS=//p')"
  [ -n "$LETOPIS_PASS" ] || { echo "подготовка дома не дала пропуска" >&2; exit 1; }
  export LETOPIS_PASS
else
  echo "4/5 дом: пропуск задан (LETOPIS_PASS) — подготовка не нужна"
fi
echo "5/5 сервис: http://127.0.0.1:${PORT} — у него только пропуск, мастер-ключа в его окружении нет"
exec env -u ADMIN_DSN node src/server.mjs
