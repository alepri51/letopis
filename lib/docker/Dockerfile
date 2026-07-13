# Dev-контейнер letopis: TimescaleDB + Redis в одном контейнере (решение проекта).
# Обычный путь — letopis.up() собирает и запускает сам. Руками:
#   docker build -t letopis-db lib/docker
#   docker run -d --name letopis-timescale -p 15432:5432 -p 16379:6379 \
#     -v letopis-pgdata:/var/lib/postgresql/data \
#     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=letopis letopis-db
# FILE: lib/docker/Dockerfile
# VERSION: 1.0.0
# START_MODULE_CONTRACT
#   PURPOSE: Dev-образ БД — TimescaleDB pg17 + Redis в одном контейнере (для letopis.up()).
#   SCOPE: базовый образ, установка redis, копирование start.sh, EXPOSE 5432/6379, entrypoint.
#   DEPENDS: none
#   LINKS: M-DOCKER, V-M-DOCKER
#   ROLE: CONFIG
#   MAP_MODE: SUMMARY
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   FROM timescale/timescaledb:latest-pg17 - база (PostgreSQL 17 + TimescaleDB)
#   apk add redis - Redis в тот же образ
#   ENTRYPOINT start-letopis.sh - запуск redis + postgres
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
# END_CHANGE_SUMMARY

# START_BLOCK_IMAGE_BUILD
FROM timescale/timescaledb:latest-pg17

RUN apk add --no-cache redis

COPY start.sh /usr/local/bin/start-letopis.sh
RUN chmod +x /usr/local/bin/start-letopis.sh

EXPOSE 5432 6379

ENTRYPOINT ["/usr/local/bin/start-letopis.sh"]
CMD ["postgres"]
# END_BLOCK_IMAGE_BUILD
