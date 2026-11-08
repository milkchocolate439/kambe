# KAMBE — satu kontainer: API + WebSocket + tampilan (dist/). Dipakai Koyeb / hosting Docker lain.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
EXPOSE 8000
# tsx dibutuhkan saat jalan (server TypeScript langsung).
CMD ["node", "--import", "tsx", "server/index.ts"]
