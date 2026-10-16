FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
# The web bundle imports only @aisevak/core's dependency-free runtime-events
# module, so core's own (Node) dependencies are not installed here.
RUN pnpm install --frozen-lockfile=false --filter @aisevak/web
COPY packages/core/src/runtime/events.ts packages/core/src/runtime/events.ts
COPY apps/web apps/web
RUN pnpm --filter @aisevak/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
