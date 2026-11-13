'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const conversas = require('./conversas');
const envio = require('./envio');
const midia = require('./midia');
const transcricao = require('./transcricao');
const filas = require('./filas');
const v = require('./validacao');

/**
 * A ZOE ao telefone — o mesmo cérebro do WhatsApp.
 *
 * Antes existiam duas ZOEs: a do WhatsApp (que entende texto livre, consulta o IXC com
 * ferramentas, abre Ouvidoria, conhece os alertas de rede) e a do telefone (uma máquina de teclas:
 * 1 fatura, 2 desbloqueio, 3 suporte). Cada regra nova tinha de ser escrita duas vezes, e um dia
 * o telefone ia liberar o que o WhatsApp bloqueia.
 *
 * Agora a ligação é só mais uma conversa, com canal "telefone". Cada fala do cliente entra como
 * mensagem, passa pelas MESMAS regras, pelo MESMO portão de identidade e pelas MESMAS ferramentas,
 * e o que a ZOE responderia por escrito volta como texto para a central falar. A diferença entre
 * os canais mora em um lugar só: na hora de entregar a resposta (envio.enfileirar marca "falada").
 *
 * A central telefônica conversa com isto por três chamadas:
 *   iniciar  → a ligação chegou: devolve a saudação;
 *   turno    → o cliente falou (texto, teclas ou o áudio, que é transcrito aqui com o mesmo
 *              whisper do WhatsApp): devolve o que falar e o que fazer em seguida;
 *   encerrar → desligou.
 */

const MAX_AUDIO_BYTES = 1_500_000;
// Depois de tantas falas seguidas que não deu para entender, passa para uma pessoa em vez de
// ficar repetindo "pode repetir?" — ninguém aguenta a terceira vez.
const MAX_NAO_ENTENDI = 3;

/** Telefone da Bina no formato dos contatos (com 55). Sem Bina, a ligação ainda é atendida. */
function telefoneDaBina(bruto, uid) {
  let d = String(bruto ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length >= 11) d = d.slice(1);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 13 ? d : `anon${String(uid).replace(/\W/g, '').slice(-20)}`;
}

/**
 * O texto que vai virar voz. Tira o que não se fala (formatação, emoji, link) e transforma um
 * menu de botões em opções faladas — no telefone não há botão para apertar.
 */
