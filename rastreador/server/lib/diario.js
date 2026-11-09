'use strict';

const { agora, transacao } = require('../db');
const { alertar } = require('./alertas');
const notif = require('./notificacoes');
const fotos = require('./fotos');
const v = require('./validacao');

/**
 * O que o motorista lança pelo app: SOS, checklist de saída, abastecimento e avaria. Problemas no checklist e avarias avisam a
 * empresa pelo WhatsApp (aviso "App do motorista"); o SOS vira o alerta de pânico (vai a qualquer hora, como os de segurança).
 */
const ITENS_CHECKLIST = [
  { id: 'pneus', texto: 'Pneus e estepe' },
  { id: 'oleo', texto: 'Óleo e água' },
  { id: 'luzes', texto: 'Luzes e setas' },
  { id: 'freios', texto: 'Freios' },
  { id: 'lataria', texto: 'Lataria e vidros (sem avaria nova)' },
  { id: 'limpeza', texto: 'Limpeza' },
  { id: 'documentos', texto: 'Documento do veículo e cartão' },
  { id: 'seguranca', texto: 'Extintor, triângulo e macaco' },
];
const GRAVIDADES = { baixa: 'Baixa', media: 'Média', alta: 'Alta (não dá para rodar)' };
const STATUS_AVARIA = { aberta: 'Aberta', em_andamento: 'Em andamento', resolvida: 'Resolvida' };
const SOS_INTERVALO_MS = 60_000;

