# Vai Mídia — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3600 \
    MIDIA_DB=/app/data/midia.db \
    MIDIA_ARQUIVOS=/app/data/arquivos \
    MIDIA_BACKUPS=/app/data/backups

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY site ./site

# Banco, arquivos das mídias e backups ficam em /app/data (monte um volume persistente aqui).
# Para o espelho das mídias, monte outro volume e aponte MIDIA_ESPELHO para ele.
RUN mkdir -p /app/data/arquivos /app/data/backups && chown -R node:node /app/data
USER node

EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.MIDIA_BASE_PATH||'/midia')+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
