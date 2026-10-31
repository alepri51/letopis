# Сайт документации и песочница: сборка VitePress, сервер статики и прогон примеров, присланных со страницы.
# Контекст сборки — корень репозитория (services/compose.yaml): в образ попадает библиотека исходниками.
FROM node:22-alpine AS build
WORKDIR /repo/guide
COPY guide/package.json guide/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY guide/ ./
RUN npm run build

# зависимости прогона примеров (tsx, typescript, shiki, postgres, zod, MCP, PGlite) — без vitepress и mermaid
FROM node:22-alpine AS deps
WORKDIR /repo/guide
COPY guide/package.json guide/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/guide
COPY --from=deps /repo/guide/node_modules ./node_modules
COPY --from=build /repo/guide/.vitepress/dist ./.vitepress/dist
COPY guide/package.json guide/tsconfig.json guide/server.mjs ./
COPY guide/kit ./kit
COPY guide/scripts ./scripts
# Примеры берут letopis исходниками (пути tsconfig ведут в ../lib/src), как при записи снимков. Зависимости
# библиотеки (postgres, zod, MCP) — из node_modules сайта: lib/node_modules — ссылка на него, экземпляр один.
COPY lib/package.json /repo/lib/
COPY lib/src /repo/lib/src
COPY lib/sql /repo/lib/sql
COPY lib/test/_harness.ts /repo/lib/test/
RUN ln -s /repo/guide/node_modules /repo/lib/node_modules
# внутри контейнера — все интерфейсы; compose публикует порт только на 127.0.0.1
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "server.mjs"]
