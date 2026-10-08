FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Abhängigkeiten zuerst: Solange sich die Manifeste nicht ändern, bleibt diese Schicht im Cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @bid/api...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# Demodaten für `pnpm seed` (frei erfundene Beispiele, siehe demo-data/).
COPY demo-data demo-data

# Hochgeladene Dateien liegen im Volume /data; der Ordner gehört dem Betriebsbenutzer.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
USER node
EXPOSE 3000
VOLUME /data

# Die Migrationen laufen beim Start (idempotent). tsx führt den TypeScript-Quelltext direkt aus.
# Das Arbeitsverzeichnis ist apps/api: pnpm legt tsx nur dort in node_modules ab, nicht im Wurzelverzeichnis.
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
