# PLAY TECH VIP — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3600 \
    TV_DB=/app/data/tv.db \
    TV_MIDIA=/app/data/midia

# O ffmpeg gera as versões menores (Full HD, HD e SD) dos vídeos enviados.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# O banco e os arquivos de vídeo ficam em /app/data (monte um volume persistente aqui:
# os vídeos ocupam muito espaço, bem mais que o banco).
RUN mkdir -p /app/data/midia && chown -R node:node /app/data
USER node

EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
