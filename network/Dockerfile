# Manager Network — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3500 \
    NETWORK_DADOS=/app/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Banco e arquivos privados em /app/data (monte um volume persistente e inclua no backup).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# 3500: painel. UDP 2055/4739/6343 (flows) e 1813 (RADIUS accounting) quando o coletor roda neste contêiner
# (NETWORK_COLETOR_EMBUTIDO=1 ou CMD trocado por server/coletor-rede.js).
EXPOSE 3500 2055/udp 4739/udp 6343/udp 1813/udp
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.NETWORK_BASE_PATH||'')+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
