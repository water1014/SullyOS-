FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# The sync service only needs PostgreSQL's driver. Do not install the large
# frontend dependency tree into the small VPS runtime image.
RUN npm install --omit=dev --no-audit --no-fund --save-exact pg@8.20.0 \
    && npm cache clean --force

COPY --chown=node:node server/companion-sync ./server/companion-sync
USER node

EXPOSE 8787
CMD ["node", "server/companion-sync/server.mjs"]
