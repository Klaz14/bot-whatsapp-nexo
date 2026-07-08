FROM node:22-bookworm-slim

ENV NODE_ENV=production
# Puppeteer usa su Chrome BUNDLED (version atada a puppeteer-core en package-lock, siempre
# compatible), NO el 'chromium' de apt. Motivo: apt sin pin trae una version nueva en cada
# rebuild y rompe el arranque headless (incidente 08/07/2026: Chromium 150 de apt vs
# Puppeteer 24.38 -> "Failed to launch the browser process: Code: null").
# 'chromium' de apt se mantiene abajo SOLO por sus librerias de sistema (deps del navegador).

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

# Chrome 131 FIJO. Las versiones recientes (chromium 150 de apt, y el bundled ~142 de
# Puppeteer) NO renderizan en este contenedor -> "Failed to launch the browser process:
# Code: null" (incidente 08/07/2026). La 131.0.6778.264 SI renderiza (verificado en el
# contenedor con --dump-dom). Version pinneada = reproducible en cada rebuild.
RUN npx puppeteer browsers install chrome@131.0.6778.264
ENV PUPPETEER_EXECUTABLE_PATH=/root/.cache/puppeteer/chrome/linux-131.0.6778.264/chrome-linux64/chrome

COPY . .

# [PATCH #3971] Sobrescribir Client.js de whatsapp-web.js con el parche local
# (try/catch + guards en el bloque authenticated->ready). Va DESPUES de COPY . .
# para garantizar que ninguna capa posterior lo pise. node_modules esta en
# .dockerignore, asi que COPY . . no trae el node_modules local.
COPY patches/Client.js node_modules/whatsapp-web.js/src/Client.js

CMD ["npm", "start"]
