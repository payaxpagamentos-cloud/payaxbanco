# PAY AX Pagamentos — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3600 \
    PAYAX_DB=/app/data/payax.db \
    PAYAX_ARQUIVOS=/app/data/arquivos

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY cliente ./cliente
COPY comum ./comum

# Banco e arquivos ficam em /app/data (monte um volume persistente aqui).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
