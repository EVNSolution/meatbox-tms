FROM node:26.3.1-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/var/lib/push-lab/push-lab.sqlite \
    PUSH_LAB_MODE=all \
    PUSH_LAB_SENDER_MODE=mock \
    DEPLOYMENT_PROBE_DELIVERABLE=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node . .

RUN npm run vendor:firebase \
    && mkdir -p /var/lib/push-lab /var/backups/push-lab \
    && chown node:node /var/lib/push-lab /var/backups/push-lab \
    && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); const version = db.prepare('SELECT sqlite_version() AS version').get().version; const a = version.split('.').map(Number); const b = [3, 51, 3]; if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] < b[2])) throw new Error('SQLite >=3.51.3 required, found ' + version); console.log('SQLite runtime:', version);"

USER node
EXPOSE 3000

ENTRYPOINT ["sh", "-c", "node -e \"const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); const current = db.prepare('SELECT sqlite_version() AS version').get().version; const a = current.split('.').map(Number); const b = [3, 51, 3]; if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] < b[2])) throw new Error('SQLite >=3.51.3 required, found ' + current);\" && case \"$PUSH_LAB_MODE\" in web) exec node server/main.mjs ;; worker) exec node worker/main.mjs ;; all) exec node server/all.mjs ;; *) echo \"PUSH_LAB_MODE must be web, worker, or all\" >&2; exit 64 ;; esac"]
