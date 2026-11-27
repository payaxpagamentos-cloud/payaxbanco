'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

/** Avisa que a grade mudou: o que estiver guardado em memória sobre canais e guia deixa de valer. */
const gradeMudou = () => require('./embed').invalidar();

/**
 * Grade de programação (EPG). A operação cadastra na mão, importa um XMLTV (o formato que as
 * emissoras e os agregadores publicam) ou deixa em branco: sem grade, o canal mostra "Ao vivo".
 */

/** O que está no ar agora em cada canal (um registro por canal). */
function agoraEmTodos(db, canalIds = null) {
  const instante = new Date().toISOString();
  const filtro = canalIds?.length ? `AND canal_id IN (${canalIds.map(() => '?').join(',')})` : '';
  const linhas = db.prepare(`SELECT * FROM programas WHERE inicio <= ? AND fim > ? ${filtro} ORDER BY canal_id, inicio`)
    .all(instante, instante, ...(canalIds ?? []));
  return new Map(linhas.map((p) => [p.canal_id, p]));
}

const noAr = (db, canalId) => {
  const instante = new Date().toISOString();
  return db.prepare('SELECT * FROM programas WHERE canal_id = ? AND inicio <= ? AND fim > ? ORDER BY inicio LIMIT 1').get(Number(canalId), instante, instante) ?? null;
};

const aSeguir = (db, canalId, limite = 4) => db.prepare('SELECT * FROM programas WHERE canal_id = ? AND inicio > ? ORDER BY inicio LIMIT ?')
  .all(Number(canalId), new Date().toISOString(), limite);

/** Grade de um período (para a tela "Guia de canais"). */
/**
 * A grade do guia: colunas CONTADAS, não `p.*`.
 *
 * Medido com a grade real (116 canais, 38 horas, 2.784 programas): com `p.*` a resposta do guia
 * saía com 3,1 MB, e 2,5 MB disso era a DESCRIÇÃO de cada programa — texto que a grade não
 * mostra, só a janela que abre quando alguém toca num programa. Três megabytes para desenhar
 * uma tabela de horários, no celular, no 4G do assinante.
 *
 * A descrição agora vem por `programa(db, id)`, quando a janela abre. Uma consulta de uma linha
 * contra três megabytes que quase ninguém lê.
 *
 * `comDescricao` existe para o PAINEL, e é obrigatório lá: a tela de editar programa preenche o
 * formulário com o que esta consulta devolve. Sem a descrição, o campo viria vazio e salvar
 * APAGARIA o texto que estava lá — sem ninguém perceber até alguém reclamar da grade vazia.
 */
const grade = (db, { canalId = null, de, ate, comDescricao = false }) => db.prepare(`SELECT p.id, p.canal_id, p.titulo, p.subtitulo,
    p.inicio, p.fim, p.categoria, p.classificacao, p.ao_vivo, p.temporada, p.episodio,
    ${comDescricao ? 'p.descricao,' : ''}
    c.nome AS canal_nome, c.numero AS canal_numero FROM programas p JOIN canais c ON c.id = p.canal_id
  WHERE p.fim > ? AND p.inicio < ? ${canalId ? 'AND p.canal_id = ?' : ''} AND c.ativo = 1
  ORDER BY c.ordem, c.numero, p.inicio`).all(de, ate, ...(canalId ? [Number(canalId)] : []));

/** Um programa inteiro, com a descrição — para a janela que abre no guia. */
const programa = (db, id) => db.prepare(`SELECT p.*, c.nome AS canal_nome, c.numero AS canal_numero
  FROM programas p JOIN canais c ON c.id = p.canal_id WHERE p.id = ? AND c.ativo = 1`).get(Number(id)) ?? null;

/** Quanto do programa já passou, em %, ou null quando ele não está no ar agora (a barrinha do guia). */
function andamento(p) {
  if (!p) return null;
  const inicio = Date.parse(p.inicio);
  const fim = Date.parse(p.fim);
  const agoraMs = Date.now();
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) return null;
  if (agoraMs < inicio || agoraMs >= fim) return null;
  return Math.min(100, Math.max(0, Math.round(((agoraMs - inicio) / (fim - inicio)) * 100)));
}