function paraFala(m) {
  let t = String(m.texto ?? '');
  if (m.tipo === 'botao' && m.payload) {
    try {
      const p = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload;
      const acao = p.interactive?.action ?? {};
      const opcoes = [
        ...(acao.buttons ?? []).map((b) => b.reply?.title),
        ...(acao.sections ?? []).flatMap((s) => (s.rows ?? []).map((r) => r.title)),
      ].filter(Boolean);
      if (opcoes.length) t = `${t} Você pode dizer: ${opcoes.length > 1 ? `${opcoes.slice(0, -1).join(', ')} ou ${opcoes.at(-1)}` : opcoes[0]}.`;
    } catch { /* fala só o texto */ }
  }
  return t
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

const porUid = (db, empresaId, uid) =>
  db.prepare("SELECT * FROM conversas WHERE empresa_id = ? AND ligacao_uid = ? AND canal = 'telefone'").get(empresaId, String(uid));

/** As respostas faladas criadas depois de `marca`, já prontas para virar voz. */
function falasDesde(db, conversaId, marca) {
  return db.prepare(`SELECT tipo, texto, payload FROM mensagens
    WHERE conversa_id = ? AND id > ? AND direcao = 'saida' AND status = 'falada' ORDER BY id`).all(conversaId, marca)
    .map(paraFala).filter(Boolean).join(' ');
}

const ultimaId = (db, conversaId) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM mensagens WHERE conversa_id = ?').get(conversaId).n);

/** O que a central deve fazer agora, pelo estado da conversa. */
function proximoPasso(db, c, fala) {
  if (c.estado === 'encerrada') return { acao: 'encerrar', fala };
  if (c.estado === 'aguardando' || c.estado === 'humano') {
    const fila = c.fila_id ? filas.buscar(db, c.empresa_id, c.fila_id) : null;
    return {
      acao: 'transferir',
      fala,
      // A central usa o nome para escolher a fila de ramais. Mesmo nome dos dois lados.
      fila: fila ? { id: fila.id, nome: fila.nome } : null,
      // O que o atendente que pegar a ligação precisa saber, para não perguntar tudo de novo.
      resumo: [c.resumo, c.motivo_transferencia].filter(Boolean).join(' — ') || null,
      conversa_id: c.id,
    };
  }
  return { acao: 'ouvir', fala };
}

/** A ligação chegou. Abre a conversa (ou devolve a mesma, se a central repetir o pedido). */
function iniciar(db, empresa, { uid, telefone = null } = {}) {
  const id = v.texto(uid, 'o identificador da ligação', 120);
  const ja = porUid(db, empresa.id, id);
  if (ja) return { conversa_id: ja.id, repetida: true, ...proximoPasso(db, ja, null) };

  const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? ORDER BY ativo DESC, id LIMIT 1').get(empresa.id);
  if (!numero) throw new ErroNegocio('A empresa ainda não tem número cadastrado.', 409);
  const tel = telefoneDaBina(telefone, id);

  const { conversa, contato } = transacao(db, () => {
    const ct = conversas.garantirContato(db, empresa.id, tel, null);
    const c = conversas.abrir(db, { empresa, numero, contato: ct, canal: 'telefone' });
    db.prepare("UPDATE conversas SET ligacao_uid = ?, assunto = COALESCE(assunto, 'Ligação') WHERE id = ?").run(id, c.id);
    envio.registrarSistema(db, { ...c, canal: 'telefone' }, `Ligação recebida${tel.startsWith('anon') ? ' de número oculto' : ` de ${tel}`}.`);
    return { conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), contato: ct };
  });

  // A ZOE atende falando. A saudação é a mesma do WhatsApp, escrita pela empresa.
  const cfg = conversas.cfgIa(db, empresa.id);
  const prompt = require('../ia/prompt');
  const regras = require('../ia/regras');
  const saudacao = prompt.saudacaoDe(cfg, { empresa, contato, nomeCliente: contato.nome ?? contato.nome_perfil })
    || regras.saudacao(cfg, { nomeAssistente: cfg.nome_assistente, nomeEmpresa: empresa.nome, nomeCliente: contato.nome ?? contato.nome_perfil });
  const marca = ultimaId(db, conversa.id);
  envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto: saudacao });
  return { conversa_id: conversa.id, ...proximoPasso(db, conversa, falasDesde(db, conversa.id, marca)) };
}

/**
 * O cliente falou. `texto` (já transcrito pela central), `digitos` (teclado) ou `audio_base64`
 * (transcrito aqui, pelo mesmo whisper dos áudios do WhatsApp).
 */
