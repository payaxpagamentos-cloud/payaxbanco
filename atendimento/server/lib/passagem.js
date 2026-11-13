'use strict';

/**
 * A passagem de bastão: o que o atendente precisa saber no segundo em que pega a ligação.
 *
 * Sem isto, a ZOE conversa dois minutos com o cliente, confirma a identidade, testa a conexão,
 * manda a segunda via… e o atendente atende com "Bom dia, com quem eu falo?". O cliente repete
 * tudo, e o tempo que a ZOE ganhou vira irritação.
 *
 * Tudo aqui sai do que ficou registrado — mensagens, ações no IXC, chamados, Ouvidoria — e não de
 * um texto livre do modelo. Funciona igual com ou sem IA, e não inventa: se não está registrado,
 * não aparece.
 */

const lerJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** O que a ZOE fez no IXC, em frases de gente. Ação repetida aparece uma vez. */
function oQueFez(acoes) {
  const feitas = [];
  const falhas = [];
  for (const a of acoes) {
    const d = typeof a.detalhe === 'string' && a.detalhe.startsWith('{') ? lerJson(a.detalhe) : a.detalhe;
    if (!a.sucesso) {
      const frase = {
        confirmacao: 'O cliente errou a confirmação de identidade',
        desbloqueio: `Desbloqueio de confiança negado${typeof d === 'string' ? ` (${d})` : ''}`,
        boleto: 'Não conseguiu enviar a segunda via',
      }[a.tipo] ?? 'Não conseguiu consultar o sistema do provedor';
      falhas.push(frase);
      continue;
    }
    const frase = {
      identificacao: 'Encontrou o cadastro do cliente no IXC',
      confirmacao: 'Confirmou a identidade do titular',
      contrato: 'Consultou a situação do contrato',
      faturas: `Consultou as faturas${typeof d === 'string' ? `: ${d}` : ''}`,
      boleto: 'Enviou a segunda via da fatura',
      desbloqueio: 'Fez o desbloqueio de confiança',
      conexao: `Testou a conexão${typeof d === 'string' ? `: ${d}` : ''}`,
      chamado: `Abriu chamado técnico no IXC${d?.protocolo ? ` (protocolo ${d.protocolo})` : ''}`,
      alerta: 'Conferiu os alertas de rede da região',
    }[a.tipo];
    if (frase) feitas.push(frase);
  }
  const unicas = (xs) => [...new Set(xs)];
  return { feitas: unicas(feitas), falhas: unicas(falhas) };
}

/** Cada coisa que o cliente disse (ou digitou, ou escreveu), na ordem. */
function falasDoCliente(db, conversaId) {
  return db.prepare(`SELECT tipo, texto, transcricao, transcricao_status, criada_em FROM mensagens
    WHERE conversa_id = ? AND direcao = 'entrada' ORDER BY id`).all(conversaId)
    .map((m) => {
      const texto = m.texto || (m.transcricao_status === 'pronta' ? m.transcricao : null);
      return { em: m.criada_em, texto: texto ? String(texto).slice(0, 400) : null, entendida: Boolean(texto) };
    });
}

/** O diálogo, curto: cliente e ZOE alternando, sem notas do sistema. */
function dialogo(db, conversaId, limite = 16) {
  return db.prepare(`SELECT direcao, autor, texto, transcricao, transcricao_status, criada_em FROM mensagens
    WHERE conversa_id = ? AND tipo <> 'sistema' AND (texto IS NOT NULL OR transcricao IS NOT NULL OR direcao = 'entrada')
    ORDER BY id DESC LIMIT ?`).all(conversaId, limite).reverse()
    .map((m) => ({
      quem: m.direcao === 'entrada' ? 'cliente' : m.autor === 'ia' ? 'zoe' : 'equipe',
      texto: m.texto || (m.transcricao_status === 'pronta' ? m.transcricao : '(não deu para entender)'),
      em: m.criada_em,
    }));
}

/**
 * A passagem da conversa. `null` quando ainda está com a ZOE e nunca foi transferida — não há
 * bastão para passar.
 */