/** Grava um programa, recusando sobreposição com outro do mesmo canal. */
function salvarPrograma(db, canalId, d, { id = null } = {}) {
  const inicio = v.instante(d.inicio, 'o início');
  const fim = v.instante(d.fim, 'o fim');
  v.exigir(fim > inicio, 'O fim do programa precisa ser depois do início.');
  v.exigir(Date.parse(fim) - Date.parse(inicio) <= 24 * 3600_000, 'Um programa não pode passar de 24 horas.');
  const conflito = db.prepare(`SELECT id, titulo, inicio FROM programas WHERE canal_id = ? AND id <> ? AND inicio < ? AND fim > ? LIMIT 1`)
    .get(Number(canalId), Number(id) || -1, fim, inicio);
  if (conflito) throw new ErroNegocio(`Choca com "${conflito.titulo}" na grade deste canal.`, 409, { programa_id: conflito.id });
  const campos = [
    v.texto(d.titulo, 'o nome do programa', 200),
    v.opcional(d.subtitulo, 'o subtítulo', 200),
    v.opcional(d.descricao, 'a descrição', 2000),
    inicio,
    fim,
    v.opcional(d.categoria, 'a categoria', 60),
    v.classificacao(d.classificacao),
    v.booleano(d.ao_vivo) ? 1 : 0,
    v.inteiroOpcional(d.temporada, 'a temporada', { min: 1, max: 100 }),
    v.inteiroOpcional(d.episodio, 'o episódio', { min: 1, max: 10_000 }),
  ];
  // Mexeu na grade pelo painel: as telas de canais e o guia guardam o resultado por alguns
  // segundos, e sem este aviso a operação salvaria o programa e não o veria aparecer.
  gradeMudou();
  if (id) {
    db.prepare(`UPDATE programas SET titulo = ?, subtitulo = ?, descricao = ?, inicio = ?, fim = ?, categoria = ?, classificacao = ?, ao_vivo = ?,
      temporada = ?, episodio = ? WHERE id = ? AND canal_id = ?`).run(...campos, Number(id), Number(canalId));
    return db.prepare('SELECT * FROM programas WHERE id = ?').get(Number(id));
  }
  const r = db.prepare(`INSERT INTO programas (titulo, subtitulo, descricao, inicio, fim, categoria, classificacao, ao_vivo, temporada, episodio, canal_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...campos, Number(canalId), agora());
  return db.prepare('SELECT * FROM programas WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** Limpa a grade antiga (o guia só precisa de alguns dias para trás). */
const limparAntigos = (db, dias = 7) => db.prepare('DELETE FROM programas WHERE fim < ?')
  .run(new Date(Date.now() - dias * 86_400_000).toISOString()).changes;

/** Data do XMLTV: "20260317203000 -0300" (o fuso é opcional). */
function dataXmltv(valor) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(String(valor ?? '').trim());
  if (!m) return null;
  const [, a, mes, d, h, min, s, fuso] = m;
  const deslocamento = fuso ? `${fuso.slice(0, 3)}:${fuso.slice(3)}` : 'Z';
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:${s ?? '00'}${deslocamento}`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const semTags = (t) => String(t ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

const dentro = (bloco, tag) => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(bloco);
  return m ? semTags(m[1]) : null;
};

/** Classificação indicativa a partir do texto do XMLTV ("16", "16 anos", "L", "Livre"). */
function classificacaoXmltv(bloco) {
  const r = dentro(bloco, 'rating');
  if (!r) return 0;
  if (/livre|^l$/i.test(r)) return 0;
  const n = Number((/\b(10|12|14|16|18)\b/.exec(r) ?? [])[1]);
  return [10, 12, 14, 16, 18].includes(n) ? n : 0;
}

/**
 * Importa um XMLTV. Os canais são casados pelo atributo `channel` do programa: a operação
 * informa de qual canal é a grade (um arquivo por canal) ou deixa o mapa `porIdExterno`
 * ligando o id do XMLTV ao canal cadastrado.
 */
function importarXmltv(db, xml, { canalId = null, porIdExterno = {}, substituir = true } = {}) {
  const texto = String(xml ?? '');
  v.exigir(/<tv\b/i.test(texto) && /<programme\b/i.test(texto), 'Arquivo XMLTV inválido (não encontrei <tv> com <programme>).');
  const blocos = texto.match(/<programme\b[\s\S]*?<\/programme>/gi) ?? [];
  v.exigir(blocos.length, 'O arquivo não tem programas.');
  const resultado = { importados: 0, ignorados: 0, removidos: 0, canais: new Set(), avisos: [] };

  transacao(db, () => {
    const cadastrados = db.prepare('SELECT id, numero, slug, nome, id_epg FROM canais').all();
    const porNumero = new Map(cadastrados.map((c) => [String(c.numero), c]));
    const porSlug = new Map(cadastrados.map((c) => [c.slug, c]));
    // Cada canal pode guardar o identificador que o provedor de grade usa para ele.
    const porEpg = new Map(cadastrados.filter((c) => c.id_epg).map((c) => [c.id_epg, c]));
    const alvos = new Map();

    const programas = [];
    for (const bloco of blocos) {
      const atributos = /<programme\b([^>]*)>/i.exec(bloco)?.[1] ?? '';
      const attr = (nome) => (new RegExp(`${nome}="([^"]*)"`, 'i').exec(atributos) ?? [])[1];
      const inicio = dataXmltv(attr('start'));
      const fim = dataXmltv(attr('stop'));
      const canalExterno = attr('channel');
      const titulo = dentro(bloco, 'title');
      if (!inicio || !fim || fim <= inicio || !titulo) { resultado.ignorados += 1; continue; }
      const canal = canalId ? { id: Number(canalId) }
        : porIdExterno[canalExterno] ? { id: Number(porIdExterno[canalExterno]) }
          : porEpg.get(canalExterno)
          ?? porSlug.get(String(canalExterno ?? '').toLowerCase()) ?? porNumero.get(String(canalExterno));
      if (!canal) {
        resultado.ignorados += 1;
        if (canalExterno && !resultado.avisos.includes(canalExterno)) resultado.avisos.push(canalExterno);
        continue;
      }
      const epNum = /<episode-num[^>]*>([\s\S]*?)<\/episode-num>/i.exec(bloco)?.[1];
      const xmltvNs = epNum && /\./.test(epNum) ? epNum.split('.').map((x) => Number(String(x).split('/')[0].trim())) : null;
      programas.push({
        canal_id: canal.id,
        titulo,
        subtitulo: dentro(bloco, 'sub-title'),
        descricao: dentro(bloco, 'desc'),
        inicio,
        fim,
        categoria: dentro(bloco, 'category'),
        classificacao: classificacaoXmltv(bloco),
        ao_vivo: /<live\b|\blive\b/i.test(dentro(bloco, 'category') ?? '') ? 1 : 0,
        temporada: xmltvNs && Number.isFinite(xmltvNs[0]) ? xmltvNs[0] + 1 : null,
        episodio: xmltvNs && Number.isFinite(xmltvNs[1]) ? xmltvNs[1] + 1 : null,
      });
      alvos.set(canal.id, true);
      resultado.canais.add(canal.id);
    }
    v.exigir(programas.length, 'Nenhum programa do arquivo pôde ser ligado a um canal cadastrado.');

    if (substituir) {
      // Troca a grade do período que o arquivo cobre, canal por canal.
      for (const cid of alvos.keys()) {
        const doCanal = programas.filter((p) => p.canal_id === cid);
        const de = doCanal.reduce((min, p) => (p.inicio < min ? p.inicio : min), doCanal[0].inicio);
        const ate = doCanal.reduce((max, p) => (p.fim > max ? p.fim : max), doCanal[0].fim);
        // Apaga tudo que ENCOSTA na janela do arquivo, não só o que começa dentro dela. Um
        // programa que começou antes do início e termina depois continuava no banco, sobreposto
        // à grade nova — e `noAr` podia escolher justamente ele, mostrando ao assinante um
        // programa que já acabou.
        resultado.removidos += db.prepare('DELETE FROM programas WHERE canal_id = ? AND fim > ? AND inicio < ?').run(cid, de, ate).changes;
      }
    }
    const inserir = db.prepare(`INSERT OR REPLACE INTO programas (canal_id, titulo, subtitulo, descricao, inicio, fim, categoria, classificacao, ao_vivo, temporada, episodio, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of programas) {
      inserir.run(p.canal_id, p.titulo.slice(0, 200), p.subtitulo?.slice(0, 200) ?? null, p.descricao?.slice(0, 2000) ?? null, p.inicio, p.fim,
        p.categoria?.slice(0, 60) ?? null, p.classificacao, p.ao_vivo, p.temporada, p.episodio, agora());
      resultado.importados += 1;
    }
  });
  gradeMudou();
  return { ...resultado, canais: resultado.canais.size };
}

const GRADE_MAX_BYTES = 96 * 1024 * 1024;          // como chega (comprimida ou não)
const GRADE_ABERTA_MAX_BYTES = 384 * 1024 * 1024;  // depois de descompactada

/**
 * Busca um XMLTV num endereço e importa. Serve para a grade dos canais abertos: a operação
 * cadastra o endereço do provedor que ela escolheu e a plataforma atualiza sozinha, uma vez por dia.
 * Aceita arquivo .xml e .xml.gz (o formato que a maioria dos provedores publica).
 */
async function importarDeUrl(db, url, { substituir = true, timeoutMs = 60_000, maxBytes = GRADE_MAX_BYTES, maxAbertoBytes = GRADE_ABERTA_MAX_BYTES } = {}) {
  const { buscarSeguro, lerCorpoLimitado } = require('./relay');
  let resp;
  try {
    resp = await buscarSeguro(url, { headers: { 'User-Agent': 'PLAYTECHVIP/1.0', Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio(`Não foi possível buscar a grade (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
  }
  if (!resp.ok) throw new ErroNegocio(`O provedor da grade respondeu ${resp.status}.`, 502);
  // Dois tetos, porque são dois jeitos de derrubar o servidor com um arquivo de grade: mandar
  // muito, ou mandar pouco que vira muito. Um .gz de 1 MB pode abrir em vários GB ("bomba de
  // compressão") — e isto roda sozinho todo dia, no mesmo processo que mantém os canais no ar.
  // A grade de uma operadora inteira fica em dezenas de MB; os tetos passam bem longe disso.
  const bruto = await lerCorpoLimitado(resp, maxBytes, 'O arquivo da grade');
  const comprimido = bruto[0] === 0x1f && bruto[1] === 0x8b;
  let aberto = bruto;
  if (comprimido) {
    try {
      aberto = require('node:zlib').gunzipSync(bruto, { maxOutputLength: maxAbertoBytes });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new ErroNegocio('O arquivo da grade passa do tamanho permitido depois de descompactado.', 413);
      throw new ErroNegocio('O arquivo da grade está corrompido (não deu para descompactar).', 502);
    }
  }
  const xml = aberto.toString('utf8');
  const saida = importarXmltv(db, xml, { substituir });
  const { gravarConfig } = require('../db');
  gravarConfig(db, { epg_importado_em: agora() });
  return { ...saida, url, comprimido, tamanho: bruto.length };
}

/** Atualização diária da grade (roda sozinha quando há endereço cadastrado). */
async function atualizarGradeAutomatica(db) {
  const { lerConfig } = require('../db');
  const { epg_url: url } = lerConfig(db);
  if (!url) return null;
  return importarDeUrl(db, url);
}

module.exports = { agoraEmTodos, noAr, aSeguir, grade, andamento, salvarPrograma, limparAntigos, dataXmltv, importarXmltv,
  importarDeUrl, atualizarGradeAutomatica, programa, gradeMudou };
