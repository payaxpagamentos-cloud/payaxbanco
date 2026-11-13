'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

/**
 * O aprendizado da ZOE.
 *
 * Cada vez que ela passa um cliente para a equipe, fica registrada uma LACUNA: o tema, o motivo de
 * ela não ter resolvido e, quando é ela quem decide, o que faltou para resolver sozinha. Quem
 * atendeu conta como resolveu. Juntando as lacunas do mesmo tema, a equipe vê o que mais escapa
 * da ZOE e, com um clique, transforma o que a pessoa fez num artigo da base de conhecimento.
 * Do próximo caso igual em diante, ela resolve.
 *
 * O aprendizado passa por uma pessoa de propósito: a ZOE não ensina a si mesma. Um atendente que
 * resolveu "dando um desconto por fora" não pode virar regra sem alguém aprovar.
 */

const CATEGORIAS = {
  nao_sabia: { nome: 'Não sabia a resposta', aprende: true,
    acao: 'Ensine: o que a pessoa respondeu vira um artigo da base de conhecimento.' },
  cliente_pediu: { nome: 'O cliente quis uma pessoa', aprende: true,
    acao: 'Veja o assunto: se for algo simples, ensinando a resposta ela resolve antes de o cliente pedir.' },
  precisa_de_pessoa: { nome: 'Precisa de uma pessoa', aprende: false,
    acao: 'Negociação, exceção, cancelamento e Procon ficam com a equipe. Se algum caso pudesse ser resolvido por regra, crie uma intenção.' },
  regra_da_empresa: { nome: 'A empresa mandou transferir', aprende: false,
    acao: 'Uma intenção cadastrada manda este assunto para a equipe. Se a ZOE já sabe resolver, mude a intenção para responder.' },
  nao_entendeu: { nome: 'Não entendeu o cliente', aprende: true,
    acao: 'Áudio ruim ou palavras que ela não conhece: inclua as palavras do cliente nas perguntas de exemplo do artigo.' },
  sistema_falhou: { nome: 'Sistema fora do ar', aprende: false,
    acao: 'Problema técnico (IXC, IA ou servidor), não falta de conhecimento. Veja o Diagnóstico.' },
  limite: { nome: 'Passou do limite de mensagens', aprende: true,
    acao: 'A conversa se arrastou sem solução: um artigo mais direto costuma resolver.' },
  outro: { nome: 'Outro motivo', aprende: true, acao: 'Leia os casos e decida.' },
};

// Palavras que não ajudam a reconhecer o tema ("a", "minha", "quero"...).
const VAZIAS = new Set(('a o as os um uma uns umas de do da dos das em no na nos nas por para pra pelo pela com sem sobre e ou que '
  + 'se ao aos meu minha meus minhas seu sua quero queria preciso gostaria saber como qual quais quando onde porque por favor oi ola '
  + 'bom dia boa tarde noite cliente').split(' '));

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Pontos para escolher o nome mais bem escrito de um tema: acento e maiúscula no começo. */
const bemEscrito = (t) => (/[\u00C0-\u017F]/.test(t) ? 2 : 0) + (/^\p{Lu}/u.test(t) ? 1 : 0);

/** A chave que junta temas escritos de jeitos diferentes. */
function chaveDoTema(tema) {
  const palavras = normalizar(tema).split(' ').filter((p) => p && !VAZIAS.has(p));
  return (palavras.slice(0, 5).join(' ') || normalizar(tema) || 'sem tema').slice(0, 80);
}

/** A primeira coisa de verdade que o cliente pediu (não "oi", não o CPF, não "atendente"). */
function oQuePediu(db, conversaId) {
  const regras = require('../ia/regras');
  for (const m of db.prepare(`SELECT texto, transcricao, transcricao_status FROM mensagens
    WHERE conversa_id = ? AND direcao = 'entrada' ORDER BY id`).all(conversaId)) {
    const t = String(m.texto || (m.transcricao_status === 'pronta' ? m.transcricao : '') || '').trim();
    if (!t || /^\d{1,14}$/.test(t) || regras.ehCumprimento(t)) continue;
    if (regras.pedidoDeHumano(t) && !regras.temAssuntoAlemDoPedido(t)) continue;
    return t.slice(0, 400);
  }
  return null;
}

/**
 * Registra a lacuna de uma transferência feita pela ZOE (ou pelas regras dela). Chamado por
 * conversas.transferir, no mesmo lugar para todos os caminhos.
 */
