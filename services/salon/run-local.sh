#!/usr/bin/env bash
# Салон записи — запуск руками, без Docker.
# Нужен PostgreSQL 18 и роль администратора. Проще всего поднять только базу стенда:
#   docker compose -f services/compose.yaml up -d pg
# Свою базу задайте через ADMIN_DSN (администратор) и APP_DSN (роль приложения — её создаст сервис).
set -euo pipefail
cd "$(dirname "$0")"
export ADMIN_DSN="${ADMIN_DSN:-postgres://postgres:guide@127.0.0.1:15440/letopis}"
export APP_DSN="${APP_DSN:-postgres://salon_app:salon-app-secret@127.0.0.1:15440/letopis}"
export PORT="${PORT:-8081}"
echo "1/4 библиотека letopis: сборка из репозитория"
(cd ../../lib && npm ci --no-audit --no-fund && npm run build)
echo "2/4 зависимости сервера"
npm install --no-audit --no-fund
echo "3/4 интерфейс (React + shadcnblocks)"
(cd web && npm ci --no-audit --no-fund && npm run build)
echo "4/4 сервер: http://127.0.0.1:${PORT}"
exec node src/server.mjs