const ponto = (d) => {
  const lat = Number(d?.lat);
  const lng = Number(d?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null;
};
const textoOpcional = (x, nome, max) => (x === undefined || x === null || String(x).trim() === '' ? null : v.texto(x, nome, max));

function sos(db, m, d) {
  const lista = require('./condutores').veiculosDo(db, m);
  const veiculo = (d.veiculo_id && lista.find((x) => x.id === Number(d.veiculo_id))) || lista[0] || null;
  const p = ponto(d);
  const recente = veiculo && db.prepare("SELECT 1 FROM alertas WHERE veiculo_id = ? AND tipo = 'panico' AND mensagem LIKE 'SOS pelo app%' AND ocorrido_em >= ?")
    .get(veiculo.id, new Date(Date.now() - SOS_INTERVALO_MS).toISOString());
  if (recente) return { ok: true, repetido: true, placa: veiculo.placa };
  const msg = `SOS pelo app do motorista: ${m.nome} pediu ajuda${p ? ' (localização do celular)' : ''}.`;
  if (veiculo) {
    alertar(db, veiculo, 'panico', msg, p ? { ...p, velocidade_kmh: veiculo.velocidade_kmh } : {});
  } else {
    notif.avisar(db, m.empresa_id, 'panico', { titulo: `🚨 SOS · ${m.nome}`, texto: msg, ...(p ?? {}), caminho: `/empresa/${m.empresa_id}/alertas` });
  }
  return { ok: true, placa: veiculo?.placa ?? null };
}

function checklist(db, m, veiculo, d) {
  const respostas = new Map([].concat(d.itens ?? []).map((i) => [String(i?.id), i]));
  const itens = ITENS_CHECKLIST.map((i) => {
    const r = respostas.get(i.id);
    v.exigir(r && typeof r.ok === 'boolean', `Responda o item "${i.texto}".`);
    return { id: i.id, texto: i.texto, ok: r.ok, obs: r.ok ? null : textoOpcional(r.obs, 'a observação', 200) };
  });
  const km = d.km === undefined || d.km === null || d.km === '' ? null : v.inteiro(d.km, 'o km do painel', { min: 0, max: 9_999_999 });
  const obs = textoOpcional(d.observacao, 'a observação', 500);
  const lista = fotos.conferir(d.fotos);
  const aprovado = itens.every((i) => i.ok);
  const id = transacao(db, () => {
    const novo = Number(db.prepare('INSERT INTO checklists (empresa_id, veiculo_id, motorista_id, itens, aprovado, km, observacao, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(veiculo.empresa_id, veiculo.id, m.id, JSON.stringify(itens), aprovado ? 1 : 0, km, obs, agora()).lastInsertRowid);
    fotos.salvar(db, veiculo.empresa_id, 'checklist', novo, lista);
    return novo;
  });
  if (!aprovado) {
    const problemas = itens.filter((i) => !i.ok).map((i) => `${i.texto}${i.obs ? ` (${i.obs})` : ''}`).join('; ');
    notif.avisar(db, veiculo.empresa_id, 'app_motorista', { titulo: `Checklist com problema · ${veiculo.placa}`, texto: `${m.nome}: ${problemas}.`,
      caminho: `/empresa/${veiculo.empresa_id}/checklists` });
  }
  return { id, aprovado };
}

function abastecimento(db, m, veiculo, d) {
  const litros = Number(String(d.litros ?? '').replace(',', '.'));
  v.exigir(Number.isFinite(litros) && litros >= 0.5 && litros <= 2000, 'Informe os litros abastecidos (entre 0,5 e 2.000).');
  const valorReais = d.valor_centavos !== undefined ? Number(d.valor_centavos) / 100 : Number(String(d.valor ?? '').replace(/\./g, '').replace(',', '.'));
  v.exigir(Number.isFinite(valorReais) && valorReais >= 1 && valorReais <= 100_000, 'Informe o valor pago (entre R$ 1,00 e R$ 100.000,00).');
  const valor = Math.round(valorReais * 100);
  const km = d.km === undefined || d.km === null || d.km === '' ? null : v.inteiro(d.km, 'o km do painel', { min: 0, max: 9_999_999 });
  const posto = textoOpcional(d.posto, 'o posto', 80);
  const lista = fotos.conferir(d.fotos);
  const id = transacao(db, () => {
    const novo = Number(db.prepare(`INSERT INTO abastecimentos (empresa_id, veiculo_id, motorista_id, litros, valor_centavos, km, hodometro_km, posto, completo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(veiculo.empresa_id, veiculo.id, m.id, Math.round(litros * 100) / 100, valor, km,
      Math.floor((veiculo.hodometro_m ?? 0) / 1000), posto, d.completo === false ? 0 : 1, agora()).lastInsertRowid);
    fotos.salvar(db, veiculo.empresa_id, 'abastecimento', novo, lista);
    return novo;
  });
  return { id, preco_litro_centavos: Math.round(valor / litros) };
}

function avaria(db, m, veiculo, d) {
  const descricao = v.texto(d.descricao, 'o que aconteceu', 500);
  const gravidade = v.opcao(d.gravidade ?? 'media', 'a gravidade', Object.keys(GRAVIDADES));
  const lista = fotos.conferir(d.fotos);
  const id = transacao(db, () => {
    const novo = Number(db.prepare('INSERT INTO avarias (empresa_id, veiculo_id, motorista_id, descricao, gravidade, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(veiculo.empresa_id, veiculo.id, m.id, descricao, gravidade, agora()).lastInsertRowid);
    fotos.salvar(db, veiculo.empresa_id, 'avaria', novo, lista);
    return novo;
  });
  notif.avisar(db, veiculo.empresa_id, 'app_motorista', { titulo: `Avaria reportada · ${veiculo.placa}`, texto: `${m.nome} (${GRAVIDADES[gravidade].toLowerCase()}): ${descricao}`,
    caminho: `/empresa/${veiculo.empresa_id}/manutencao` });
  return { id };
}

function historicoMotorista(db, m) {
  const ult = (sql) => db.prepare(sql).all(m.id);
  return {
    checklists: ult('SELECT c.id, c.aprovado, c.criado_em, v.placa FROM checklists c JOIN veiculos v ON v.id = c.veiculo_id WHERE c.motorista_id = ? ORDER BY c.id DESC LIMIT 10'),
    abastecimentos: ult('SELECT a.id, a.litros, a.valor_centavos, a.criado_em, v.placa FROM abastecimentos a JOIN veiculos v ON v.id = a.veiculo_id WHERE a.motorista_id = ? ORDER BY a.id DESC LIMIT 10'),
    avarias: ult('SELECT a.id, a.descricao, a.gravidade, a.status, a.criado_em, v.placa FROM avarias a JOIN veiculos v ON v.id = a.veiculo_id WHERE a.motorista_id = ? ORDER BY a.id DESC LIMIT 10'),
  };
}

// ---------- Painel da empresa ----------
const comFotos = (db, origem) => (x) => ({ ...x, fotos: fotos.ids(db, origem, x.id) });

function listarChecklists(db, empresaId, { ini, fim, veiculoId, reprovados }) {
  return db.prepare(`SELECT c.*, v.placa, v.descricao AS veiculo, m.nome AS motorista FROM checklists c JOIN veiculos v ON v.id = c.veiculo_id
    LEFT JOIN motoristas m ON m.id = c.motorista_id WHERE c.empresa_id = ? AND c.criado_em >= ? AND c.criado_em < ?
    ${veiculoId ? 'AND c.veiculo_id = ?' : ''} ${reprovados ? 'AND c.aprovado = 0' : ''} ORDER BY c.id DESC LIMIT 300`)
    .all(...[empresaId, ini, fim, ...(veiculoId ? [veiculoId] : [])]).map((c) => ({ ...comFotos(db, 'checklist')(c), itens: JSON.parse(c.itens) }));
}
function listarAbastecimentos(db, empresaId, { ini, fim, veiculoId }) {
  return db.prepare(`SELECT a.*, v.placa, v.descricao AS veiculo, m.nome AS motorista FROM abastecimentos a JOIN veiculos v ON v.id = a.veiculo_id
    LEFT JOIN motoristas m ON m.id = a.motorista_id WHERE a.empresa_id = ? AND a.criado_em >= ? AND a.criado_em < ? ${veiculoId ? 'AND a.veiculo_id = ?' : ''}
    ORDER BY a.id DESC LIMIT 300`).all(...[empresaId, ini, fim, ...(veiculoId ? [veiculoId] : [])]).map(comFotos(db, 'abastecimento'));
}
function listarAvarias(db, empresaId, status) {
  return db.prepare(`SELECT a.*, v.placa, v.descricao AS veiculo, m.nome AS motorista, u.nome AS resolvida_por_nome FROM avarias a JOIN veiculos v ON v.id = a.veiculo_id
    LEFT JOIN motoristas m ON m.id = a.motorista_id LEFT JOIN usuarios u ON u.id = a.resolvida_por WHERE a.empresa_id = ?
    ${status === 'abertas' ? "AND a.status <> 'resolvida'" : status === 'resolvidas' ? "AND a.status = 'resolvida'" : ''}
    ORDER BY a.status = 'resolvida', CASE a.gravidade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, a.id DESC LIMIT 300`).all(empresaId).map(comFotos(db, 'avaria'));
}
function atualizarAvaria(db, avariaAtual, d, usuarioId) {
  const status = v.opcao(d.status ?? avariaAtual.status, 'a situação', Object.keys(STATUS_AVARIA));
  const obs = d.observacao !== undefined ? textoOpcional(d.observacao, 'a observação', 500) : avariaAtual.observacao;
  const resolvida = status === 'resolvida';
  db.prepare('UPDATE avarias SET status = ?, observacao = ?, resolvida_em = ?, resolvida_por = ? WHERE id = ?').run(status, obs,
    resolvida ? avariaAtual.resolvida_em ?? agora() : null, resolvida ? avariaAtual.resolvida_por ?? usuarioId : null, avariaAtual.id);
}

module.exports = {
  ITENS_CHECKLIST, GRAVIDADES, STATUS_AVARIA, sos, checklist, abastecimento, avaria, historicoMotorista,
  listarChecklists, listarAbastecimentos, listarAvarias, atualizarAvaria,
};
