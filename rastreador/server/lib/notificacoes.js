'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const config = require('../config');
const { local } = require('./datas');
const zap = require('./whatsapp');

/**
 * Quem recebe o quê pelo WhatsApp. Cada contato marca os tipos de aviso; os de segurança chegam também no horário de silêncio
 * e vão ainda para os contatos da plataforma (empresa_id nulo), que acompanham todas as empresas.
 */
const TIPOS_AVISO = {
  roubo: 'Modo Roubo (cada passo)',
  estacionado_violado: 'Estacionado violado',
  sumico_suspeito: 'Sumiço suspeito',
  voltou_comunicar: 'Voltou a comunicar',
  panico: 'Botão de pânico',
  bateria_desconectada: 'Bateria desconectada',
  violacao: 'Violação do equipamento',
  liberacao: 'Liberações e bloqueio programado',
  cerca_saida: 'Saída da cerca',
  cerca_entrada: 'Entrada na cerca',
  velocidade: 'Excesso de velocidade',
  fora_horario: 'Uso fora do horário',
  ignicao: 'Ignição ligada e desligada',
  sem_comunicacao: 'Sem comunicação',
  bateria_baixa: 'Bateria baixa',
  vibracao: 'Vibração no veículo',
  deslocamento: 'Deslocamento (alarme do aparelho)',
  relatorios: 'Relatórios programados',
  app_motorista: 'App do motorista (checklist com problema e avarias)',
};
const SEGURANCA = new Set(['roubo', 'estacionado_violado', 'sumico_suspeito', 'panico', 'bateria_desconectada', 'violacao', 'liberacao']);
// Tipo de alerta → tipo de aviso.
const DO_ALERTA = { ignicao_ligada: 'ignicao', ignicao_desligada: 'ignicao' };

const hhmm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Dentro do horário de silêncio (pode virar a noite)? */
function emSilencio(contato, instante = new Date()) {
  if (!contato.silencio_inicio || !contato.silencio_fim) return false;
  const l = local(instante);
  const m = l.hora * 60 + l.minuto;
  const a = hhmm(contato.silencio_inicio);
  const b = hhmm(contato.silencio_fim);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

const dataCurta = (iso) => { const l = local(iso); return `${l.data.slice(8, 10)}/${l.data.slice(5, 7)} ${String(l.hora).padStart(2, '0')}:${String(l.minuto).padStart(2, '0')}`; };
const mapa = (lat, lng) => (lat !== null && lat !== undefined ? `https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}` : null);

/** Texto padrão: empresa, título, detalhe, local, hora e o link do painel (se configurado). */
function montar({ empresa, titulo, texto, lat, lng, em, caminho }) {
  const linhas = [`*${titulo}*`, texto];
  const l = mapa(lat, lng);
  if (l) linhas.push(`Local: ${l}`);
  linhas.push(`${empresa ? `${empresa} · ` : ''}${dataCurta(em ?? new Date().toISOString())}`);
  if (config.urlPublica && caminho) linhas.push(`Abrir no painel: ${config.urlPublica}/#${caminho}`);
  return linhas.join('\n');
}

/**
 * Avisa os contatos que pediram este tipo. Devolve quantas mensagens entraram na fila.
 * `dados`: { titulo, texto, lat, lng, em, caminho, arquivo, arquivoNome }.
 */
function avisar(db, empresaId, tipo, dados) {
  const t = DO_ALERTA[tipo] ?? tipo;
  if (!TIPOS_AVISO[t]) return 0;
  const seguranca = SEGURANCA.has(t);
  const contatos = db.prepare(`SELECT * FROM contatos_notificacao WHERE ativo = 1 AND (empresa_id = ? ${seguranca ? 'OR empresa_id IS NULL' : ''})`).all(empresaId)
    .filter((c) => c.tipos.split(',').includes(t) && (seguranca || !emSilencio(c)));
  if (!contatos.length) return 0;
  const empresa = db.prepare('SELECT nome FROM empresas WHERE id = ?').get(empresaId)?.nome;
  const texto = montar({ empresa, ...dados, titulo: dados.titulo ?? TIPOS_AVISO[t] });
  const vistos = new Set();
  for (const c of contatos) {
    const num = zap.normalizarNumero(c.numero);
    if (vistos.has(num)) continue;
    vistos.add(num);
    zap.enfileirar(db, { empresaId, numero: num, texto, arquivo: dados.arquivo, arquivoNome: dados.arquivoNome, origem: t });
  }
  return vistos.size;
}

module.exports = { TIPOS_AVISO, SEGURANCA, avisar, emSilencio, montar };
