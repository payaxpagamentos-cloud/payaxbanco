'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, somarDias } = require('./datas');
const { emOferta, precoVigente } = require('./produtos');
const relatorios = require('./relatorios');

/**
 * Vitrine: o que passa na TV da loja e no terminal de autoatendimento quando nenhum cliente está comprando.
 *
 * Junta quatro fontes, intercaladas: ofertas marcadas à mão, os mais vendidos e os mais lucrativos dos
 * últimos 30 dias (escolhidos sozinhos) e os vídeos e imagens que a administração sobe.
 *
 * O resultado é público — a TV não faz login —, então daqui só sai o que já está na prateleira: nome,
 * foto e preço. Custo, lucro e margem nunca entram na resposta, e o "mais lucrativo" aparece para o
 * cliente apenas como "Destaque da casa".
 */
const SELOS = { oferta: 'Oferta', vendido: 'Mais vendido', lucrativo: 'Destaque da casa' };
const DIAS_RANKING = 30;
const VIDEO_SEM_DURACAO_MS = 180_000; // vídeo enviado antes de a duração ser guardada
const IMAGEM_PADRAO_SEG = 12;

/** As três artes aprovadas do Mercado Binho: entram sozinhas na vitrine na primeira vez. */
const ARTES_INICIAIS = [
  ['01-mercado-perto.webp', 'Seu mercado, pertinho de você'],
  ['02-lanches.webp', 'Bateu a fome? Seu lanche está aqui'],
  ['03-essenciais.webp', 'Faltou em casa? Os essenciais estão aqui'],
];
const PASTA_ARTES = path.join(__dirname, '..', 'vitrine-padrao');