function montar(db, conversaId) {
  const c = db.prepare(`SELECT c.*, ct.nome AS contato_nome, ct.nome_perfil, ct.telefone, ct.documento, f.nome AS fila_nome
    FROM conversas c JOIN contatos ct ON ct.id = c.contato_id LEFT JOIN filas f ON f.id = c.fila_id WHERE c.id = ?`).get(conversaId);
  if (!c || !c.transferida_em) return null;

  const falas = falasDoCliente(db, c.id);
  const naoEntendidas = falas.filter((f) => !f.entendida).length;
  const { feitas, falhas } = oQueFez(db.prepare('SELECT tipo, sucesso, detalhe FROM ixc_acoes WHERE conversa_id = ? ORDER BY id').all(c.id));
  for (const ch of db.prepare('SELECT protocolo, assunto FROM chamados WHERE conversa_id = ? ORDER BY id').all(c.id)) {
    feitas.push(`Abriu o chamado ${ch.protocolo}: ${ch.assunto}`);
  }
  const ouvidorias = db.prepare('SELECT protocolo, tipo, assunto FROM ouvidoria WHERE conversa_id = ? ORDER BY id').all(c.id);
  for (const o of ouvidorias) feitas.push(`Registrou na Ouvidoria (${o.tipo}) o protocolo ${o.protocolo}: ${o.assunto}`);

  const nome = c.ixc_cliente_nome || c.contato_nome || c.nome_perfil || null;
  // O que pede atenção antes de abrir a boca.
  const atencao = [];
  if (!c.identidade_confirmada) {
    atencao.push(c.ixc_cliente_id
      ? 'Identidade NÃO confirmada: confirme o titular antes de falar do contrato.'
      : 'Cliente não identificado no IXC: peça o CPF ou CNPJ do titular.');
  }
  if (ouvidorias.some((o) => o.tipo === 'cancelamento')) atencao.push('Pediu cancelamento: tratar como retenção.');
  if (ouvidorias.some((o) => ['procon', 'anatel'].includes(o.tipo))) atencao.push('Falou em Procon ou Anatel: prazo legal correndo.');
  if (naoEntendidas >= 2) atencao.push(`A ZOE não entendeu ${naoEntendidas} fala(s): pode ser ligação ruim ou cliente com dificuldade.`);
  if (falhas.length) atencao.push(...falhas);

  const pediu = falas.find((f) => f.entendida && f.texto && !/^\d{1,14}$/.test(f.texto.trim()))?.texto ?? null;

  return {
    conversa_id: c.id,
    canal: c.canal,
    cliente: {
      nome,
      telefone: c.telefone,
      documento: c.documento,
      no_ixc: Boolean(c.ixc_cliente_id),
      contrato: c.ixc_contrato_id,
      identidade_confirmada: Boolean(c.identidade_confirmada),
      identidade_metodo: c.identidade_metodo,
    },
    fila: c.fila_nome,
    pediu,
    motivo: c.motivo_transferencia,
    resumo: c.resumo,
    assunto: c.assunto,
    ja_fez: feitas,
    atencao,
    falas: falas.length,
    dialogo: dialogo(db, c.id),
    transferida_em: c.transferida_em,
    atendida_em: c.ligacao_atendida_em,
    ramal: c.ligacao_ramal,
    sussurro: sussurro({ nome, identidade: Boolean(c.identidade_confirmada), motivo: c.motivo_transferencia || c.assunto, pediu, feitas }),
  };
}

/**
 * A frase que a central sussurra no ouvido do atendente antes de ligar o cliente (Queue com gosub).
 * Curta: quem é, se confirmou a identidade, o que quer e o que já foi feito. Uns 8 segundos.
 */
function sussurro({ nome, identidade, motivo, pediu, feitas }) {
  const partes = [];
  partes.push(`Ligação da ZOE${nome ? `: ${nome.split(/\s+/).slice(0, 2).join(' ')}` : ''}, ${identidade ? 'identidade confirmada' : 'identidade não confirmada'}.`);
  // O assunto é o que o CLIENTE disse; o motivo da transferência ("pediu atendente") só se não houver.
  const quer = pediu || motivo;
  if (quer) partes.push(`Assunto: ${limparParaFala(quer).slice(0, 120)}.`);
  if (feitas?.length) {
    // Para falar, sem números entre parênteses nem detalhes depois de dois-pontos: "1 login, 0 online" soa mal.
    const curtas = feitas.slice(-2).map((f) => f.replace(/\s*\([^)]*\)/g, '').replace(/:.*$/, '').trim());
    partes.push(`Já feito: ${curtas.map((f, i) => (i ? f.charAt(0).toLowerCase() + f.slice(1) : f)).join(' e ')}.`);
  }
  return partes.join(' ');
}

const limparParaFala = (t) => String(t).replace(/["“”]/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();

module.exports = { montar, oQueFez, sussurro };
