# PLAY TECH VIP — imagem de produção
ARG BASE=node:22-slim
FROM ${BASE}

ENV NODE_ENV=production \
    PORT=3600 \
    TV_DB=/app/data/tv.db \
    TV_MIDIA=/app/data/midia

# O ffmpeg faz tres coisas aqui: gera as versoes menores (Full HD, HD e SD) dos videos
# enviados, converte o sinal ao vivo (RTMP/SRT) para HLS, e mede a claridade dos logos.
# O pacote do Debian ja vem com tudo que a TV brasileira usa, conferido nesta versao:
#   video  - H.264, H.265/HEVC, MPEG-2, VP9, AV1 (decodifica) e H.264 (codifica, libx264)
#   audio  - AAC, AC-3, E-AC-3, MP2, MP3, Opus (decodifica) e AAC (codifica)
# E o que permite pegar canal com audio em AC-3 (comum em TV aberta), que sairia MUDO no
# Android e no Chrome se fosse copiado como esta, e entregar com som em todo aparelho.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# versao.json carimba o pacote: e o que o painel mostra como versao instalada, e o que
# permite conferir se uma atualizacao entrou de verdade. Sem ele aqui dentro, o painel
# so saberia dizer "desconhecida".
COPY package.json package-lock.json versao.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
# Os scripts de manutencao (importar canais, buscar logos, empacotar) rodam DENTRO do conteiner:
# o servidor nao tem node instalado, so o Docker. Sem isto, "docker compose exec app node
# scripts/..." nao acha o arquivo.
COPY scripts ./scripts

# O banco e os arquivos de vídeo ficam em /app/data (monte um volume persistente aqui:
# os vídeos ocupam muito espaço, bem mais que o banco).
RUN mkdir -p /app/data/midia && chown -R node:node /app/data
USER node

EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
