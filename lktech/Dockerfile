FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# Obrigatório ao rodar: -e PUBLIC_ORIGIN=https://lktechprovedor.com.br (o servidor não sobe sem ele em produção)
# e, atrás de proxy, -e TRUST_PROXY=true. A instalação recomendada é implantacao/instalar.sh.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server/index.mjs"]
