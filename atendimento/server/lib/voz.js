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
 * Dois jeitos de o cliente responder, escolhidos em ZOE › Como ela atende:
 *   fala   → o cliente diz o que quer ("minha internet caiu"); o teclado vale para números;
 *   teclas → menu numerado ("digite 1 para segunda via…"). Cada tecla do menu principal vira o
 *            pedido equivalente e passa pelo MESMO cérebro, como se tivesse sido dito. Não é a
 *            URA de teclas antiga: aquela era outra ZOE, com regras próprias.
 * A central não decide nada: cada resposta diz se ela deve ouvir fala ou ler teclas, e quantas.
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

/** O menu principal do modo teclas, quando a empresa não escreveu o dela. */
const MENU_PADRAO = [
  { tecla: '1', rotulo: 'segunda via da fatura', pedido: 'Quero a segunda via da minha fatura.' },
  { tecla: '2', rotulo: 'liberar o acesso', pedido: 'Minha internet foi bloqueada. Quero o desbloqueio de confiança.' },
  { tecla: '3', rotulo: 'problema na internet', pedido: 'Minha internet está com problema.' },
  { tecla: '0', rotulo: 'falar com um atendente', pedido: 'Quero falar com um atendente.' },
];

const modoDa = (cfg) => (cfg?.voz_modo === 'teclas' ? 'teclas' : 'fala');

function menuDa(cfg) {
  try {
    const m = JSON.parse(cfg?.voz_menu ?? 'null');
    if (Array.isArray(m) && m.length) return m;
  } catch { /* usa o padrão */ }
  return MENU_PADRAO;
}

/** "Digite 1 para…, 2 para… ou 0 para…". O zero vai por último, que é onde o ouvido espera. */
function falaDoMenu(menu) {
  const ordem = [...menu].sort((a, b) => (a.tecla === '0') - (b.tecla === '0') || a.tecla.localeCompare(b.tecla));
  const itens = ordem.map((o) => `${o.tecla} para ${o.rotulo}`);
  const lista = itens.length > 1 ? `${itens.slice(0, -1).join(', ')} ou ${itens.at(-1)}` : itens[0];
  return `Digite ${lista}. Para ouvir de novo, digite asterisco.`;
}

/**
 * Quantas teclas esperar, pelo que a ZOE acabou de pedir. Esperar 14 dígitos quando a pessoa só
 * precisa apertar "1" a deixaria esperando o tempo inteiro; esperar 1 quando ela digita o CPF
 * cortaria o número no primeiro dígito.
 */
