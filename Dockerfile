FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/
COPY index.html styles.css checker.js retro-terminal.svg reset-password.html reset-password.js ./
COPY ml/artifacts/scamshield-text-v1.0.0/model.json ml/artifacts/scamshield-text-v1.0.0/manifest.json ./ml/artifacts/scamshield-text-v1.0.0/
RUN mkdir -p /app/.cache/tesseract && chown -R node:node /app/.cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["node", "--import", "tsx", "server/index.ts"]
