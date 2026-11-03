# Сайт документации и песочница: сборка VitePress, сервер статики и прогон примеров, присланных со страницы.
# Контекст сборки — корень репозитория (services/compose.yaml): в образ попадают сайт, примеры (examples/) и библиотека
# исходниками. Сайт примеры только читает: при сборке — исходники и снимки, в песочнице — запускает их раннер.
FROM node:22-alpine AS build
WORKDIR /repo/guide
COPY guide/package.json guide/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY guide/ ./
# страницы встраивают примеры и снимки из ../examples (исходники, _shared, _snapshots)
COPY examples/ /repo/examples/
RUN npm run build

# зависимости примеров (tsx, typescript, shiki, postgres, zod, MCP, PGlite) — свои у examples/; letopis там — file:../lib
FROM node:22-alpine AS deps
COPY lib/package.json /repo/lib/
WORKDIR /repo/examples
COPY examples/package.json examples/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/guide
COPY --from=build /repo/guide/.vitepress/dist ./.vitepress/dist
COPY guide/package.json guide/server.mjs ./
# Примеры берут letopis исходниками (пути examples/tsconfig.json ведут в ../lib/src), как при записи снимков.
COPY examples/ /repo/examples/
COPY --from=deps /repo/examples/node_modules /repo/examples/node_modules
COPY lib/package.json /repo/lib/
COPY lib/src /repo/lib/src
COPY lib/sql /repo/lib/sql
# Зависимости библиотеки (postgres, zod, MCP) — из node_modules примеров: lib/node_modules — ссылка на него, экземпляр один.
RUN ln -s /repo/examples/node_modules /repo/lib/node_modules
# внутри контейнера — все интерфейсы; compose публикует порт только на 127.0.0.1
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "server.mjs"]
