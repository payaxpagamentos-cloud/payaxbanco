'use strict';

/*
 * Fonte de arquivos para a verificação de integridade no servidor: lê do disco o código da plataforma.
 * Só roda no Node (não entra na demonstração do navegador).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.join(__dirname, '..', '..');
/** O que é monitorado: servidor, as três interfaces (Banqueiro, Internet Banking, site) e a configuração de implantação. */
const PASTAS = ['server', 'public'];
const ARQUIVOS = ['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', 'Caddyfile'];
const TEXTO = /\.(js|mjs|cjs|json|html|css|md|yml|yaml|txt|svg)$|(^|\/)(Dockerfile|Caddyfile)$/;
const MAX_CONTEUDO = 400 * 1024;

function listarArquivos(raiz = RAIZ) {
  const lista = [];
  const visitar = (rel) => {
    const abs = path.join(raiz, rel);
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const nome of fs.readdirSync(abs).sort()) if (!nome.startsWith('.') && nome !== 'node_modules') visitar(path.posix.join(rel, nome));
      return;
    }
    const buf = fs.readFileSync(abs);
    const texto = TEXTO.test(rel) && buf.length <= MAX_CONTEUDO;
    lista.push({ caminho: rel, hash: crypto.createHash('sha256').update(buf).digest('hex'), tamanho: buf.length, conteudo: texto ? buf.toString('utf8') : null });
  };
  for (const p of [...PASTAS, ...ARQUIVOS]) visitar(p);
  return lista;
}

const fonteDisco = (raiz = RAIZ) => ({ descricao: 'arquivos do servidor', listar: () => listarArquivos(raiz) });

module.exports = { fonteDisco, listarArquivos, PASTAS, ARQUIVOS, TEXTO };
