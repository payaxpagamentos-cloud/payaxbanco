'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Funções do J16 4G (e GT06 parecidos) usadas pelo sistema: perfis de envio, alarmes do aparelho, modo perseguição,
 * instalação e consultas. Os textos seguem o manual em português do J16 4G e o do fabricante; cada lote pode aceitar um
 * conjunto diferente, por isso a ficha mostra a resposta do aparelho.
 */
const PERFIS = {
  economico: { nome: 'Econômico', timer: [60, 3600], descricao: 'Posição a cada 60 s ligado e 1 h desligado. Menos dados e bateria.' },
  padrao: { nome: 'Padrão', timer: [30, 300], descricao: 'Posição a cada 30 s ligado e 5 min desligado.' },
  precisao: { nome: 'Máxima precisão', timer: [10, 60], descricao: 'Posição a cada 10 s ligado e 1 min desligado. Trajeto mais fiel.' },
};
const PERSEGUICAO = [10, 10];

/** Configurações que o gestor aplica pela ficha: cada uma vira um ou mais comandos (rótulo e texto). */
const AJUSTES = {
  perfil: (v) => {
    const p = PERFIS[v] ?? PERFIS.padrao;
    return [{ rotulo: `Perfil ${p.nome}`, texto: `TIMER,${p.timer[0]},${p.timer[1]}#` }, { rotulo: `Batimento do perfil ${p.nome}`, texto: `HBT,${p.timer[0]},${p.timer[1]}#` }];
  },
  curvas: (v) => [{ rotulo: v ? 'Envio nas curvas ligado' : 'Envio nas curvas desligado', texto: v ? 'SZCS#ANGLEVALUE=10-015' : 'SZCS#ANGLEVALUE=0-000' }],
  // Dormir online (0) mantém os comandos chegando; dormir offline (1) poupa mais bateria, mas o aparelho só ouve SMS.
  sono: (v) => [{ rotulo: v === 'economia' ? 'Sono com economia máxima' : 'Sono online', texto: `SZCS#SLPDISCONNECT=${v === 'economia' ? 1 : 0}` }],
  ignicao_virtual: (v) => [{ rotulo: v ? 'Ignição virtual ligada' : 'Ignição pelo fio', texto: `SZCS#ACCLINE=${v ? 1 : 0}` }],
  leds: (v) => [{ rotulo: v ? 'LEDs ligados' : 'LEDs apagados', texto: `SZCS#LED_ENABLE=${v ? 1 : 0}` }],
  alarme_energia: (v) => [{ rotulo: v ? 'Alarme de corte de energia ligado' : 'Alarme de corte de energia desligado', texto: v ? 'POWERALM,ON,0,10,10#' : 'POWERALM,OFF#' }],
  alarme_bateria: (v) => [{ rotulo: v ? 'Alarme de bateria baixa ligado' : 'Alarme de bateria baixa desligado', texto: v ? 'BATALM,ON,0#' : 'BATALM,OFF#' }],
  alarme_vibracao: (v) => [{ rotulo: v ? 'Alarme de vibração ligado' : 'Alarme de vibração desligado', texto: v ? 'SENALM,ON,0#' : 'SENALM,OFF#' }],
  velocidade: (v) => [{ rotulo: v ? `Limite de ${v} km/h no aparelho` : 'Limite de velocidade do aparelho desligado', texto: v ? `SPEED,ON,10,${Math.min(255, Math.max(1, Number(v)))},0#` : 'SPEED,OFF#' }],
  anti_jammer: (v) => (v
    ? [{ rotulo: 'Anti-jammer ligado', texto: 'JAMMER,ON,0#' }, { rotulo: 'Corte automático no jammer (abaixo de 20 km/h)', texto: 'JAMRELAY,2,180,20,5,5,20,0#' }]
    : [{ rotulo: 'Anti-jammer desligado', texto: 'JAMMER,OFF#' }]),
  fuso: () => [{ rotulo: 'Fuso horário em UTC', texto: 'GMT,W,0,0#' }],
  numero_central: (v) => [{ rotulo: v ? `Número da central ${v}` : 'Número da central apagado', texto: v ? `CENTER,A,${String(v).replace(/\D/g, '')}#` : 'CENTER,D#' }],
  numero_sos: (v) => [{ rotulo: v ? `Número de SOS ${v}` : 'Número de SOS apagado', texto: v ? `SOS,A,${String(v).replace(/\D/g, '')}#` : 'SOS,D#' }],
};
// Só a equipe da plataforma: um erro aqui tira o aparelho do ar.
const AJUSTES_PLATAFORMA = {
  servidor: (v) => [{ rotulo: `Servidor ${v.host}:${v.porta}`, texto: `SERVER,${/^\d+\.\d+\.\d+\.\d+$/.test(v.host) ? 0 : 1},${v.host},${Number(v.porta)},0#` }],
  apn: (v) => [{ rotulo: `APN ${v.apn}`, texto: `APN,${v.apn},${v.usuario ?? ''},${v.senha ?? ''}#` }],
  fabrica: () => [{ rotulo: 'Padrão de fábrica', texto: 'FACTORY#' }],
};
const CONSULTAS = {
  status: { rotulo: 'Consultar estado', texto: 'STATUS#' },
  parametros: { rotulo: 'Consultar configuração', texto: 'PARAM#' },
  completo: { rotulo: 'Consultar configuração completa', texto: 'CXZT' },
  link: { rotulo: 'Pedir link do mapa', texto: 'URL#' },
  reiniciar: { rotulo: 'Reiniciar o aparelho', texto: 'RESET#' },
};