function registrar(db, conversa, { categoria = 'outro', tema = null, oQueFaltou = null, motivo = null } = {}) {
  const pergunta = oQuePediu(db, conversa.id);
  const c = db.prepare('SELECT intencao, assunto, canal FROM conversas WHERE id = ?').get(conversa.id) ?? conversa;
  const assunto = c.assunto && !/^liga[cç][aã]o$/i.test(c.assunto) ? c.assunto : null;
  const temaFinal = String(tema || c.intencao || pergunta || assunto || 'Sem assunto identificado').trim().slice(0, 120);
  return Number(db.prepare(`INSERT INTO lacunas (empresa_id, conversa_id, canal, tema, tema_chave, categoria, pergunta, motivo, o_que_faltou, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conversa.empresa_id, conversa.id, c.canal ?? 'whatsapp', temaFinal, chaveDoTema(temaFinal),
    CATEGORIAS[categoria] ? categoria : 'outro', pergunta, motivo ? String(motivo).slice(0, 300) : null,
    oQueFaltou ? String(oQueFaltou).slice(0, 600) : null, agora()).lastInsertRowid);
}

/** A lacuna mais recente de uma conversa (para o painel pedir "como você resolveu?"). */
const daConversa = (db, conversaId) => {
  const l = db.prepare('SELECT * FROM lacunas WHERE conversa_id = ? ORDER BY id DESC LIMIT 1').get(conversaId);
  return l ? { ...l, categoria_nome: CATEGORIAS[l.categoria]?.nome ?? l.categoria, aprende: CATEGORIAS[l.categoria]?.aprende ?? true } : null;
};

/** Quem atendeu conta como resolveu. É a matéria-prima do artigo. */
function comoResolveu(db, empresaId, conversaId, usuario, texto) {
  const l = db.prepare('SELECT id FROM lacunas WHERE conversa_id = ? AND empresa_id = ? ORDER BY id DESC LIMIT 1').get(conversaId, empresaId);
  if (!l) throw new ErroNegocio('Esta conversa não foi transferida pela ZOE: não há o que ela aprender aqui.');
  db.prepare('UPDATE lacunas SET solucao = ?, solucao_por = ?, solucao_em = ? WHERE id = ?')
    .run(v.texto(texto, 'como foi resolvido', 2000), usuario.id, agora(), l.id);
  return daConversa(db, conversaId);
}

/**
 * O painel do aprendizado: a taxa de resolução da ZOE (e se está subindo) e os temas que mais
 * escapam dela, do maior para o menor, com as perguntas dos clientes e as soluções da equipe.
 */
function painel(db, empresaId, { dias = 30 } = {}) {
  const agoraMs = Date.now();
  const desde = new Date(agoraMs - dias * 86_400_000).toISOString();
  const antes = new Date(agoraMs - 2 * dias * 86_400_000).toISOString();

  // Resolvida pela ZOE: encerrada sem nunca ter ido para a equipe (abandono não conta para nenhum lado).
  const taxa = (de, ate) => {
    const r = db.prepare(`SELECT
        SUM(CASE WHEN transferida_em IS NULL AND resolvida_por IN ('ia','cliente') THEN 1 ELSE 0 END) AS zoe,
        SUM(CASE WHEN transferida_em IS NOT NULL THEN 1 ELSE 0 END) AS equipe
      FROM conversas WHERE empresa_id = ? AND estado = 'encerrada' AND encerrada_em >= ? AND encerrada_em < ?`).get(empresaId, de, ate);
    const zoe = Number(r.zoe ?? 0);
    const equipe = Number(r.equipe ?? 0);
    return { zoe, equipe, taxa: zoe + equipe ? Number(((zoe / (zoe + equipe)) * 100).toFixed(1)) : null };
  };
  const atual = taxa(desde, new Date(agoraMs + 60_000).toISOString());
  const anterior = taxa(antes, desde);

  const lacunas = db.prepare(`SELECT l.*, u.nome AS solucao_por_nome FROM lacunas l LEFT JOIN usuarios u ON u.id = l.solucao_por
    WHERE l.empresa_id = ? AND l.criada_em >= ? ORDER BY l.id DESC`).all(empresaId, desde);

  const grupos = new Map();
  for (const l of lacunas) {
    let g = grupos.get(l.tema_chave);
    if (!g) {
      g = { tema_chave: l.tema_chave, tema: l.tema, variantes: {}, casos: 0, abertas: 0, ensinadas: 0, ignoradas: 0, categorias: {},
        perguntas: [], solucoes: [], faltou: [], ultima_em: l.criada_em, conhecimento_id: null };
      grupos.set(l.tema_chave, g);
    }
    g.casos++;
    g.variantes[l.tema] = (g.variantes[l.tema] ?? 0) + 1;
    if (l.status === 'aberta') g.abertas++;
    if (l.status === 'ensinada') { g.ensinadas++; g.conhecimento_id ??= l.conhecimento_id; }
    if (l.status === 'ignorada') g.ignoradas++;
    g.categorias[l.categoria] = (g.categorias[l.categoria] ?? 0) + 1;
    if (l.pergunta && g.perguntas.length < 6 && !g.perguntas.includes(l.pergunta)) g.perguntas.push(l.pergunta);
    if (l.solucao && g.solucoes.length < 5) g.solucoes.push({ texto: l.solucao, por: l.solucao_por_nome, em: l.solucao_em, conversa_id: l.conversa_id });
    if (l.o_que_faltou && g.faltou.length < 4 && !g.faltou.includes(l.o_que_faltou)) g.faltou.push(l.o_que_faltou);
  }
  const temas = [...grupos.values()].map(({ variantes, ...g }) => {
    const principal = Object.entries(g.categorias).sort((a, b) => b[1] - a[1])[0][0];
    return {
      ...g,
      // O nome do tema: o jeito mais escrito, e entre empates o que tem acento ("Mudança", não "mudanca").
      tema: Object.entries(variantes).sort((a, b) => b[1] - a[1] || bemEscrito(b[0]) - bemEscrito(a[0]))[0][0],
      categoria: principal,
      categoria_nome: CATEGORIAS[principal].nome,
      aprende: CATEGORIAS[principal].aprende,
      acao: CATEGORIAS[principal].acao,
      situacao: g.abertas ? 'aberta' : g.ensinadas ? 'ensinada' : 'ignorada',
    };
  // O que mais vale ensinar primeiro: aberto, que ela pode aprender, e que mais se repete.
  }).sort((a, b) => (b.abertas > 0) - (a.abertas > 0) || (b.aprende - a.aprende) || b.casos - a.casos);

  const porCategoria = Object.entries(CATEGORIAS).map(([k, c]) => ({
    categoria: k, nome: c.nome, casos: lacunas.filter((l) => l.categoria === k).length,
  })).filter((c) => c.casos);

  return {
    dias,
    resolucao: { ...atual, anterior: anterior.taxa },
    transferencias: lacunas.length,
    // Para ensinar: só o que a ZOE pode aprender. Cancelamento e desconto ficam com a equipe por regra.
    abertas: lacunas.filter((l) => l.status === 'aberta' && CATEGORIAS[l.categoria].aprende).length,
    ensinadas: lacunas.filter((l) => l.status === 'ensinada').length,
    sem_solucao_registrada: lacunas.filter((l) => l.status === 'aberta' && !l.solucao && CATEGORIAS[l.categoria].aprende).length,
    por_categoria: porCategoria,
    temas,
  };
}

/**
 * Ensina a ZOE: cria (ou completa) o artigo da base de conhecimento e marca as lacunas do tema como
 * ensinadas. As perguntas reais dos clientes entram como perguntas de exemplo — é por elas que a
 * busca acha o artigo da próxima vez.
 */
function ensinar(db, empresaId, { tema_chave, titulo, resposta, perguntas = null, conhecimento_id = null }, usuario) {
  const chave = v.texto(tema_chave, 'o tema', 80);
  const conhecimento = require('../ia/conhecimento');
  return transacao(db, () => {
    const existe = conhecimento_id
      ? db.prepare('SELECT * FROM conhecimento WHERE id = ? AND empresa_id = ?').get(Number(conhecimento_id), empresaId) : null;
    if (conhecimento_id && !existe) throw new ErroNegocio('Artigo não encontrado.', 404);
    const id = conhecimento.salvar(db, empresaId, {
      id: existe?.id ?? null,
      titulo: v.texto(titulo, 'o título', 160),
      resposta: v.texto(resposta, 'a resposta', 4000),
      perguntas: [existe?.perguntas, v.opcional(perguntas, 'as perguntas de exemplo', 2000)].filter(Boolean).join('\n').slice(0, 2000) || null,
      ativo: true,
    });
    const r = db.prepare("UPDATE lacunas SET status = 'ensinada', conhecimento_id = ? WHERE empresa_id = ? AND tema_chave = ? AND status = 'aberta'")
      .run(id, empresaId, chave);
    return { conhecimento_id: id, lacunas: Number(r.changes), por: usuario?.nome ?? null };
  });
}

/** Não é coisa para a ZOE resolver (ou já foi tratado de outro jeito): sai da lista. */
function ignorar(db, empresaId, temaChave) {
  const r = db.prepare("UPDATE lacunas SET status = 'ignorada' WHERE empresa_id = ? AND tema_chave = ? AND status = 'aberta'")
    .run(empresaId, v.texto(temaChave, 'o tema', 80));
  return { lacunas: Number(r.changes) };
}

module.exports = { CATEGORIAS, registrar, daConversa, comoResolveu, painel, ensinar, ignorar, chaveDoTema, oQuePediu };
