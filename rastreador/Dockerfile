# Rastreador de Veículos — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3400 \
    RASTREADOR_GT06_PORTA=5023 \
    RASTREADOR_DB=/app/data/rastreador.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# O banco de dados fica em /app/data (monte um volume persistente aqui).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# 3400: painel e API (HTTP). 5023: rastreadores GT06 (TCP).
EXPOSE 3400 5023
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.RASTREADOR_BASE_PATH||'')+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
