# Helpdesk: библиотека собирается из репозитория и ставится тарболом — как у настоящего потребителя пакета.
# Контекст сборки — корень репозитория (services/compose.yaml).
FROM node:22-alpine AS lib
WORKDIR /repo/lib
COPY lib/package.json lib/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY lib/ ./
RUN mkdir -p /pkg && npm run build && npm pack --pack-destination /pkg && mv /pkg/letopis-*.tgz /pkg/letopis.tgz

# интерфейс: React + Tailwind + shadcn/ui
FROM node:22-alpine AS web
WORKDIR /web
COPY services/helpdesk/web/package.json services/helpdesk/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/helpdesk/web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY services/helpdesk/package.json ./
COPY --from=lib /pkg/ /pkg/
RUN sed -i 's#"letopis": "file:../../lib"#"letopis": "file:/pkg/letopis.tgz"#' package.json \
  && npm install --omit=dev --no-audit --no-fund
COPY services/helpdesk/src ./src
COPY --from=web /web/dist ./web/dist
COPY services/helpdesk/scenario.mjs ./
EXPOSE 8083
CMD ["node", "src/server.mjs"]
