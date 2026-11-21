# Vai Mídia — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3600 \
    MIDIA_DB=/app/data/midia.db \
    MIDIA_ARQUIVOS=/app/data/arquivos

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# Banco e arquivos das mídias ficam em /app/data (monte um volume persistente aqui).
RUN mkdir -p /app/data/arquivos && chown -R node:node /app/data
USER node

EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.MIDIA_BASE_PATH||'/midia')+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
