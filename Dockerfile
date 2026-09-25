# Backend (API + workers) — image utilisée par Railway.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend
RUN npm ci --no-audit --no-fund
RUN npm run build -w apps/backend && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
# FFmpeg : conversion optionnelle des audios en OGG/Opus
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/migrations ./apps/backend/migrations
WORKDIR /app/apps/backend
USER node
EXPOSE 3000
# Les migrations sont appliquées au démarrage (verrou PostgreSQL : sûr avec plusieurs instances).
CMD ["node", "dist/main.js"]