/**
 * Lê a resposta de STATUS#, PARAM# e CXZT e devolve os campos conhecidos (bateria, sinal, GPS, ignição, intervalos, firmware).
 * Ex.: "Battery:4.23V;GPRS:Online;GSMSignal Level:25;ACC:OFF;GPS:OFF;Defense:ON;" ou "J16_MASC_SA_B38_4.41_1-GT06*ID:...*SP:180*...".
 */
function lerResposta(texto) {
  const t = String(texto ?? '');
  const s = {};
  const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : undefined; };
  const pal = (re) => { const m = t.match(re); return m ? m[1].trim() : undefined; };
  s.bateria_v = num(/Battery\s*:\s*([\d.]+)\s*V/i) ?? num(/\*BT:(\d+)/i)?.valueOf();
  if (s.bateria_v && s.bateria_v > 100) s.bateria_v /= 1000;
  s.sinal = num(/GSM\s*Signal\s*Level\s*:\s*(\d+)/i) ?? num(/\*4G:(\d+)/i);
  s.gprs = pal(/GPRS\s*:\s*(\w+)/i);
  s.gps = pal(/GPS\s*:\s*(\w+)/i);
  s.acc = pal(/ACC\s*:\s*(\w+)/i);
  s.corte = pal(/Defense\s*:\s*(\w+)/i);
  const timer = t.match(/TIMER\s*:\s*(\d+)\s*,\s*(\d+)/i);
  if (timer) s.timer = [Number(timer[1]), Number(timer[2])];
  s.hbt = num(/HBT\s*:\s*(\d+)/i);
  const fw = t.match(/^\s*([A-Z0-9_.]+-GT06)/i) || t.match(/VERSION\s*[:\]]\s*([\w.-]+)/i);
  if (fw) s.firmware = fw[1];
  s.servidor = pal(/\*([\w-]+\.[\w.-]+:\d+)\*/);
  for (const k of Object.keys(s)) if (s[k] === undefined || Number.isNaN(s[k])) delete s[k];
  return s;
}

/** Corte e desbloqueio respeitando o sentido do relé da ficha (alguns lotes cortam com RELAY,0#). */
const textoRele = (rastreador, tipo) => {
  const corta = rastreador.rele_invertido ? 'RELAY,0#' : 'RELAY,1#';
  const libera = rastreador.rele_invertido ? 'RELAY,1#' : 'RELAY,0#';
  return tipo === 'bloquear' ? corta : libera;
};

module.exports = { PERFIS, PERSEGUICAO, AJUSTES, AJUSTES_PLATAFORMA, CONSULTAS, lerResposta, textoRele };
