# Apresentação do sistema

Os slides são um HTML comum (`index.html` + `apresentacao.css`) e o PDF é impresso pelo navegador, com as
telas capturadas do sistema **rodando de verdade** — assim a apresentação não envelhece sozinha.

```
npm run seed && npm start     # noutro terminal, com os dados de demonstração
npm run apresentacao          # gera apresentacao/Mercado-Binho-apresentacao.pdf
```

Precisa do Chromium do Playwright na máquina (`npx playwright install chromium`). As imagens (`img/`), as
fontes copiadas (`fontes/`) e o PDF não vão para o repositório: são gerados pelo comando.

Para mudar um texto, edite `index.html` e rode de novo. O visual (cores, fontes, caixas) está em
`apresentacao.css`, com as mesmas cores da marca.
