FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node server/companion-sync ./server/companion-sync
USER node

EXPOSE 8787
CMD ["node", "server/companion-sync/server.mjs"]
