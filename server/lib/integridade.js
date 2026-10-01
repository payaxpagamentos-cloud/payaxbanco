'use strict';

/*
 * Integridade do código da plataforma (Banqueiro, Internet Banking, site e servidor).
 * Compara os arquivos atuais com a linha de base aprovada pelo administrador: arquivo novo, removido ou
 * alterado vira alerta, com as linhas que mudaram. A linha de base só muda quando o administrador aprova
 * (por exemplo, depois de uma atualização legítima).
 *
 * A "fonte" fornece a lista de arquivos ({ caminho, hash, tamanho, conteudo|null }): no servidor ela lê o
 * disco; na demonstração vem de um manifesto gerado no build.
 */

const MAX_TRECHOS = 160; // linhas de diferença guardadas por arquivo
const MAX_ARQUIVOS_COM_TRECHO = 40;

/** Diferença linha a linha (prefixo e sufixo comuns + LCS no meio). */
function diferenca(antes, depois) {
  const a = String(antes ?? '').split('\n');
  const b = String(depois ?? '').split('\n');
  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let fimA = a.length - 1;
  let fimB = b.length - 1;
  while (fimA >= ini && fimB >= ini && a[fimA] === b[fimB]) { fimA--; fimB--; }
  const ma = a.slice(ini, fimA + 1);
  const mb = b.slice(ini, fimB + 1);
  const trechos = [];
  if (ma.length * mb.length <= 2_000_000) {
    // Tabela LCS do fim para o começo.
    const n = ma.length; const m = mb.length;
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = ma[i] === mb[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { i++; j++; } else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) {
        trechos.push({ tipo: '-', linha: ini + i + 1, texto: ma[i] }); i++;
      } else { trechos.push({ tipo: '+', linha: ini + j + 1, texto: mb[j] }); j++; }
    }
  } else {
    ma.forEach((texto, k) => trechos.push({ tipo: '-', linha: ini + k + 1, texto }));
    mb.forEach((texto, k) => trechos.push({ tipo: '+', linha: ini + k + 1, texto }));
  }
  return {
    adicionadas: trechos.filter((x) => x.tipo === '+').length,
    removidas: trechos.filter((x) => x.tipo === '-').length,
    trechos: trechos.slice(0, MAX_TRECHOS).map((x) => ({ ...x, texto: x.texto.length > 300 ? `${x.texto.slice(0, 300)}…` : x.texto })),
    cortado: trechos.length > MAX_TRECHOS,
  };
}

function gravarBase(db, arquivos, usuarioId) {
  db.prepare('DELETE FROM integridade_base').run();
  const ins = db.prepare('INSERT INTO integridade_base (caminho, hash, tamanho, conteudo, aprovado_por) VALUES (?, ?, ?, ?, ?)');
  for (const f of arquivos) ins.run(f.caminho, f.hash, f.tamanho, f.conteudo ?? null, usuarioId ?? null);
}

/** Compara a fonte com a linha de base. Sem linha de base, cria a primeira. */
function verificar(db, fonte) {
  const atuais = fonte.listar();
  const base = db.prepare('SELECT caminho, hash, tamanho, conteudo, aprovado_em FROM integridade_base').all();
  if (!base.length) {
    gravarBase(db, atuais, null);
    return { status: 'base_criada', arquivos: atuais.length, alteracoes: [], base_aprovada_em: null };
  }
  const mapaBase = new Map(base.map((f) => [f.caminho, f]));
  const mapaAtual = new Map(atuais.map((f) => [f.caminho, f]));
  const alteracoes = [];
  for (const f of atuais) {
    const b = mapaBase.get(f.caminho);
    if (!b) alteracoes.push({ caminho: f.caminho, tipo: 'adicionado', depois: { hash: f.hash, tamanho: f.tamanho }, conteudoDepois: f.conteudo });
    else if (b.hash !== f.hash) alteracoes.push({ caminho: f.caminho, tipo: 'alterado', antes: { hash: b.hash, tamanho: b.tamanho }, depois: { hash: f.hash, tamanho: f.tamanho }, conteudoAntes: b.conteudo, conteudoDepois: f.conteudo });
  }
  for (const b of base) if (!mapaAtual.has(b.caminho)) alteracoes.push({ caminho: b.caminho, tipo: 'removido', antes: { hash: b.hash, tamanho: b.tamanho }, conteudoAntes: b.conteudo });
  alteracoes.sort((x, y) => x.caminho.localeCompare(y.caminho));
  let comTrecho = 0;
  const resultado = alteracoes.map(({ conteudoAntes, conteudoDepois, ...a }) => {
    const texto = (conteudoAntes ?? null) !== null || (conteudoDepois ?? null) !== null;
    if (texto && comTrecho < MAX_ARQUIVOS_COM_TRECHO) {
      comTrecho++;
      return { ...a, diff: diferenca(a.tipo === 'adicionado' ? '' : conteudoAntes, a.tipo === 'removido' ? '' : conteudoDepois) };
    }
    return { ...a, diff: null };
  });
  return {
    status: resultado.length ? 'alterado' : 'ok',
    arquivos: atuais.length,
    alteracoes: resultado,
    base_aprovada_em: base.reduce((m, f) => (f.aprovado_em > m ? f.aprovado_em : m), ''),
  };
}

/** Aprova o estado atual como nova linha de base (alterações legítimas). */
function aprovar(db, fonte, usuarioId) {
  const atuais = fonte.listar();
  gravarBase(db, atuais, usuarioId);
  return atuais.length;
}

/** Resumo da linha de base atual. */
const base = (db) => db.prepare(`SELECT COUNT(*) AS arquivos, MAX(b.aprovado_em) AS aprovada_em, (SELECT u.nome FROM integridade_base x
  LEFT JOIN usuarios u ON u.id = x.aprovado_por ORDER BY x.aprovado_em DESC LIMIT 1) AS aprovada_por FROM integridade_base b`).get();

module.exports = { diferenca, verificar, aprovar, base };
