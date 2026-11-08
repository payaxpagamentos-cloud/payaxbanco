'use strict';

const { agora, lerConfig } = require('../db');
const { local, somarDias, inicioDia } = require('./datas');
const pdf = require('./pdf');
const zap = require('./whatsapp');

/**
 * Relatórios programados: diário (o dia anterior), semanal (segunda a domingo da semana anterior), quinzenal (a quinzena
 * anterior) e mensal (o mês anterior). Saem às 7h de Brasília, em PDF pelo WhatsApp, para os contatos escolhidos.
 */
const FREQUENCIAS = { diario: 'Diário', semanal: 'Semanal (segunda)', quinzenal: 'Quinzenal (dias 1 e 16)', mensal: 'Mensal (dia 1)' };
const CONTEUDOS = { frota: 'Resumo da frota', seguranca: 'Segurança e alertas', motoristas: 'Nota dos motoristas', custos: 'Custos' };
const HORA = 7;

const diaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();
const as7 = (data) => new Date(Date.parse(inicioDia(data)) + HORA * 3_600_000).toISOString();

/** Próxima data de envio (dia local) depois de `instante`. */
function proximoEnvio(frequencia, instante = new Date()) {
  const l = local(instante);
  const passou = l.hora >= HORA;
  let d = passou ? somarDias(l.data, 1) : l.data;
  for (let i = 0; i < 40; i++) {
    const dia = Number(d.slice(8, 10));
    if (frequencia === 'diario'
      || (frequencia === 'semanal' && diaSemana(d) === 1)
      || (frequencia === 'quinzenal' && (dia === 1 || dia === 16))
      || (frequencia === 'mensal' && dia === 1)) return as7(d);
    d = somarDias(d, 1);
  }
  return as7(d);
}

/** Período coberto por um envio feito no dia local `data`. */
function periodo(frequencia, data) {
  const ontem = somarDias(data, -1);
  if (frequencia === 'diario') return [ontem, ontem];
  if (frequencia === 'semanal') return [somarDias(data, -7), ontem];
  if (frequencia === 'quinzenal') return Number(data.slice(8, 10)) === 16 ? [`${data.slice(0, 7)}-01`, ontem] : [`${ontem.slice(0, 7)}-16`, ontem];
  return [`${ontem.slice(0, 7)}-01`, ontem];
}

const dataBr = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Gera o PDF e põe uma mensagem na fila para cada contato. Devolve o registro do envio. */
async function enviar(db, agenda, { de, ate } = {}) {
  const dataEnvio = local().data;
  const [ini, fim] = de && ate ? [de, ate] : periodo(agenda.frequencia, dataEnvio);
  const contatos = agenda.contatos.split(',').map(Number).filter(Boolean)
    .map((id) => db.prepare('SELECT * FROM contatos_notificacao WHERE id = ? AND empresa_id = ? AND ativo = 1').get(id, agenda.empresa_id)).filter(Boolean);
  let status = 'enviado';
  let erro = null;
  try {
    const plataforma = lerConfig(db).nome_plataforma;
    const arquivo = await pdf.relatorioPeriodo(db, agenda.empresa_id, ini, fim, agenda.conteudo.split(','), plataforma);
    const empresa = db.prepare('SELECT nome FROM empresas WHERE id = ?').get(agenda.empresa_id).nome;
    const texto = `*${agenda.nome}* · ${empresa}\nPeríodo: ${ini === fim ? dataBr(ini) : `${dataBr(ini)} a ${dataBr(fim)}`}\nO relatório completo está no PDF.`;
    if (!contatos.length) { status = 'sem_destino'; erro = 'Nenhum contato ativo escolhido.'; }
    for (const c of contatos) {
      zap.enfileirar(db, { empresaId: agenda.empresa_id, numero: c.numero, texto, arquivo, arquivoNome: `relatorio-${ini}-a-${fim}.pdf`, origem: 'relatorios' });
    }
    if (contatos.length && !zap.configurado()) { status = 'sem_whatsapp'; erro = 'WhatsApp não configurado no servidor.'; }
  } catch (err) {
    status = 'falhou';
    erro = String(err.message).slice(0, 300);
  }
  db.prepare('INSERT INTO relatorios_envios (agenda_id, empresa_id, nome, de, ate, destinos, status, erro, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(agenda.id ?? null, agenda.empresa_id, agenda.nome, ini, fim, contatos.length, status, erro, agora());
  return { de: ini, ate: fim, destinos: contatos.length, status, erro };
}

let rodando = false;
/** Tarefa de cada minuto: envia as agendas cuja hora chegou e marca a próxima. */
async function executar(db) {
  if (rodando) return;
  rodando = true;
  try {
    const vencidas = db.prepare(`SELECT a.* FROM relatorios_agenda a JOIN empresas e ON e.id = a.empresa_id
      WHERE a.ativo = 1 AND e.status = 'ativa' AND a.proximo_em <= ?`).all(agora());
    for (const a of vencidas) {
      db.prepare('UPDATE relatorios_agenda SET ultimo_em = ?, proximo_em = ? WHERE id = ?').run(agora(), proximoEnvio(a.frequencia, new Date(Date.now() + 60_000)), a.id);
      await enviar(db, a);
    }
  } finally {
    rodando = false;
  }
}

module.exports = { FREQUENCIAS, CONTEUDOS, proximoEnvio, periodo, enviar, executar };
