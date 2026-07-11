# Dev-контейнер letopis: TimescaleDB + Redis в одном контейнере (решение проекта).
# Обычный путь — letopis.up() собирает и запускает сам. Руками:
#   docker build -t letopis-db lib/docker
#   docker run -d --name letopis-timescale -p 15432:5432 -p 16379:6379 \
#     -v letopis-pgdata:/var/lib/postgresql/data \
#     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=letopis letopis-db
FROM timescale/timescaledb:latest-pg17

RUN apk add --no-cache redis

COPY start.sh /usr/local/bin/start-letopis.sh
RUN chmod +x /usr/local/bin/start-letopis.sh

EXPOSE 5432 6379

ENTRYPOINT ["/usr/local/bin/start-letopis.sh"]
CMD ["postgres"]
