#!/bin/sh
# FILE: lib/docker/start.sh
# VERSION: 1.0.0
# START_MODULE_CONTRACT
#   PURPOSE: Entrypoint dev-контейнера — поднять Redis фоном, затем штатный postgres docker-entrypoint.
#   SCOPE: redis-server (daemonize) + exec docker-entrypoint.sh.
#   DEPENDS: none
#   LINKS: M-DOCKER, V-M-DOCKER
#   ROLE: SCRIPT
#   MAP_MODE: NONE
# END_MODULE_CONTRACT
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
# END_CHANGE_SUMMARY
# Redis фоном (dev: без пароля и персиста — сессии эфемерны), затем штатный entrypoint postgres.
redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save '' --appendonly no --daemonize yes
exec docker-entrypoint.sh "$@"
