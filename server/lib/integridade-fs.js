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

/** Caminho relativo seguro dentro do que é monitorado (sem "..", sem caminho absoluto). */
function caminhoSeguro(raiz, caminho) {
  const rel = path.posix.normalize(String(caminho));
  const permitido = ARQUIVOS.includes(rel) || PASTAS.some((p) => rel.startsWith(`${p}/`));
  if (!permitido || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\0')) throw new Error(`Caminho não permitido: ${caminho}`);
  return path.join(raiz, rel);
}

/**
 * Fonte de arquivos do disco. `restaurar` grava de volta o conteúdo da versão aprovada ou, para arquivo que não existia
 * na versão aprovada (base = null), move o arquivo para a quarentena (pasta de dados), sem apagar.
 */
const fonteDisco = (raiz = RAIZ, pastaQuarentena = null) => ({
  descricao: 'arquivos do servidor',
  listar: () => listarArquivos(raiz),
  existe: (caminho) => fs.existsSync(path.join(raiz, caminho)),
  restaurar(caminho, base) {
    const abs = caminhoSeguro(raiz, caminho);
    if (base === null) {
      const destino = path.join(pastaQuarentena ?? path.join(raiz, 'data', 'quarentena'), new Date().toISOString().replace(/[:.]/g, '-'), caminho);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.copyFileSync(abs, destino);
      fs.rmSync(abs);
      return 'quarentena';
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, base.conteudo);
    return 'restaurado';
  },
});

module.exports = { fonteDisco, listarArquivos, PASTAS, ARQUIVOS, TEXTO };
