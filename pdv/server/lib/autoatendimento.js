'use strict';

/**
 * Tela do cliente (autoatendimento): a que fica virada para quem vai pagar.
 * O cliente digita o CPF/CNPJ, vê as próprias faturas em aberto e paga no cartão pela maquininha do PDV.
 *
 * A tela não usa login de usuário: ela é ativada uma vez com a chave do PDV (pdv_<prefixo>_<segredo>),
 * guardada no próprio aparelho. Tudo o que ela faz fica em nome do usuário "Autoatendimento" daquele PDV,
 * aparece nos recebimentos com origem "autoatendimento" e entra na mesma conferência com o IXC.
 */

const crypto = require('node:crypto');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hashSenha } = require('./senha');
const { clienteIxc, lerConfig, configPublica } = require('./ixcEmpresa');
const { comAcrescimo, criar } = require('./recebimentos');
const { cobrar, buscar: buscarCobranca, publico: cobrancaPublica, formasDoTerminal } = require('./maquininha');
const { digitos } = require('./ixc');
const v = require('./validacao');

const FORMAS = ['debito', 'credito', 'pix'];
const hashChave = (segredo) => crypto.createHash('sha256').update(segredo).digest('hex');

/** Liga o autoatendimento no PDV: cria (uma vez) o usuário da tela e gera a chave, que aparece uma única vez. */
function ativar(db, empresa, pdvId) {
  return transacao(db, () => {
    const pdv = db.prepare('SELECT * FROM pdvs WHERE id = ? AND empresa_id = ?').get(Number(pdvId), empresa.id);
    if (!pdv) throw naoEncontrado('PDV');
    if (!pdv.ativo) throw new ErroNegocio('Ative o PDV antes de ligar a tela do cliente.', 409);
    let usuarioId = pdv.usuario_id;
    if (!usuarioId) {
      const email = `autoatendimento.pdv${pdv.id}.e${empresa.id}@pdv.local`;
      const r = db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, loja_id, ativo, criado_em)
        VALUES (?, ?, ?, 'operador', ?, ?, 1, ?)`)
        .run(`Autoatendimento · ${pdv.nome}`, email, hashSenha(crypto.randomBytes(32).toString('base64url')), empresa.id, pdv.loja_id, agora());
      usuarioId = Number(r.lastInsertRowid);
    }
    const prefixo = crypto.randomBytes(4).toString('hex');
    const segredo = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE pdvs SET autoatendimento = 1, chave_prefixo = ?, chave_hash = ?, usuario_id = ? WHERE id = ?')
      .run(prefixo, hashChave(segredo), usuarioId, pdv.id);
    return { pdv_id: pdv.id, chave: `pdv_${prefixo}_${segredo}` };
  });
}

/** Desliga a tela do cliente: a chave para de valer na hora. */
function desligar(db, empresa, pdvId) {
  const pdv = db.prepare('SELECT * FROM pdvs WHERE id = ? AND empresa_id = ?').get(Number(pdvId), empresa.id);
  if (!pdv) throw naoEncontrado('PDV');
  db.prepare('UPDATE pdvs SET autoatendimento = 0, chave_prefixo = NULL, chave_hash = NULL WHERE id = ?').run(pdv.id);
  return { pdv_id: pdv.id, autoatendimento: false };
}

/** PDV dono da chave informada (tela ligada, PDV ativo e empresa ativa). */
function lerChave(db, chave) {
  const m = /^pdv_([0-9a-f]{8})_([A-Za-z0-9_-]{20,64})$/.exec(String(chave ?? ''));
  if (!m) return null;
  const pdv = db.prepare('SELECT * FROM pdvs WHERE chave_prefixo = ? AND autoatendimento = 1 AND ativo = 1').get(m[1]);
  if (!pdv?.chave_hash) return null;
  const esperado = Buffer.from(pdv.chave_hash, 'hex');
  const recebido = Buffer.from(hashChave(m[2]), 'hex');
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status = 'ativa'").get(pdv.empresa_id);
  if (!empresa) return null;
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(pdv.usuario_id);
  if (!usuario) return null;
  return { pdv, empresa, usuario };
}

/** Nome parcialmente escondido: o cliente se reconhece, quem digitou um CPF alheio não descobre quem é. */
function mascararNome(nome) {
  const partes = String(nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '';
  return partes.map((p, i) => (i === 0 || p.length <= 2 ? p : `${p[0]}${'*'.repeat(Math.min(6, p.length - 1))}`)).join(' ');
}

/** O que a tela mostra ao abrir: marca, loja e as formas de pagamento disponíveis naquele PDV. */
function abertura(db, { pdv, empresa }) {
  const cfg = configPublica(db, empresa.id);
  const terminal = terminalDoPdv(db, pdv);
  return {
    empresa: { nome: empresa.nome },
    loja: db.prepare('SELECT nome FROM lojas WHERE id = ?').get(pdv.loja_id)?.nome ?? null,
    pdv: { id: pdv.id, nome: pdv.nome },
    logo_url: cfg.logo_url || 'img/logo-cliente.png',
    // Propaganda do provedor atrás do painel de vidro; sem imagem, vale a arte desenhada na própria tela.
    fundo_url: cfg.autoatendimento_fundo || null,
    // Quando a arte já traz a marca, a tela não repete o logo em cima dela.
    fundo_tem_marca: !!cfg.autoatendimento_fundo_marca,
    // Chamada da operadora no alto da tela; sem configurar, vale o texto padrão.
    titulo: cfg.autoatendimento_titulo || 'Sua casa mais conectada.',
    subtitulo: cfg.autoatendimento_subtitulo || 'Internet para todos os seus momentos.',
    mensagem: cfg.autoatendimento_mensagem || null,
    // Sem maquininha ligada ao PDV a tela só consulta: não há como cobrar.
    maquininha: terminal ? { id: terminal.id, nome: terminal.nome, adquirente: terminal.adquirente } : null,
    // Só aparece para o cliente o que a maquininha daquele PDV realmente faz.
    formas: terminal ? FORMAS.filter((f) => formasDoTerminal(terminal).includes(f)) : [],
    ixc_pronto: !!(cfg.ixc_ativo && cfg.ixc_url),
  };
}

/** Maquininha que atende este PDV: a do próprio PDV e, se não houver, a da loja (nunca a de digitação manual). */
function terminalDoPdv(db, pdv) {
  return db.prepare(`SELECT * FROM terminais WHERE empresa_id = ? AND ativo = 1 AND modo <> 'manual' AND (pdv_id = ? OR (pdv_id IS NULL AND loja_id = ?))
    ORDER BY pdv_id IS NULL, id LIMIT 1`).get(pdv.empresa_id, pdv.id, pdv.loja_id) ?? null;
}

/** Consulta do cliente: só pelo CPF/CNPJ completo e válido, com o nome escondido em parte. */
async function faturas(db, { pdv, empresa }, documento) {
  const doc = v.documento(documento, 'o CPF/CNPJ');
  const { ixc } = clienteIxc(db, empresa.id);
  const clientes = await ixc.clientesPorDocumento(doc);
  if (!clientes.length) return { encontrado: false };
  const cliente = clientes.find((c) => c.ativo) ?? clientes[0];
  const abertas = await ixc.faturasAbertas(cliente.id);
  const comValores = comAcrescimo(db, empresa.id, abertas);
  // Fatura já recebida no PDV (e ainda não baixada no IXC) não aparece de novo para não pagar duas vezes.
  const jaPagas = new Set(db.prepare(`SELECT t.fatura_ixc_id FROM recebimento_titulos t JOIN recebimentos r ON r.id = t.recebimento_id
    WHERE r.empresa_id = ? AND r.status = 'confirmado' AND r.cliente_ixc_id = ?`).all(empresa.id, cliente.id).map((x) => x.fatura_ixc_id));
  return {
    encontrado: true,
    cliente: { id: cliente.id, nome: mascararNome(cliente.nome), documento: doc.slice(0, 3) + '*'.repeat(doc.length - 5) + doc.slice(-2) },
    faturas: comValores.filter((f) => !jaPagas.has(f.id)).map((f) => ({
      id: f.id,
      documento: f.documento,
      vencimento: f.vencimento,
      valor_centavos: f.aberto_centavos,
      acrescimo_centavos: f.atraso.total_centavos,
      dias_atraso: f.atraso.dias,
      total_centavos: f.total_centavos,
      contrato_id: f.contrato_id,
    })),
    pdv: pdv.nome,
  };
}

/** Manda a maquininha do PDV cobrar o que o cliente escolheu. */
async function cobrarNaMaquininha(db, { pdv, empresa, usuario }, { forma, valorCentavos, parcelas = 1 }) {
  const terminal = terminalDoPdv(db, pdv);
  if (!terminal) throw new ErroNegocio('Nenhuma maquininha ligada a este PDV. Procure o atendente.', 409);
  v.opcao(forma, 'a forma de pagamento', FORMAS);
  return cobrar(db, {
    empresa, terminalId: terminal.id, forma, valorCentavos, parcelas, operadorId: usuario.id, caixaId: null,
  });
}

/**
 * Fecha o pagamento: confere a cobrança aprovada, grava o recebimento em nome da tela e devolve o recibo.
 * A baixa no IXC segue o mesmo caminho do balcão (na hora e, se falhar, pela fila).
 */
async function receber(db, { pdv, empresa, usuario }, dados) {
  const transacaoId = v.inteiro(dados.transacao_id, 'a cobrança', { min: 1 });
  const cobranca = buscarCobranca(db, empresa.id, transacaoId);
  if (cobranca.status !== 'aprovada') throw new ErroNegocio('O pagamento não foi aprovado na maquininha.', 409);
  const escolhidas = Array.isArray(dados.faturas) ? dados.faturas.map((f) => String(f)) : [];
  v.exigir(escolhidas.length > 0, 'Escolha pelo menos uma fatura.');
  const clienteId = v.texto(dados.cliente_ixc_id, 'o cliente', 20);

  const { ixc } = clienteIxc(db, empresa.id);
  const cliente = await ixc.clientePorId(clienteId);
  if (!cliente) throw new ErroNegocio('Cliente não encontrado no IXC.', 404);
  const abertas = comAcrescimo(db, empresa.id, await ixc.faturasAbertas(clienteId));
  const titulos = escolhidas.map((id) => {
    const f = abertas.find((x) => x.id === id);
    if (!f) throw new ErroNegocio('Uma das faturas mudou no IXC. Procure o atendente.', 409);
    return {
      fatura_ixc_id: f.id,
      contrato_ixc_id: f.contrato_id,
      documento: f.documento,
      vencimento: f.vencimento,
      valor_centavos: f.aberto_centavos,
      acrescimo_centavos: f.atraso.total_centavos,
    };
  });
  const total = titulos.reduce((s, t) => s + t.valor_centavos + t.acrescimo_centavos, 0);
  v.exigir(total === cobranca.valor_centavos, 'O valor aprovado na maquininha é diferente do total das faturas. Procure o atendente.');

  return criar(db, {
    empresa,
    usuario,
    origem: 'autoatendimento',
    dados: {
      cliente_ixc_id: cliente.id,
      cliente_nome: cliente.nome,
      cliente_documento: cliente.documento,
      contrato_ixc_id: titulos[0]?.contrato_ixc_id ?? null,
      loja_id: pdv.loja_id,
      titulos,
      pagamentos: [{ forma: cobranca.forma, valor_centavos: cobranca.valor_centavos, transacao_id: cobranca.id }],
      observacao: `Pago pelo cliente na tela do ${pdv.nome}`,
    },
  });
}

module.exports = { FORMAS, ativar, desligar, lerChave, abertura, faturas, cobrarNaMaquininha, receber, mascararNome, terminalDoPdv, cobrancaPublica, digitos, lerConfig };
