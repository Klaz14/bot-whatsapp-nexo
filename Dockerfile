FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    poppler-utils \
    poppler-data \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# [PATCH #3971] Sobrescribir Client.js de whatsapp-web.js con el parche local
# (try/catch + guards en el bloque authenticated->ready). Va DESPUES de COPY . .
# para garantizar que ninguna capa posterior lo pise. node_modules esta en
# .dockerignore, asi que COPY . . no trae el node_modules local.
COPY patches/Client.js node_modules/whatsapp-web.js/src/Client.js

CMD ["npm", "start"]
