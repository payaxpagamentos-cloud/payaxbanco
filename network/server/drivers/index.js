'use strict';

const { ErroEquipamento } = require('./base');

/*
 * Registro de drivers.
 *
 * Acrescentar um fabricante é acrescentar um arquivo aqui: o núcleo (serviço, fila, reconciliação, corte pela
 * régua) não muda. O que o driver não souber fazer ele deixa de fora de `capacidades`, e o sistema recusa a
 * ação dizendo o que falta em vez de fingir que executou — nenhuma tela diz "aplicado" sem ter aplicado.
 */
const DRIVERS = [
  require('./mikrotik'),
];

const OBRIGATORIOS = ['nome', 'rotulo', 'fabricante', 'papeis', 'capacidades'];
/*
 * Ações da fila de discagem (o sistema abre a conexão com o equipamento). O aparelho do assinante fica de
 * fora de propósito: no TR-069 quem liga é ele, então Wi-Fi e reinício de CPE vivem no ACS, com fila própria.
 */
const ACOES = ['identificar', 'ler', 'aplicar', 'cortar', 'religar', 'remover'];
/** Nome do método que executa cada ação (a ação é snake_case na fila; o método é camelCase no driver). */
const METODO = { identificar: 'identificar', ler: 'ler', aplicar: 'aplicar', cortar: 'cortar', religar: 'religar', remover: 'remover' };

const registro = new Map();
for (const d of DRIVERS) {
  for (const campo of OBRIGATORIOS) {
    if (!d[campo]) throw new Error(`Driver sem "${campo}": ${d.nome ?? '(sem nome)'}`);
  }
  for (const c of d.capacidades) {
    if (!ACOES.includes(c)) throw new Error(`Driver ${d.nome} declara a capacidade desconhecida "${c}".`);
    if (typeof d[METODO[c]] !== 'function') throw new Error(`Driver ${d.nome} declara "${c}" mas não implementa ${METODO[c]}().`);
  }
  if (registro.has(d.nome)) throw new Error(`Dois drivers com o mesmo nome: ${d.nome}`);
  registro.set(d.nome, d);
}

const obter = (nome) => registro.get(String(nome ?? '')) ?? null;

/** Driver do equipamento, com a mensagem certa quando ele não está configurado ou o nome não existe mais. */
function exigirDriver(equipamento) {
  if (!equipamento?.driver) {
    throw new ErroEquipamento(`O equipamento ${equipamento?.nome ?? ''} ainda não tem driver escolhido: defina o fabricante e o acesso de gerência.`, 'nao_configurado', { permanente: true });
  }
  const d = obter(equipamento.driver);
  if (!d) throw new ErroEquipamento(`O driver "${equipamento.driver}" não existe nesta versão do sistema.`, 'incompativel', { permanente: true });
  return d;
}

/** O driver sabe executar esta ação? Devolve o motivo quando não sabe, para a fila registrar "sem suporte". */
function suporta(driver, acao) {
  if (!ACOES.includes(acao)) return { pode: false, motivo: `Ação desconhecida: ${acao}.` };
  if (!driver.capacidades.includes(acao)) {
    return { pode: false, motivo: `${driver.rotulo} não faz "${acao}" por este caminho de gerência. O driver cobre: ${driver.capacidades.join(', ')}.` };
  }
  return { pode: true };
}

/** Lista para a interface: o que existe, para que serve e quais campos de acesso cada um pede. */
const catalogo = () => [...registro.values()].map((d) => ({
  nome: d.nome, rotulo: d.rotulo, fabricante: d.fabricante, papeis: d.papeis, capacidades: d.capacidades,
  protocolo: d.protocolo ?? null, porta_padrao: d.portaPadrao ?? null, campos: d.campos ?? [], ajuda: d.ajuda ?? null,
}));

/** Drivers que servem para um papel (concentrador, olt, acs). */
const porPapel = (papel) => catalogo().filter((d) => d.papeis.includes(papel));

module.exports = { obter, exigirDriver, suporta, catalogo, porPapel, ACOES, METODO };
