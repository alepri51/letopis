#!/bin/sh
# Redis фоном (dev: без пароля и персиста — сессии эфемерны), затем штатный entrypoint postgres.
redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save '' --appendonly no --daemonize yes
exec docker-entrypoint.sh "$@"
