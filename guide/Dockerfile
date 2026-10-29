# Сайт документации: сборка VitePress и маленький сервер статики. Контекст сборки — корень репозитория
# (services/compose.yaml): так позже в образ попадёт и библиотека для песочницы.
FROM node:22-alpine AS build
WORKDIR /repo/guide
COPY guide/package.json guide/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY guide/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /guide
COPY --from=build /repo/guide/.vitepress/dist .vitepress/dist
COPY guide/server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
