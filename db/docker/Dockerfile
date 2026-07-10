# Dev-контейнер clockz: TimescaleDB + Redis в одном контейнере (решение проекта).
# Сборка:  docker build -t clockz-db db/docker
# Запуск:  docker run -d --name clockz-timescale -p 15432:5432 -p 16379:6379 \
#            -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clockz clockz-db
FROM timescale/timescaledb:latest-pg17

RUN apk add --no-cache redis

COPY start.sh /usr/local/bin/start-clockz.sh
RUN chmod +x /usr/local/bin/start-clockz.sh

EXPOSE 5432 6379

ENTRYPOINT ["/usr/local/bin/start-clockz.sh"]
CMD ["postgres"]
