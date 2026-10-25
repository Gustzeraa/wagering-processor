FROM oven/bun:1 AS app
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/main.ts"]