function quantasTeclas(fala) {
  const t = String(fala ?? '').toLowerCase();
  if (/tr[eê]s primeiros/.test(t)) return 3;
  if (/nascimento/.test(t)) return 8;
  if (/\bcpf\b|\bcnpj\b|protocolo/.test(t)) return 14;
  return 1;
}

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
function paraFala(m, { teclas = false } = {}) {
  let t = String(m.texto ?? '');
  if (m.tipo === 'botao' && m.payload) {
    try {
      const p = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload;
      const acao = p.interactive?.action ?? {};
      const opcoes = [
        ...(acao.buttons ?? []).map((b) => b.reply?.title),
        ...(acao.sections ?? []).flatMap((s) => (s.rows ?? []).map((r) => r.title)),
      ].filter(Boolean);
      const juntar = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ou ${xs.at(-1)}` : xs[0]);
      // Por teclas, a opção vira número na mesma ordem do menu — e as regras já entendem "1" como a primeira.
      if (opcoes.length) t = teclas
        ? `${t} Digite ${juntar(opcoes.map((o, i) => `${i + 1} para ${o}`))}.`
        : `${t} Você pode dizer: ${juntar(opcoes)}.`;
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
function falasDesde(db, conversaId, marca, { teclas = false } = {}) {
  return db.prepare(`SELECT tipo, texto, payload FROM mensagens
    WHERE conversa_id = ? AND id > ? AND direcao = 'saida' AND status = 'falada' ORDER BY id`).all(conversaId, marca)
    .map((m) => paraFala(m, { teclas })).filter(Boolean).join(' ');
}

const ultimaId = (db, conversaId) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM mensagens WHERE conversa_id = ?').get(conversaId).n);

/** O que a central deve fazer agora, pelo estado da conversa. */
function proximoPasso(db, c, fala, { modo = 'fala', noMenu = false } = {}) {
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
      // A frase que a central fala no ouvido do atendente antes de ligar o cliente.
      sussurro: require('./passagem').montar(db, c.id)?.sussurro ?? null,
      conversa_id: c.id,
    };
  }
  // A central obedece: grava a fala, ou lê o número de teclas que faz sentido para o que foi pedido.
  if (modo === 'teclas') return { acao: 'ouvir', fala, aguardar: 'digitos', max_digitos: noMenu ? 1 : quantasTeclas(fala) };
  return { acao: 'ouvir', fala, aguardar: 'fala' };
}

/** A ligação chegou. Abre a conversa (ou devolve a mesma, se a central repetir o pedido). */
function iniciar(db, empresa, { uid, telefone = null } = {}) {
  const id = v.texto(uid, 'o identificador da ligação', 120);
  const cfgVoz = conversas.cfgIa(db, empresa.id);
  const modo = modoDa(cfgVoz);
  const ja = porUid(db, empresa.id, id);
  if (ja) return { conversa_id: ja.id, repetida: true, ...proximoPasso(db, ja, null, { modo, noMenu: Boolean(ja.voz_no_menu) }) };

  const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? ORDER BY ativo DESC, id LIMIT 1').get(empresa.id);
  if (!numero) throw new ErroNegocio('A empresa ainda não tem número cadastrado.', 409);
  const tel = telefoneDaBina(telefone, id);

  const { conversa, contato } = transacao(db, () => {
    const ct = conversas.garantirContato(db, empresa.id, tel, null);
    // Ligação anterior do mesmo número ainda aberta: a central não avisou o fim dela (o "h" do
    // plano de discagem não rodou, ou o servidor caiu). Uma ligação nova não pode ser recusada por
    // isso — a antiga é fechada e fica registrado o porquê.
    const velha = db.prepare("SELECT * FROM conversas WHERE contato_id = ? AND canal = 'telefone' AND estado <> 'encerrada'").get(ct.id);
    if (velha) {
      envio.registrarSistema(db, velha, 'Encerrada porque o cliente ligou de novo: a central não avisou o fim desta ligação.');
      conversas.encerrar(db, velha, {
        resolvidaPor: velha.ligacao_atendida_em || velha.estado === 'humano' ? 'humano' : 'abandono', avisar: false, pedirCsat: false,
      });
    }
    const c = conversas.abrir(db, { empresa, numero, contato: ct, canal: 'telefone' });
    db.prepare("UPDATE conversas SET ligacao_uid = ?, assunto = COALESCE(assunto, 'Ligação') WHERE id = ?").run(id, c.id);
    envio.registrarSistema(db, { ...c, canal: 'telefone' }, `Ligação recebida${tel.startsWith('anon') ? ' de número oculto' : ` de ${tel}`}.`);
    return { conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), contato: ct };
  });

  // A ZOE atende falando. A saudação é a mesma do WhatsApp, escrita pela empresa.
  const cfg = conversas.cfgIa(db, empresa.id);
  const prompt = require('../ia/prompt');
  const regras = require('../ia/regras');
  // Por teclas, a saudação padrão ("me conta o que você precisa") pediria algo que o cliente não
  // tem como fazer. Sem saudação escrita pela empresa, vai uma curta, e o menu vem logo depois.
  const saudacao = modo === 'teclas' && !cfg.saudacao?.trim()
    ? `Olá! Eu sou a ${cfg.nome_assistente || 'ZOE'}, atendente virtual da ${empresa.nome}.`
    : prompt.saudacaoDe(cfg, { empresa, contato, nomeCliente: contato.nome ?? contato.nome_perfil })
      || regras.saudacao(cfg, { nomeAssistente: cfg.nome_assistente, nomeEmpresa: empresa.nome, nomeCliente: contato.nome ?? contato.nome_perfil });
  const marca = ultimaId(db, conversa.id);
  envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto: saudacao });
  // Por teclas, a saudação já vem com o menu principal: o cliente não tem como "dizer o que quer".
  if (modo === 'teclas') {
    envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto: falaDoMenu(menuDa(cfgVoz)) });
    db.prepare('UPDATE conversas SET voz_no_menu = 1 WHERE id = ?').run(conversa.id);
  }
  return { conversa_id: conversa.id, ...proximoPasso(db, conversa, falasDesde(db, conversa.id, marca), { modo, noMenu: modo === 'teclas' }) };
}

/**
 * O cliente falou. `texto` (já transcrito pela central), `digitos` (teclado) ou `audio_base64`
 * (transcrito aqui, pelo mesmo whisper dos áudios do WhatsApp).
 */
async function turno(db, empresa, uid, { texto = null, digitos = null, audio_base64: audio = null, turno_id: turnoId = null } = {}) {
  const c = porUid(db, empresa.id, uid);
  if (!c) throw naoEncontrado('Ligação');
  const cfgVoz = conversas.cfgIa(db, c.empresa_id);
  const modo = modoDa(cfgVoz);
  const teclas = modo === 'teclas';
  const passo = (conv, fala) => proximoPasso(db, conv, fala, { modo, noMenu: Boolean(conv.voz_no_menu) });
  if (c.estado !== 'bot') return passo(c, null);

  let dito = texto ? String(texto).trim().slice(0, 2000) : digitos ? String(digitos).replace(/[^\d*#]/g, '').replace(/#$/, '').slice(0, 30) : null;
  let entrada = { tipo: 'texto', texto: dito };
  let ouvido = null;
  let opcao = null;

  // Por teclas: asterisco repete o menu principal, e a tecla dada no menu vira o pedido dela.
  if (teclas && dito === '*') {
    db.prepare('UPDATE conversas SET voz_no_menu = 1 WHERE id = ?').run(c.id);
    return proximoPasso(db, { ...c, voz_no_menu: 1 }, falaDoMenu(menuDa(cfgVoz)), { modo, noMenu: true });
  }
  if (teclas && c.voz_no_menu && dito) {
    opcao = menuDa(cfgVoz).find((o) => o.tecla === dito.slice(0, 1)) ?? null;
    // Tecla que não existe no menu conta como "não entendi" — na terceira, chama uma pessoa.
    dito = opcao ? opcao.pedido : null;
    entrada = { tipo: 'texto', texto: dito };
  }

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
  if (!mensagemId) return passo(c, null);
  if (opcao) {
    // O atendente que ler a conversa vê qual tecla foi, não só o pedido que ela representa.
    envio.registrarSistema(db, c, `O cliente digitou ${opcao.tecla} (${opcao.rotulo}).`);
    db.prepare('UPDATE conversas SET voz_no_menu = 0 WHERE id = ?').run(c.id);
  }
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
      return passo(db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), falasDesde(db, c.id, marca, { teclas }));
    }
    if (teclas) {
      // Por teclas, o jeito de ajudar é repetir as opções — "pode repetir?" não diz o que digitar.
      db.prepare('UPDATE conversas SET voz_no_menu = 1 WHERE id = ?').run(c.id);
      return proximoPasso(db, { ...c, voz_no_menu: 1 }, `Não recebi uma opção válida. ${falaDoMenu(menuDa(cfgVoz))}`, { modo, noMenu: true });
    }
    return passo(c, 'Desculpe, não consegui entender. Pode repetir, por favor?');
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
  const fala = falasDesde(db, c.id, marca, { teclas });
  // A ZOE não disse nada (raro, mas acontece sem IA): no modo teclas o menu volta, e a próxima
  // tecla vale como opção dele; no modo fala, só avisa que está ouvindo.
  if (!fala && depois.estado === 'bot' && teclas) {
    db.prepare('UPDATE conversas SET voz_no_menu = 1 WHERE id = ?').run(c.id);
    return { ...proximoPasso(db, { ...depois, voz_no_menu: 1 }, falaDoMenu(menuDa(cfgVoz)), { modo, noMenu: true }), ...(ouvido ? { ouvi: dito } : {}) };
  }
  return {
    ...passo(depois, fala || (depois.estado === 'bot' ? 'Pode falar, estou ouvindo.' : null)),
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
 * A ligação transferida foi atendida num ramal. A central avisa (zoe-agi.js atendeu, no gosub da
 * fila) e a conversa passa para a pessoa daquele ramal: o painel dela abre sozinho com a passagem
 * — o que o cliente disse e o que a ZOE já fez. Ramal sem usuário ligado fica registrado, e
 * qualquer pessoa da fila pode abrir a conversa.
 */
function atendida(db, empresa, uid, { ramal } = {}) {
  const c = porUid(db, empresa.id, uid);
  if (!c) throw naoEncontrado('Ligação');
  const r = normalizarRamal(ramal);
  if (!r) throw new ErroNegocio('Informe o ramal que atendeu a ligação.', 422);
  if (c.estado === 'encerrada') return { ok: true, encerrada: true };
  const u = db.prepare("SELECT id, nome FROM usuarios WHERE empresa_id = ? AND ramal = ? AND ativo = 1").get(empresa.id, r);
  // A central repete o aviso (rede instável, ou o mesmo ramal pegou de novo): não duplica.
  if (c.ligacao_ramal === r && c.ligacao_atendida_em) return { ok: true, atendente: u?.nome ?? null, repetido: true };
  transacao(db, () => {
    db.prepare(`UPDATE conversas SET ligacao_ramal = ?, ligacao_atendida_em = ?, passagem_vista_em = NULL,
        estado = CASE WHEN ? IS NULL THEN estado ELSE 'humano' END,
        atendente_id = COALESCE(?, atendente_id), assumida_em = CASE WHEN ? IS NULL THEN assumida_em ELSE COALESCE(assumida_em, ?) END
      WHERE id = ?`).run(r, agora(), u?.id ?? null, u?.id ?? null, u?.id ?? null, agora(), c.id);
    envio.registrarSistema(db, c, u
      ? `${u.nome} atendeu a ligação no ramal ${r}.`
      : `Ligação atendida no ramal ${r}, que não está ligado a nenhum usuário (Usuários › Ramal).`, { usuarioId: u?.id ?? null });
  });
  return { ok: true, atendente: u?.nome ?? null };
}

/** "PJSIP/201-0000002a", "SIP/201", "Local/201@from-queue/n" ou só "201" → "201". */
function normalizarRamal(x) {
  const t = String(x ?? '').trim();
  const m = t.match(/^(?:[A-Za-z]+\/)?(\d{2,8})(?:\b|[-@/])/) ?? t.match(/^(\d{2,8})$/);
  return m ? m[1] : null;
}

/**
 * Desligou. A ligação vira uma conversa encerrada no histórico do cliente, junto com o WhatsApp.
 * Se a ZOE falou por último, conta como resolvida por ela; se a pessoa desligou esperando
 * resposta, é abandono. Transferida e atendida num ramal, quem resolveu foi uma pessoa;
 * transferida e desligada antes de alguém atender, é abandono na fila.
 */
function encerrar(db, empresa, uid) {
  const c = porUid(db, empresa.id, uid);
  if (!c) throw naoEncontrado('Ligação');
  if (c.estado === 'encerrada') return { ok: true, ja_encerrada: true };
  const ultima = db.prepare("SELECT direcao, autor FROM mensagens WHERE conversa_id = ? AND tipo <> 'sistema' ORDER BY id DESC LIMIT 1").get(c.id);
  const naFila = c.estado === 'aguardando' && !c.ligacao_atendida_em;
  const resolvidaPor = c.estado === 'bot'
    ? (ultima?.direcao === 'saida' && ultima.autor === 'ia' ? 'ia' : 'abandono')
    : naFila ? 'abandono' : 'humano';
  transacao(db, () => conversas.encerrar(db, c, { resolvidaPor, avisar: false, pedirCsat: false }));
  envio.registrarSistema(db, c, naFila ? 'O cliente desligou na fila, antes de alguém atender.' : 'Ligação encerrada.');
  return { ok: true, resolvida_por: resolvidaPor };
}

module.exports = { iniciar, turno, atendida, encerrar, normalizarRamal, paraFala, telefoneDaBina, quantasTeclas, falaDoMenu, menuDa, MENU_PADRAO, MAX_NAO_ENTENDI };