/* ---------- arquivos de mídia ---------- */
const FORMATOS = {
  mp4: { tipo: 'video', confere: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  webm: { tipo: 'video', confere: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  jpg: { tipo: 'imagem', confere: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { tipo: 'imagem', confere: (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' },
  webp: { tipo: 'imagem', confere: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

const pasta = () => {
  fs.mkdirSync(config.vitrineDir, { recursive: true });
  return config.vitrineDir;
};

/** O formato sai dos primeiros bytes do arquivo — o tipo informado pelo navegador não prova nada. */
function formatoDe(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return Object.keys(FORMATOS).find((ext) => FORMATOS[ext].confere(buffer)) ?? null;
}

const nomeSeguro = (nome) => typeof nome === 'string' && /^[\w.-]+$/.test(nome);
const caminho = (nome) => (nomeSeguro(nome) ? path.join(config.vitrineDir, nome) : null);

function guardarMidia(db, buffer, { titulo = '', duracao_seg = IMAGEM_PADRAO_SEG, duracao_video_ms = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ErroNegocio('Envie um vídeo ou uma imagem.', 422);
  const ext = formatoDe(buffer);
  if (!ext) throw new ErroNegocio('Formato não aceito. Use vídeo MP4 ou WebM, ou imagem JPEG, PNG ou WebP.', 422);
  const { tipo } = FORMATOS[ext];
  const limite = tipo === 'video' ? config.vitrineVideoMaxBytes : config.vitrineImagemMaxBytes;
  if (buffer.length > limite) {
    throw new ErroNegocio(`${tipo === 'video' ? 'O vídeo' : 'A imagem'} é grande demais (máximo de ${Math.round(limite / 1024 / 1024)} MB).`, 413);
  }
  const arquivo = `${tipo}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(pasta(), arquivo), buffer, { mode: 0o644 });
  const ordem = (db.prepare('SELECT COALESCE(MAX(ordem), 0) AS m FROM vitrine_midias').get().m) + 1;
  const r = db.prepare(`INSERT INTO vitrine_midias (tipo, arquivo, titulo, duracao_seg, duracao_video_ms, tamanho_bytes, ordem, ativa, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(tipo, arquivo, String(titulo ?? '').trim().slice(0, 80), duracao_seg,
    tipo === 'video' ? duracao_video_ms : null, buffer.length, ordem, agora());
  return obterMidia(db, Number(r.lastInsertRowid));
}

/**
 * Na primeira vez que o sistema sobe com a vitrine, cadastra as artes aprovadas. Fica anotado que já
 * foi feito: se a administração apagar alguma depois, ela não volta sozinha.
 */
function semearArtesIniciais(db) {
  const feito = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'vitrine_artes_iniciais'").get();
  if (feito) return 0;
  let n = 0;
  for (const [arquivo, titulo] of ARTES_INICIAIS) {
    const origem = path.join(PASTA_ARTES, arquivo);
    if (!fs.existsSync(origem)) continue;
    guardarMidia(db, fs.readFileSync(origem), { titulo, duracao_seg: IMAGEM_PADRAO_SEG });
    n += 1;
  }
  // Quem já tinha a vitrine ficou com 8 s por produto (o padrão anterior, não uma escolha). O pedido
  // da loja é 12 s, como as artes. Só troca se ainda estiver no padrão antigo.
  db.prepare("UPDATE configuracoes SET valor = '12' WHERE chave = 'vitrine_segundos_produto' AND valor = '8'").run();
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('vitrine_artes_iniciais', '1')").run();
  return n;
}

const obterMidia = (db, id) => db.prepare('SELECT * FROM vitrine_midias WHERE id = ?').get(id);
const listarMidias = (db) => db.prepare('SELECT * FROM vitrine_midias ORDER BY ordem, id').all();

function apagarMidia(db, id) {
  const m = obterMidia(db, id);
  if (!m) throw naoEncontrado('Mídia');
  db.prepare('DELETE FROM vitrine_midias WHERE id = ?').run(id);
  const arquivo = caminho(m.arquivo);
  if (arquivo) fs.rmSync(arquivo, { force: true });
  return m;
}

/** Recebe os ids na ordem em que devem passar. */
function ordenarMidias(db, ids) {
  const atualizar = db.prepare('UPDATE vitrine_midias SET ordem = ? WHERE id = ?');
  ids.forEach((id, i) => atualizar.run(i + 1, id));
  return listarMidias(db);
}

/* ---------- a sequência que passa na tela ---------- */
const PRODUTO = db => db.prepare(`SELECT p.id, p.nome, p.unidade, p.foto, p.ativo, p.preco_centavos, p.oferta_preco_centavos, p.oferta_ate,
    c.nome AS categoria, c.cor AS categoria_cor
  FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.id = ?`);

/** Só o que o cliente pode ver. Qualquer campo novo aqui sai na TV — custo e lucro ficam de fora de propósito. */
function cartaoProduto(p, selo, dia) {
  const oferta = emOferta(p, dia);
  return {
    tipo: 'produto', selo: SELOS[oferta ? 'oferta' : selo], destaque: oferta ? 'oferta' : selo,
    id: p.id, nome: p.nome, categoria: p.categoria ?? null, categoria_cor: p.categoria_cor ?? null, unidade: p.unidade, foto: p.foto,
    preco_centavos: precoVigente(p, dia), preco_cheio_centavos: oferta ? p.preco_centavos : null, oferta_ate: oferta ? p.oferta_ate : null,
  };
}

function montarSequencia(db) {
  const cfg = lerConfig(db);
  const dia = hoje();
  const de = somarDias(dia, -(DIAS_RANKING - 1));
  const buscar = PRODUTO(db);
  const usados = new Set();
  const semFoto = { vendidos: 0, lucrativos: 0 };

  const ofertas = !cfg.vitrine_ofertas ? [] : db.prepare(`SELECT p.id FROM produtos p
      WHERE p.ativo = 1 AND p.oferta_preco_centavos IS NOT NULL AND p.oferta_preco_centavos < p.preco_centavos
        AND (p.oferta_ate IS NULL OR p.oferta_ate >= ?)
      ORDER BY (p.oferta_ate IS NULL), p.oferta_ate, p.nome LIMIT 30`).all(dia)
    .map(({ id }) => buscar.get(id)).map((p) => { usados.add(p.id); return cartaoProduto(p, 'oferta', dia); });

  /**
   * Ranking automático: produto ativo que ainda não entrou. Os com foto têm a vez; se faltar, completa com
   * os sem foto (a tela desenha um cartão na cor da categoria), para a vitrine de um mercado que ainda
   * está cadastrando fotos não ficar vazia. A gestão mostra quantos entraram sem foto.
   */
  const ranking = (lista, selo, contador) => {
    const candidatos = lista.filter((l) => !usados.has(l.id)).map((l) => buscar.get(l.id)).filter((p) => p?.ativo);
    const escolhidos = [...candidatos.filter((p) => p.foto), ...candidatos.filter((p) => !p.foto)].slice(0, cfg.vitrine_qtd_produtos);
    // Mantém a ordem do ranking entre os escolhidos (o primeiro do ranking passa primeiro).
    const posicao = new Map(candidatos.map((p, i) => [p.id, i]));
    escolhidos.sort((a, b) => posicao.get(a.id) - posicao.get(b.id));
    semFoto[contador] = escolhidos.filter((p) => !p.foto).length;
    escolhidos.forEach((p) => usados.add(p.id));
    return escolhidos.map((p) => cartaoProduto(p, selo, dia));
  };
  const vendidos = cfg.vitrine_mais_vendidos ? ranking(relatorios.maisVendidos(db, { de, ate: dia, limite: 200 }), 'vendido', 'vendidos') : [];
  const lucrativos = cfg.vitrine_mais_lucrativos
    ? ranking(relatorios.maisLucrativos(db, { de, ate: dia, limite: 200 }).filter((l) => l.lucro_centavos > 0), 'lucrativo', 'lucrativos')
    : [];
  const midias = !cfg.vitrine_midias ? [] : db.prepare('SELECT * FROM vitrine_midias WHERE ativa = 1 ORDER BY ordem, id').all()
    .filter((m) => fs.existsSync(path.join(config.vitrineDir, m.arquivo)))
    .map((m) => ({
      tipo: m.tipo, id: m.id, arquivo: m.arquivo, titulo: m.titulo,
      duracao_ms: m.tipo === 'imagem' ? m.duracao_seg * 1000 : (m.duracao_video_ms || VIDEO_SEM_DURACAO_MS),
    }));

  // Produtos intercalados entre si (oferta, mais vendido, destaque...) e as artes/vídeos espalhados por
  // igual no meio deles, começando por uma arte — assim nenhum trecho da volta fica só de produto.
  const fontes = [ofertas, vendidos, lucrativos];
  const produtos = [];
  for (let i = 0; fontes.some((f) => i < f.length); i += 1) for (const f of fontes) if (i < f.length) produtos.push(f[i]);
  const slides = [];
  if (!midias.length) slides.push(...produtos);
  else {
    const passo = Math.ceil(produtos.length / midias.length);
    midias.forEach((m, i) => slides.push(m, ...produtos.slice(i * passo, (i + 1) * passo)));
  }
  // Toda tela sabe quanto dura cada quadro: com isso, várias TVs calculam o mesmo quadro pela hora.
  for (const s of slides) if (s.tipo === 'produto') s.duracao_ms = cfg.vitrine_segundos_produto * 1000;
  return { cfg, slides, contagem: { ofertas: ofertas.length, vendidos: vendidos.length, lucrativos: lucrativos.length, midias: midias.length }, semFoto };
}

/** Resposta pública, lida pela TV e pelo tablet. */
function playlist(db) {
  const { cfg, slides } = montarSequencia(db);
  return {
    mercado: { nome: cfg.nome_mercado, condominio: cfg.condominio },
    segundos_produto: cfg.vitrine_segundos_produto,
    sincronizar: cfg.vitrine_sincronizar,
    tablet: { ligada: cfg.vitrine_tablet, ocioso_segundos: cfg.vitrine_tablet_ocioso },
    slides,
    gerada_em: agora(),
  };
}

/** Para a tela de gestão: quantos itens de cada fonte entram agora e quantos ficaram de fora por falta de foto. */
function resumo(db) {
  const { contagem, semFoto } = montarSequencia(db);
  return { contagem, sem_foto: semFoto, dias_ranking: DIAS_RANKING };
}

module.exports = { playlist, resumo, guardarMidia, semearArtesIniciais, apagarMidia, listarMidias, obterMidia, ordenarMidias, formatoDe, caminho, pasta, SELOS };
