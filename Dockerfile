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
# Server sudah dikompilasi ke JS saat build (dist-server/): nyala ±3,5× lebih cepat di CPU kecil
# (Koyeb Free 0,1 vCPU: ±15 dtk → ±4,5 dtk), penting karena instance gratis tidur setelah 1 jam sepi.
CMD ["node", "dist-server/index.mjs"]