async function turno(db, empresa, uid, { texto = null, digitos = null, audio_base64: audio = null, turno_id: turnoId = null } = {}) {
  const c = porUid(db, empresa.id, uid);
  if (!c) throw naoEncontrado('Ligação');
  if (c.estado !== 'bot') return proximoPasso(db, c, null);

  let dito = texto ? String(texto).trim().slice(0, 2000) : digitos ? String(digitos).replace(/[^\d*#]/g, '').slice(0, 30) : null;
  let entrada = { tipo: 'texto', texto: dito };
  let ouvido = null;

  if (!dito && audio) {
    const buffer = Buffer.from(String(audio), 'base64');
    v.exigir(buffer.length > 0 && buffer.length <= MAX_AUDIO_BYTES, 'Áudio vazio ou grande demais.');
    const arquivo = midia.guardar(buffer, 'audio/wav');
    ouvido = await transcricao.transcrever(midia.caminho(arquivo));
    entrada = { tipo: 'audio', texto: null, midiaArquivo: arquivo, midiaMime: 'audio/wav', midiaBytes: buffer.length };
    dito = ouvido.status === 'pronta' ? ouvido.texto : null;
  }

  const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(c.contato_id);
  const numero = db.prepare('SELECT * FROM numeros WHERE id = ?').get(c.numero_id);
  const empresaRow = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id);

  const mensagemId = conversas.registrarEntrada(db, c, {
    ...entrada, waId: turnoId ? `voz:${c.id}:${String(turnoId).slice(0, 40)}` : null,
  });
  // Mesmo turno repetido pela central (rede instável): não responde duas vezes.
  if (!mensagemId) return proximoPasso(db, c, null);
  if (ouvido) {
    db.prepare('UPDATE mensagens SET transcricao = ?, transcricao_status = ?, transcricao_ms = ? WHERE id = ?')
      .run(ouvido.texto, ouvido.status, ouvido.ms ?? 0, mensagemId);
  }
  db.prepare('UPDATE conversas SET ultima_mensagem_cliente_em = ?, ultima_mensagem_em = ? WHERE id = ?').run(agora(), agora(), c.id);
  db.prepare('UPDATE contatos SET ultimo_contato_em = ? WHERE id = ?').run(agora(), contato.id);

  // Não deu para entender o que foi dito: pede para repetir, e na terceira vez chama uma pessoa.
  if (!dito) {
    const seguidas = naoEntendidasSeguidas(db, c.id);
    if (seguidas >= MAX_NAO_ENTENDI) {
      const marca = ultimaId(db, c.id);
      transacao(db, () => conversas.transferir(db, c, { por: 'ia', motivo: 'Não foi possível entender o cliente na ligação.' }));
      return proximoPasso(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), falasDesde(db, c.id, marca));
    }
    return { acao: 'ouvir', fala: 'Desculpe, não consegui entender. Pode repetir, por favor?' };
  }

  const marca = ultimaId(db, c.id);
  try {
    const { atender } = require('../ia/atendente');
    await atender(db, {
      empresa: empresaRow, numero, contato, conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id),
      mensagem: db.prepare('SELECT * FROM mensagens WHERE id = ?').get(mensagemId),
    });
  } catch (err) {
    // O cérebro falhou no meio da ligação: a pessoa não pode ficar no silêncio. Vai para a fila.
    console.error('[ZOE Atende] Falha no turno da ligação:', err);
    const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
    if (atual.estado === 'bot') transacao(db, () => conversas.transferir(db, atual, { por: 'ia', motivo: 'Falha técnica durante a ligação.' }));
  }

  const depois = db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
  const fala = falasDesde(db, c.id, marca);
  return {
    ...proximoPasso(db, depois, fala || (depois.estado === 'bot' ? 'Pode falar, estou ouvindo.' : null)),
    ...(ouvido ? { ouvi: dito } : {}),
  };
}

/** Quantas falas do cliente seguidas, no fim da conversa, não puderam ser entendidas. */
function naoEntendidasSeguidas(db, conversaId) {
  const ultimas = db.prepare(`SELECT tipo, texto, transcricao_status FROM mensagens
    WHERE conversa_id = ? AND direcao = 'entrada' ORDER BY id DESC LIMIT ?`).all(conversaId, MAX_NAO_ENTENDI);
  let n = 0;
  for (const m of ultimas) {
    if (m.texto || m.transcricao_status === 'pronta') break;
    n++;
  }
  return n;
}

/**
 * Desligou. A ligação vira uma conversa encerrada no histórico do cliente, junto com o WhatsApp.
 * Se a ZOE falou por último, conta como resolvida por ela; se a pessoa desligou esperando
 * resposta, é abandono. Transferida para a equipe, quem atendeu foi uma pessoa.
 */
function encerrar(db, empresa, uid) {
  const c = porUid(db, empresa.id, uid);
  if (!c) throw naoEncontrado('Ligação');
  if (c.estado === 'encerrada') return { ok: true, ja_encerrada: true };
  const ultima = db.prepare("SELECT direcao, autor FROM mensagens WHERE conversa_id = ? AND tipo <> 'sistema' ORDER BY id DESC LIMIT 1").get(c.id);
  const resolvidaPor = c.estado !== 'bot' ? 'humano' : ultima?.direcao === 'saida' && ultima.autor === 'ia' ? 'ia' : 'abandono';
  transacao(db, () => conversas.encerrar(db, c, { resolvidaPor, avisar: false, pedirCsat: false }));
  envio.registrarSistema(db, c, 'Ligação encerrada.');
  return { ok: true, resolvida_por: resolvidaPor };
}

module.exports = { iniciar, turno, encerrar, paraFala, telefoneDaBina, MAX_NAO_ENTENDI };
