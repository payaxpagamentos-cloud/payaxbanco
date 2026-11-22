'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Gestão de Frota (módulo vendido à parte): ordens de serviço, plano preventivo por componente (óleo, filtros, pastilhas,
 * suspensão, correias, bateria...), pneus um a um (posição, rodízio, sulco, recapagem, custo por km), documentos com
 * vencimento, fornecedores e o custo total por km. O diferencial: o desgaste sai do km REAL do rastreador (hodômetro do GPS),
 * sem ninguém digitar a quilometragem.
 */
const { transacao, agora } = require('../db');
const v = require('./validacao');
const { ErroNegocio } = require('./erros');
const { hoje, somarDias, intervalo } = require('./datas');

const TIPOS_FORNECEDOR = {
  oficina: 'Oficina mecânica', autopecas: 'Autopeças', borracharia: 'Borracharia', concessionaria: 'Concessionária',
  eletrica: 'Auto elétrica', funilaria: 'Funilaria e pintura', posto: 'Posto de combustível', despachante: 'Despachante', outro: 'Outro',
};

// Catálogo de componentes com a vida útil de referência para veículo leve (km e/ou dias). O gestor ajusta por veículo.
const COMPONENTES = {
  oleo_motor: { nome: 'Óleo do motor', grupo: 'Motor', km: 10000, dias: 365 },
  filtro_oleo: { nome: 'Filtro de óleo', grupo: 'Motor', km: 10000, dias: 365 },
  filtro_ar: { nome: 'Filtro de ar do motor', grupo: 'Motor', km: 15000, dias: 365 },
  filtro_combustivel: { nome: 'Filtro de combustível', grupo: 'Motor', km: 20000, dias: 730 },
  velas: { nome: 'Velas de ignição', grupo: 'Motor', km: 30000 },
  correia_dentada: { nome: 'Correia dentada e tensor', grupo: 'Motor', km: 60000, dias: 1460 },
  correia_acessorios: { nome: 'Correia de acessórios', grupo: 'Motor', km: 50000, dias: 1460 },
  arrefecimento: { nome: 'Água do radiador (aditivo)', grupo: 'Motor', km: 40000, dias: 730 },
  embreagem: { nome: 'Kit de embreagem', grupo: 'Transmissão', km: 100000 },
  oleo_cambio: { nome: 'Óleo do câmbio', grupo: 'Transmissão', km: 60000 },
  relacao: { nome: 'Kit relação (corrente, coroa e pinhão)', grupo: 'Transmissão', km: 20000 },
  pastilha_dianteira: { nome: 'Pastilhas de freio dianteiras', grupo: 'Freios', km: 30000 },
  pastilha_traseira: { nome: 'Pastilhas ou lonas traseiras', grupo: 'Freios', km: 40000 },
  disco_dianteiro: { nome: 'Discos de freio dianteiros', grupo: 'Freios', km: 60000 },
  disco_traseiro: { nome: 'Discos ou tambores traseiros', grupo: 'Freios', km: 80000 },
  fluido_freio: { nome: 'Fluido de freio', grupo: 'Freios', dias: 730 },
  amortecedor_dianteiro: { nome: 'Amortecedores dianteiros', grupo: 'Suspensão', km: 60000 },
  amortecedor_traseiro: { nome: 'Amortecedores traseiros', grupo: 'Suspensão', km: 60000 },
  suspensao: { nome: 'Suspensão (bandeja, pivô, bieleta e buchas)', grupo: 'Suspensão', km: 60000 },
  alinhamento: { nome: 'Alinhamento e balanceamento', grupo: 'Pneus', km: 10000, dias: 180 },
  bateria: { nome: 'Bateria', grupo: 'Elétrica', dias: 1095 },
  filtro_cabine: { nome: 'Filtro do ar-condicionado', grupo: 'Conforto', km: 15000, dias: 365 },
  palhetas: { nome: 'Palhetas do limpador', grupo: 'Conforto', dias: 365 },
  outro: { nome: 'Outro', grupo: 'Outros' },
};
// Plano preventivo padrão por tipo de veículo (o que se aplica de uma vez). Pesados: intervalos maiores no motor.
const PLANOS = {
  leve: ['oleo_motor', 'filtro_oleo', 'filtro_ar', 'filtro_combustivel', 'filtro_cabine', 'velas', 'correia_dentada', 'correia_acessorios', 'arrefecimento',
    'pastilha_dianteira', 'pastilha_traseira', 'disco_dianteiro', 'disco_traseiro', 'fluido_freio', 'amortecedor_dianteiro', 'amortecedor_traseiro', 'suspensao', 'alinhamento',
    'bateria', 'palhetas', 'embreagem', 'oleo_cambio'],
  moto: ['oleo_motor', 'filtro_oleo', 'filtro_ar', 'velas', 'relacao', 'pastilha_dianteira', 'pastilha_traseira', 'disco_dianteiro', 'disco_traseiro', 'fluido_freio', 'bateria'],
  pesado: ['oleo_motor', 'filtro_oleo', 'filtro_ar', 'filtro_combustivel', 'arrefecimento', 'correia_acessorios', 'pastilha_dianteira', 'pastilha_traseira', 'disco_dianteiro', 'disco_traseiro',
    'fluido_freio', 'amortecedor_dianteiro', 'amortecedor_traseiro', 'suspensao', 'alinhamento', 'bateria', 'embreagem', 'oleo_cambio'],
};
const AJUSTE_PLANO = {
  moto: { oleo_motor: { km: 4000, dias: 180 }, filtro_oleo: { km: 8000 }, filtro_ar: { km: 10000 }, velas: { km: 10000 }, pastilha_dianteira: { km: 15000 },
    pastilha_traseira: { km: 20000 }, disco_dianteiro: { km: 40000 }, disco_traseiro: { km: 50000 } },
  pesado: { oleo_motor: { km: 20000 }, filtro_oleo: { km: 20000 }, filtro_ar: { km: 40000 }, filtro_combustivel: { km: 40000 }, pastilha_dianteira: { km: 60000 },
    pastilha_traseira: { km: 80000 }, embreagem: { km: 200000 }, oleo_cambio: { km: 120000 } },
};
const familia = (tipoVeiculo) => (tipoVeiculo === 'moto' ? 'moto' : ['caminhao', 'onibus', 'maquina'].includes(tipoVeiculo) ? 'pesado' : 'leve');

// Posições dos pneus por tipo de veículo (código, nome). Duplos: E = externo, I = interno.
const POS = (cod, nome) => [cod, nome];
const POSICOES = {
  leve: [POS('DE', 'Dianteiro esquerdo'), POS('DD', 'Dianteiro direito'), POS('TE', 'Traseiro esquerdo'), POS('TD', 'Traseiro direito'), POS('EST', 'Estepe')],
  moto: [POS('D', 'Dianteiro'), POS('T', 'Traseiro')],
  onibus: [POS('1E', '1º eixo esquerdo'), POS('1D', '1º eixo direito'), POS('2EE', '2º eixo esquerdo externo'), POS('2EI', '2º eixo esquerdo interno'),
    POS('2DI', '2º eixo direito interno'), POS('2DE', '2º eixo direito externo'), POS('EST', 'Estepe')],
  caminhao: [POS('1E', '1º eixo esquerdo'), POS('1D', '1º eixo direito'), POS('2EE', '2º eixo esquerdo externo'), POS('2EI', '2º eixo esquerdo interno'),
    POS('2DI', '2º eixo direito interno'), POS('2DE', '2º eixo direito externo'), POS('3EE', '3º eixo esquerdo externo'), POS('3EI', '3º eixo esquerdo interno'),
    POS('3DI', '3º eixo direito interno'), POS('3DE', '3º eixo direito externo'), POS('EST', 'Estepe')],
};
const posicoesDe = (tipoVeiculo) => POSICOES[tipoVeiculo === 'moto' ? 'moto' : tipoVeiculo === 'caminhao' ? 'caminhao' : tipoVeiculo === 'onibus' ? 'onibus' : 'leve'];

const TIPOS_DOCUMENTO = {
  ipva: 'IPVA', licenciamento: 'Licenciamento (CRLV)', seguro: 'Seguro do veículo', tacografo: 'Aferição do tacógrafo', antt: 'Registro ANTT (RNTRC)',
  vistoria: 'Vistoria / inspeção', extintor: 'Extintor', cnh: 'CNH do motorista', exame: 'Exame toxicológico / ASO', outro: 'Outro',
};
const SULCO_ATENCAO_MM = 3;
const SULCO_LIMITE_MM = 1.6; // limite legal (Contran)
const ATENCAO_PCT = 0.85;

// ---------- Apoio ----------
const kmDe = (veiculo) => Math.round((veiculo?.hodometro_m ?? 0) / 1000);
function veiculoDa(db, empresaId, id) {
  const x = db.prepare('SELECT * FROM veiculos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!x) throw new ErroNegocio('Veículo não encontrado.', 404);
  return x;
}
const umDa = (tabela, nome) => (db, empresaId, id) => {
  const x = db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(Number(id), empresaId);
  if (!x) throw new ErroNegocio(`${nome} não encontrado.`, 404);
  return x;
};
const osDa = umDa('frota_os', 'Ordem de serviço');
const componenteDa = umDa('frota_componentes', 'Componente');
const pneuDa = umDa('frota_pneus', 'Pneu');
const documentoDa = umDa('frota_documentos', 'Documento');
const fornecedorDa = umDa('frota_fornecedores', 'Fornecedor');
const centavos = (x, nome) => (x === undefined || x === null || x === '' ? 0 : v.inteiro(x, nome, { min: 0, max: 100_000_000_00 }));
const dataOuHoje = (x, nome) => (x ? v.data(String(x).slice(0, 10), nome) : hoje());
const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Média de km por dia do veículo nos últimos 30 dias (para prever a data de vencimento por km). */
function kmPorDia(db, veiculoId) {
  const r = db.prepare('SELECT COALESCE(SUM(distancia_m), 0) AS m FROM uso_diario WHERE veiculo_id = ? AND data >= ?').get(veiculoId, somarDias(hoje(), -30));
  return r.m / 1000 / 30;
}

// ---------- Componentes (plano preventivo) ----------
/** Quanto da vida já foi usada, quanto falta e quando vence (pela média de km/dia do veículo). */
function situacaoComponente(c, kmAtual, mediaDia, dia = hoje()) {
  const usadoKm = Math.max(0, kmAtual - c.instalado_km);
  const usadoDias = Math.max(0, diasEntre(c.instalado_em.slice(0, 10), dia));
  const pctKm = c.vida_km ? usadoKm / c.vida_km : 0;
  const pctDias = c.vida_dias ? usadoDias / c.vida_dias : 0;
  const pct = Math.max(pctKm, pctDias);
  const restanteKm = c.vida_km ? c.vida_km - usadoKm : null;
  const venceKmEm = c.vida_km && mediaDia > 0.5 ? somarDias(dia, Math.max(0, Math.round(restanteKm / mediaDia))) : null;
  const venceDiaEm = c.vida_dias ? somarDias(c.instalado_em.slice(0, 10), c.vida_dias) : null;
  const previsao = [venceKmEm, venceDiaEm].filter(Boolean).sort()[0] ?? null;
  return {
    usado_km: usadoKm, usado_dias: usadoDias, pct: Math.round(pct * 1000) / 10, restante_km: restanteKm,
    proxima_km: c.vida_km ? c.instalado_km + c.vida_km : null, previsao,
    estado: pct >= 1 ? 'vencido' : pct >= ATENCAO_PCT ? 'atencao' : 'ok',
  };
}

function listarComponentes(db, empresaId, { veiculoId } = {}) {
  const onde = ["c.empresa_id = ?", "c.status = 'ativo'"];
  const p = [empresaId];
  if (veiculoId) { onde.push('c.veiculo_id = ?'); p.push(Number(veiculoId)); }
  const lista = db.prepare(`SELECT c.*, v.placa, v.descricao AS veiculo, v.tipo AS veiculo_tipo, v.hodometro_m FROM frota_componentes c JOIN veiculos v ON v.id = c.veiculo_id
    WHERE ${onde.join(' AND ')} ORDER BY v.placa, c.id`).all(...p);
  const medias = new Map();
  const dia = hoje();
  return lista.map((c) => {
    if (!medias.has(c.veiculo_id)) medias.set(c.veiculo_id, kmPorDia(db, c.veiculo_id));
    const { hodometro_m: hm, ...resto } = c;
    return { ...resto, km_atual: Math.round(hm / 1000), grupo: COMPONENTES[c.tipo]?.grupo ?? 'Outros', ...situacaoComponente(c, Math.round(hm / 1000), medias.get(c.veiculo_id), dia) };
  }).sort((a, b) => b.pct - a.pct);
}

function dadosComponente(d, atual) {
  const tipo = d.tipo !== undefined ? v.opcao(String(d.tipo), 'o tipo de componente', Object.keys(COMPONENTES)) : atual?.tipo ?? 'outro';
  const nome = d.nome !== undefined && String(d.nome).trim() ? v.texto(d.nome, 'o nome', 80) : atual?.nome ?? COMPONENTES[tipo].nome;
  const vidaKm = d.vida_km !== undefined ? (d.vida_km === '' || d.vida_km === null ? null : v.inteiro(d.vida_km, 'a vida útil em km', { min: 1, max: 2_000_000 })) : atual?.vida_km ?? null;
  const vidaDias = d.vida_dias !== undefined ? (d.vida_dias === '' || d.vida_dias === null ? null : v.inteiro(d.vida_dias, 'a vida útil em dias', { min: 1, max: 7300 })) : atual?.vida_dias ?? null;
  v.exigir(vidaKm || vidaDias, 'Informe a vida útil em km, em dias ou nos dois.');
  return {
    tipo, nome, vida_km: vidaKm, vida_dias: vidaDias,
    posicao: d.posicao !== undefined ? v.opcional(d.posicao, 'a posição', 40) : atual?.posicao ?? null,
    marca: d.marca !== undefined ? v.opcional(d.marca, 'a marca', 60) : atual?.marca ?? null,
    custo_centavos: d.custo_centavos !== undefined ? centavos(d.custo_centavos, 'o custo') : atual?.custo_centavos ?? 0,
  };
}

function criarComponente(db, empresaId, d) {
  const veiculo = veiculoDa(db, empresaId, d.veiculo_id);
  const x = dadosComponente(d);
  const instaladoKm = d.instalado_km === undefined || d.instalado_km === '' || d.instalado_km === null ? kmDe(veiculo) : v.inteiro(d.instalado_km, 'o km da instalação', { max: 10_000_000 });
  const instaladoEm = dataOuHoje(d.instalado_em, 'a data da instalação');
  return Number(db.prepare(`INSERT INTO frota_componentes (empresa_id, veiculo_id, tipo, nome, posicao, marca, vida_km, vida_dias, instalado_km, instalado_em, custo_centavos, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, veiculo.id, x.tipo, x.nome, x.posicao, x.marca, x.vida_km, x.vida_dias, instaladoKm, instaladoEm, x.custo_centavos, agora()).lastInsertRowid);
}

function editarComponente(db, empresaId, id, d) {
  const c = componenteDa(db, empresaId, id);
  v.exigir(c.status === 'ativo', 'Este componente já foi trocado: o histórico não muda.');
  const x = dadosComponente(d, c);
  const instaladoKm = d.instalado_km !== undefined && d.instalado_km !== '' ? v.inteiro(d.instalado_km, 'o km da instalação', { max: 10_000_000 }) : c.instalado_km;
  const instaladoEm = d.instalado_em ? v.data(String(d.instalado_em).slice(0, 10), 'a data da instalação') : c.instalado_em;
  db.prepare(`UPDATE frota_componentes SET tipo = ?, nome = ?, posicao = ?, marca = ?, vida_km = ?, vida_dias = ?, instalado_km = ?, instalado_em = ?, custo_centavos = ?, aviso_enviado = 0
    WHERE id = ?`).run(x.tipo, x.nome, x.posicao, x.marca, x.vida_km, x.vida_dias, instaladoKm, instaladoEm, x.custo_centavos, c.id);
}

/** Plano preventivo padrão no veículo: cria os componentes do tipo dele que ainda não existem (instalados no km de hoje). */
function aplicarPlano(db, empresaId, veiculoId) {
  const veiculo = veiculoDa(db, empresaId, veiculoId);
  const fam = familia(veiculo.tipo);
  const existentes = new Set(db.prepare("SELECT tipo FROM frota_componentes WHERE veiculo_id = ? AND status = 'ativo'").all(veiculo.id).map((x) => x.tipo));
  let n = 0;
  transacao(db, () => {
    for (const tipo of PLANOS[fam]) {
      if (existentes.has(tipo)) continue;
      const base = { ...COMPONENTES[tipo], ...(AJUSTE_PLANO[fam]?.[tipo] ?? {}) };
      criarComponente(db, empresaId, { veiculo_id: veiculo.id, tipo, vida_km: base.km ?? null, vida_dias: base.dias ?? null });
      n++;
    }
  });
  return n;
}

/** Troca o componente: o atual vira histórico e nasce um novo, igual, instalado agora (km e data da troca). */
function trocarComponente(db, c, { km, data, custo = 0, osId = null, marca }) {
  db.prepare("UPDATE frota_componentes SET status = 'trocado', trocado_em = ?, trocado_km = ?, os_id = COALESCE(?, os_id) WHERE id = ?").run(data, km, osId, c.id);
  return Number(db.prepare(`INSERT INTO frota_componentes (empresa_id, veiculo_id, tipo, nome, posicao, marca, vida_km, vida_dias, instalado_km, instalado_em, custo_centavos, os_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.empresa_id, c.veiculo_id, c.tipo, c.nome, c.posicao, marca ?? c.marca, c.vida_km, c.vida_dias, km, data, custo, osId, agora()).lastInsertRowid);
}

function historicoComponentes(db, empresaId, veiculoId) {
  return db.prepare(`SELECT c.*, o.numero AS os_numero FROM frota_componentes c LEFT JOIN frota_os o ON o.id = c.os_id
    WHERE c.empresa_id = ? AND c.veiculo_id = ? AND c.status = 'trocado' ORDER BY c.trocado_em DESC, c.id DESC LIMIT 200`).all(empresaId, Number(veiculoId));
}

// ---------- Ordens de serviço ----------
const STATUS_OS = ['aberta', 'em_execucao', 'concluida', 'cancelada'];
function totalOS(db, osId) {
  const t = db.prepare('SELECT COALESCE(SUM(ROUND(quantidade * valor_centavos)), 0) AS t FROM frota_os_itens WHERE os_id = ?').get(osId).t;
  db.prepare('UPDATE frota_os SET total_centavos = ? WHERE id = ?').run(t, osId);
  return t;
}

function dadosItem(d) {
  return {
    tipo: v.opcao(d.tipo ?? 'peca', 'o tipo do item', ['peca', 'servico']),
    descricao: v.texto(d.descricao, 'a descrição do item', 160),
    quantidade: d.quantidade === undefined || d.quantidade === '' ? 1 : v.numero(d.quantidade, 'a quantidade', { min: 0.001, max: 100000 }),
    valor_centavos: centavos(d.valor_centavos, 'o valor do item'),
  };
}

function criarOS(db, empresaId, d, usuarioId) {
  const veiculo = veiculoDa(db, empresaId, d.veiculo_id);
  const tipo = v.opcao(d.tipo ?? 'corretiva', 'o tipo da OS', ['preventiva', 'corretiva', 'inspecao']);
  const prioridade = v.opcao(d.prioridade ?? 'media', 'a prioridade', ['baixa', 'media', 'alta', 'urgente']);
  const origem = v.opcao(d.origem ?? 'manual', 'a origem', ['manual', 'plano', 'avaria', 'checklist', 'pneu', 'motorista']);
  const descricao = v.texto(d.descricao, 'a descrição', 300);
  const fornecedor = d.fornecedor_id ? fornecedorDa(db, empresaId, d.fornecedor_id).id : null;
  const kmAbertura = d.km_abertura !== undefined && d.km_abertura !== '' && d.km_abertura !== null ? v.inteiro(d.km_abertura, 'o km', { max: 10_000_000 }) : kmDe(veiculo);
  const previsao = d.previsao ? v.data(String(d.previsao).slice(0, 10), 'a previsão') : null;
  const componentes = Array.isArray(d.componentes) ? d.componentes.map((id) => componenteDa(db, empresaId, id)) : [];
  for (const c of componentes) v.exigir(c.veiculo_id === veiculo.id && c.status === 'ativo', 'Componente de outro veículo ou já trocado.');
  if (origem === 'avaria' && d.origem_id) {
    const a = db.prepare('SELECT id FROM avarias WHERE id = ? AND empresa_id = ?').get(Number(d.origem_id), empresaId);
    v.exigir(a, 'Avaria não encontrada.');
    v.exigir(!db.prepare("SELECT 1 FROM frota_os WHERE origem = 'avaria' AND origem_id = ? AND status <> 'cancelada'").get(a.id), 'Já existe uma OS para esta avaria.');
  }
  return transacao(db, () => {
    const numero = (db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM frota_os WHERE empresa_id = ?').get(empresaId).n) + 1;
    const id = Number(db.prepare(`INSERT INTO frota_os (empresa_id, numero, veiculo_id, tipo, prioridade, descricao, origem, origem_id, fornecedor_id, km_abertura, parado, previsao, aberta_em, observacao, criado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, numero, veiculo.id, tipo, prioridade, descricao, origem, d.origem_id ? Number(d.origem_id) : null, fornecedor,
      kmAbertura, v.booleano(d.parado) ? 1 : 0, previsao, agora(), v.opcional(d.observacao, 'a observação', 500), usuarioId ?? null).lastInsertRowid);
    // Componentes do plano já entram como peças (troca ao concluir).
    for (const c of componentes) {
      db.prepare("INSERT INTO frota_os_itens (os_id, tipo, descricao, quantidade, valor_centavos, componente_id, criado_em) VALUES (?, 'peca', ?, 1, ?, ?, ?)")
        .run(id, c.nome, c.custo_centavos || 0, c.id, agora());
    }
    for (const it of Array.isArray(d.itens) ? d.itens : []) {
      const x = dadosItem(it);
      db.prepare('INSERT INTO frota_os_itens (os_id, tipo, descricao, quantidade, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?, ?)').run(id, x.tipo, x.descricao, x.quantidade, x.valor_centavos, agora());
    }
    if (origem === 'avaria' && d.origem_id) db.prepare("UPDATE avarias SET status = 'em_andamento' WHERE id = ? AND status = 'aberta'").run(Number(d.origem_id));
    totalOS(db, id);
    return { id, numero };
  });
}

const editavel = (os) => v.exigir(os.status === 'aberta' || os.status === 'em_execucao', 'Esta OS já foi encerrada.');

function editarOS(db, empresaId, id, d) {
  const os = osDa(db, empresaId, id);
  editavel(os);
  const campos = {
    descricao: d.descricao !== undefined ? v.texto(d.descricao, 'a descrição', 300) : os.descricao,
    tipo: d.tipo !== undefined ? v.opcao(d.tipo, 'o tipo da OS', ['preventiva', 'corretiva', 'inspecao']) : os.tipo,
    prioridade: d.prioridade !== undefined ? v.opcao(d.prioridade, 'a prioridade', ['baixa', 'media', 'alta', 'urgente']) : os.prioridade,
    fornecedor_id: d.fornecedor_id !== undefined ? (d.fornecedor_id ? fornecedorDa(db, empresaId, d.fornecedor_id).id : null) : os.fornecedor_id,
    previsao: d.previsao !== undefined ? (d.previsao ? v.data(String(d.previsao).slice(0, 10), 'a previsão') : null) : os.previsao,
    parado: d.parado !== undefined ? (v.booleano(d.parado) ? 1 : 0) : os.parado,
    observacao: d.observacao !== undefined ? v.opcional(d.observacao, 'a observação', 500) : os.observacao,
  };
  db.prepare('UPDATE frota_os SET descricao = ?, tipo = ?, prioridade = ?, fornecedor_id = ?, previsao = ?, parado = ?, observacao = ? WHERE id = ?')
    .run(campos.descricao, campos.tipo, campos.prioridade, campos.fornecedor_id, campos.previsao, campos.parado, campos.observacao, os.id);
}

function adicionarItem(db, empresaId, osId, d) {
  const os = osDa(db, empresaId, osId);
  editavel(os);
  const x = dadosItem(d);
  let componente = null;
  if (d.componente_id) {
    const c = componenteDa(db, empresaId, d.componente_id);
    v.exigir(c.veiculo_id === os.veiculo_id && c.status === 'ativo', 'Componente de outro veículo ou já trocado.');
    v.exigir(!db.prepare('SELECT 1 FROM frota_os_itens WHERE os_id = ? AND componente_id = ?').get(os.id, c.id), `${c.nome} já está nesta OS.`);
    componente = c.id;
  }
  return transacao(db, () => {
    const id = Number(db.prepare('INSERT INTO frota_os_itens (os_id, tipo, descricao, quantidade, valor_centavos, componente_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(os.id, x.tipo, x.descricao, x.quantidade, x.valor_centavos, componente, agora()).lastInsertRowid);
    totalOS(db, os.id);
    return id;
  });
}

function removerItem(db, empresaId, osId, itemId) {
  const os = osDa(db, empresaId, osId);
  editavel(os);
  transacao(db, () => {
    const r = db.prepare('DELETE FROM frota_os_itens WHERE id = ? AND os_id = ?').run(Number(itemId), os.id);
    v.exigir(r.changes, 'Item não encontrado.');
    totalOS(db, os.id);
  });
}

function iniciarOS(db, empresaId, id) {
  const os = osDa(db, empresaId, id);
  v.exigir(os.status === 'aberta', 'Só uma OS aberta pode ser iniciada.');
  db.prepare("UPDATE frota_os SET status = 'em_execucao', iniciada_em = ? WHERE id = ?").run(agora(), os.id);
}

/**
 * Conclui a OS: cada peça ligada a um componente do plano troca o componente (o contador de vida recomeça no km da conclusão),
 * a avaria de origem fica resolvida e o veículo volta a ficar disponível.
 */
function concluirOS(db, empresaId, id, d, usuarioId) {
  const os = osDa(db, empresaId, id);
  editavel(os);
  const veiculo = veiculoDa(db, empresaId, os.veiculo_id);
  const km = d.km_conclusao !== undefined && d.km_conclusao !== '' && d.km_conclusao !== null ? v.inteiro(d.km_conclusao, 'o km da conclusão', { max: 10_000_000 }) : kmDe(veiculo);
  const data = dataOuHoje(d.data, 'a data da conclusão');
  return transacao(db, () => {
    const itens = db.prepare('SELECT * FROM frota_os_itens WHERE os_id = ?').all(os.id);
    let trocados = 0;
    for (const it of itens.filter((x) => x.componente_id)) {
      const c = db.prepare("SELECT * FROM frota_componentes WHERE id = ? AND status = 'ativo'").get(it.componente_id);
      if (!c) continue;
      const novo = trocarComponente(db, c, { km, data, custo: Math.round(it.quantidade * it.valor_centavos), osId: os.id });
      db.prepare('UPDATE frota_os_itens SET componente_id = ? WHERE id = ?').run(novo, it.id);
      trocados++;
    }
    db.prepare("UPDATE frota_os SET status = 'concluida', km_conclusao = ?, concluida_em = ?, parado = 0, observacao = COALESCE(?, observacao) WHERE id = ?")
      .run(km, `${data}T${agora().slice(11)}`, v.opcional(d.observacao, 'a observação', 500), os.id);
    if (os.origem === 'avaria' && os.origem_id) {
      db.prepare("UPDATE avarias SET status = 'resolvida', resolvida_em = ?, resolvida_por = ? WHERE id = ? AND empresa_id = ?").run(agora(), usuarioId ?? null, os.origem_id, empresaId);
    }
    return { total_centavos: totalOS(db, os.id), componentes_trocados: trocados };
  });
}

function cancelarOS(db, empresaId, id) {
  const os = osDa(db, empresaId, id);
  editavel(os);
  transacao(db, () => {
    db.prepare("UPDATE frota_os SET status = 'cancelada', parado = 0, concluida_em = ? WHERE id = ?").run(agora(), os.id);
    if (os.origem === 'avaria' && os.origem_id) db.prepare("UPDATE avarias SET status = 'aberta' WHERE id = ? AND status = 'em_andamento'").run(os.origem_id);
  });
}

function listarOS(db, empresaId, { status, veiculoId } = {}) {
  const onde = ['o.empresa_id = ?'];
  const p = [empresaId];
  if (status === 'abertas') onde.push("o.status IN ('aberta','em_execucao')");
  else if (status && STATUS_OS.includes(status)) { onde.push('o.status = ?'); p.push(status); }
  if (veiculoId) { onde.push('o.veiculo_id = ?'); p.push(Number(veiculoId)); }
  return db.prepare(`SELECT o.*, v.placa, v.descricao AS veiculo, f.nome AS fornecedor, (SELECT COUNT(*) FROM frota_os_itens i WHERE i.os_id = o.id) AS itens
    FROM frota_os o JOIN veiculos v ON v.id = o.veiculo_id LEFT JOIN frota_fornecedores f ON f.id = o.fornecedor_id
    WHERE ${onde.join(' AND ')} ORDER BY CASE WHEN o.status IN ('aberta','em_execucao') THEN 0 ELSE 1 END,
      CASE o.prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, o.numero DESC LIMIT 500`).all(...p);
}

function detalheOS(db, empresaId, id) {
  const os = osDa(db, empresaId, id);
  const v2 = db.prepare('SELECT placa, descricao, tipo, hodometro_m FROM veiculos WHERE id = ?').get(os.veiculo_id);
  return {
    ...os, placa: v2.placa, veiculo: v2.descricao, km_atual: kmDe(v2),
    fornecedor: os.fornecedor_id ? db.prepare('SELECT nome FROM frota_fornecedores WHERE id = ?').get(os.fornecedor_id)?.nome : null,
    itens: db.prepare('SELECT * FROM frota_os_itens WHERE os_id = ? ORDER BY id').all(os.id),
    componentes_disponiveis: listarComponentes(db, empresaId, { veiculoId: os.veiculo_id }).map((c) => ({ id: c.id, nome: c.nome, posicao: c.posicao, pct: c.pct, estado: c.estado })),
    avaria: os.origem === 'avaria' && os.origem_id ? db.prepare('SELECT descricao, gravidade, criado_em FROM avarias WHERE id = ?').get(os.origem_id) : null,
  };
}

// ---------- Pneus ----------
const kmDoPneu = (p, kmVeiculo) => p.km_rodado + (p.status === 'montado' && p.montado_km !== null ? Math.max(0, kmVeiculo - p.montado_km) : 0);
function evento(db, p, tipo, extra = {}) {
  db.prepare(`INSERT INTO frota_pneu_eventos (pneu_id, empresa_id, tipo, veiculo_id, posicao, km_veiculo, km_pneu, sulco_mm, custo_centavos, observacao, criado_por, motorista_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.empresa_id, tipo, extra.veiculo_id ?? p.veiculo_id ?? null, extra.posicao ?? p.posicao ?? null, extra.km_veiculo ?? null,
    extra.km_pneu ?? null, extra.sulco_mm ?? null, extra.custo_centavos ?? 0, extra.observacao ?? null, extra.usuario_id ?? null, extra.motorista_id ?? null, agora());
}

/** O último veículo em que o pneu rodou: a recapagem e o conserto entram no custo dele (foi ele que gastou o pneu). */
const ultimoVeiculo = (db, p) => p.veiculo_id ?? db.prepare('SELECT veiculo_id FROM frota_pneu_eventos WHERE pneu_id = ? AND veiculo_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(p.id)?.veiculo_id ?? null;

function estadoPneu(p) {
  if (p.sulco_mm === null || p.sulco_mm === undefined) return 'sem_medicao';
  return p.sulco_mm <= SULCO_LIMITE_MM ? 'trocar' : p.sulco_mm <= SULCO_ATENCAO_MM ? 'atencao' : 'ok';
}

function listarPneus(db, empresaId, { status, veiculoId } = {}) {
  const onde = ['p.empresa_id = ?'];
  const par = [empresaId];
  if (status) { onde.push('p.status = ?'); par.push(status); } else onde.push("p.status <> 'descartado'");
  if (veiculoId) { onde.push('p.veiculo_id = ?'); par.push(Number(veiculoId)); }
  const custos = db.prepare("SELECT COALESCE(SUM(custo_centavos), 0) AS c FROM frota_pneu_eventos WHERE pneu_id = ? AND tipo IN ('recapagem','conserto')");
  return db.prepare(`SELECT p.*, v.placa, v.hodometro_m FROM frota_pneus p LEFT JOIN veiculos v ON v.id = p.veiculo_id WHERE ${onde.join(' AND ')} ORDER BY v.placa, p.posicao, p.numero_fogo`)
    .all(...par).map((p) => {
      const kmPneu = kmDoPneu(p, Math.round((p.hodometro_m ?? 0) / 1000));
      const custoTotal = p.custo_centavos + custos.get(p.id).c;
      const { hodometro_m: _h, ...resto } = p;
      // Desgaste por km: quanto de borracha foi usado e quantos km faltam até o limite, na mesma proporção.
      const gasto = p.sulco_novo_mm && p.sulco_mm !== null ? p.sulco_novo_mm - p.sulco_mm : null;
      const kmRestante = gasto > 0.3 && kmPneu > 500 ? Math.max(0, Math.round(((p.sulco_mm - SULCO_LIMITE_MM) / gasto) * kmPneu)) : null;
      return { ...resto, km_pneu: kmPneu, custo_total_centavos: custoTotal, custo_km_centavos: kmPneu > 0 ? Math.round((custoTotal / kmPneu) * 100) / 100 : null,
        km_restante: kmRestante, estado: estadoPneu(p) };
    });
}

function cadastrarPneu(db, empresaId, d, usuarioId) {
  const numero = v.texto(d.numero_fogo, 'o número de fogo', 30).toUpperCase();
  v.exigir(!db.prepare('SELECT 1 FROM frota_pneus WHERE empresa_id = ? AND numero_fogo = ?').get(empresaId, numero), 'Já existe um pneu com este número de fogo.');
  const sulcoNovo = d.sulco_novo_mm === undefined || d.sulco_novo_mm === '' ? null : v.numero(d.sulco_novo_mm, 'o sulco novo', { min: 0, max: 40 });
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO frota_pneus (empresa_id, numero_fogo, marca, modelo, medida, dot, vida, custo_centavos, sulco_novo_mm, sulco_mm, sulco_em, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, numero, v.opcional(d.marca, 'a marca', 60), v.opcional(d.modelo, 'o modelo', 60), v.opcional(d.medida, 'a medida', 30),
      v.opcional(d.dot, 'o DOT', 20), d.vida ? v.inteiro(d.vida, 'a vida', { max: 5 }) : 0, centavos(d.custo_centavos, 'o custo'), sulcoNovo, sulcoNovo, sulcoNovo === null ? null : agora(), agora()).lastInsertRowid);
    const p = db.prepare('SELECT * FROM frota_pneus WHERE id = ?').get(id);
    evento(db, p, 'cadastro', { custo_centavos: 0, sulco_mm: sulcoNovo, usuario_id: usuarioId });
    if (d.veiculo_id && d.posicao) montarPneu(db, empresaId, id, { veiculo_id: d.veiculo_id, posicao: d.posicao }, usuarioId);
    return id;
  });
}

function montarPneu(db, empresaId, id, d, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status === 'estoque', p.status === 'montado' ? 'Este pneu já está montado: desmonte ou use o rodízio.' : 'Só um pneu do estoque pode ser montado.');
  const veiculo = veiculoDa(db, empresaId, d.veiculo_id);
  const posicao = v.opcao(String(d.posicao ?? ''), 'a posição', posicoesDe(veiculo.tipo).map(([c]) => c));
  v.exigir(!db.prepare("SELECT 1 FROM frota_pneus WHERE veiculo_id = ? AND posicao = ? AND status = 'montado'").get(veiculo.id, posicao), 'Já há um pneu nesta posição: desmonte-o antes.');
  const km = kmDe(veiculo);
  transacao(db, () => {
    db.prepare("UPDATE frota_pneus SET status = 'montado', veiculo_id = ?, posicao = ?, montado_km = ? WHERE id = ?").run(veiculo.id, posicao, km, p.id);
    evento(db, { ...p, veiculo_id: veiculo.id, posicao }, 'montagem', { km_veiculo: km, km_pneu: p.km_rodado, usuario_id: usuarioId });
  });
}

function desmontarPneu(db, empresaId, id, d, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status === 'montado', 'Este pneu não está montado.');
  const destino = v.opcao(d.destino ?? 'estoque', 'o destino', ['estoque', 'recapagem', 'descartado']);
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(p.veiculo_id);
  const km = kmDe(veiculo);
  const kmPneu = kmDoPneu(p, km);
  const sulco = d.sulco_mm === undefined || d.sulco_mm === '' || d.sulco_mm === null ? null : v.numero(d.sulco_mm, 'o sulco', { min: 0, max: 40 });
  transacao(db, () => {
    db.prepare(`UPDATE frota_pneus SET status = ?, veiculo_id = NULL, posicao = NULL, montado_km = NULL, km_rodado = ?, sulco_mm = COALESCE(?, sulco_mm),
      sulco_em = CASE WHEN ? IS NULL THEN sulco_em ELSE ? END WHERE id = ?`).run(destino, kmPneu, sulco, sulco, agora(), p.id);
    evento(db, p, 'desmontagem', { km_veiculo: km, km_pneu: kmPneu, sulco_mm: sulco, observacao: v.opcional(d.observacao, 'a observação', 200) ?? `Destino: ${destino}`, usuario_id: usuarioId });
    if (destino === 'descartado') evento(db, { ...p, veiculo_id: null, posicao: null }, 'descarte', { km_pneu: kmPneu, observacao: v.opcional(d.motivo, 'o motivo', 200), usuario_id: usuarioId });
  });
}

/** Rodízio: troca as posições de vários pneus do mesmo veículo de uma vez (o km de cada pneu continua dele). */
function rodizio(db, empresaId, veiculoId, trocas, usuarioId) {
  const veiculo = veiculoDa(db, empresaId, veiculoId);
  v.exigir(Array.isArray(trocas) && trocas.length >= 2 && trocas.length <= 20, 'Escolha os pneus e as novas posições.');
  const validas = posicoesDe(veiculo.tipo).map(([c]) => c);
  const pneus = trocas.map((t) => {
    const p = pneuDa(db, empresaId, t.pneu_id);
    v.exigir(p.status === 'montado' && p.veiculo_id === veiculo.id, 'Pneu fora deste veículo no rodízio.');
    return { p, para: v.opcao(String(t.posicao), 'a posição', validas) };
  });
  v.exigir(new Set(pneus.map((x) => x.para)).size === pneus.length, 'Duas rodas na mesma posição.');
  const saindo = new Set(pneus.map((x) => x.p.posicao));
  for (const x of pneus) {
    if (saindo.has(x.para)) continue;
    v.exigir(!db.prepare("SELECT 1 FROM frota_pneus WHERE veiculo_id = ? AND posicao = ? AND status = 'montado'").get(veiculo.id, x.para), `A posição ${x.para} está ocupada por outro pneu.`);
  }
  const km = kmDe(veiculo);
  transacao(db, () => {
    // Primeiro tira todos da posição (o índice de posição única não deixa trocar dois de uma vez), depois põe cada um no lugar novo.
    for (const x of pneus) db.prepare('UPDATE frota_pneus SET posicao = ? WHERE id = ?').run(`~${x.p.id}`, x.p.id);
    for (const x of pneus) {
      db.prepare('UPDATE frota_pneus SET posicao = ? WHERE id = ?').run(x.para, x.p.id);
      evento(db, { ...x.p, posicao: x.para }, 'rodizio', { km_veiculo: km, km_pneu: kmDoPneu(x.p, km), observacao: `${x.p.posicao} → ${x.para}`, usuario_id: usuarioId });
    }
  });
}

function medirPneu(db, empresaId, id, d, { usuarioId = null, motoristaId = null } = {}) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status !== 'descartado', 'Pneu descartado.');
  const sulco = v.numero(d.sulco_mm, 'o sulco (mm)', { min: 0, max: 40 });
  const km = p.veiculo_id ? kmDe(db.prepare('SELECT hodometro_m FROM veiculos WHERE id = ?').get(p.veiculo_id)) : null;
  transacao(db, () => {
    db.prepare('UPDATE frota_pneus SET sulco_mm = ?, sulco_em = ?, aviso_sulco = CASE WHEN ? > ? THEN 0 ELSE aviso_sulco END WHERE id = ?').run(sulco, agora(), sulco, SULCO_ATENCAO_MM, p.id);
    evento(db, p, 'medicao', { km_veiculo: km, km_pneu: km === null ? p.km_rodado : kmDoPneu(p, km), sulco_mm: sulco, observacao: v.opcional(d.observacao, 'a observação', 200), usuario_id: usuarioId, motorista_id: motoristaId });
  });
  return estadoPneu({ sulco_mm: sulco });
}

/** Recapagem: o pneu volta ao estoque com uma vida a mais, sulco novo e o custo somado ao custo por km. */
function voltarRecapagem(db, empresaId, id, d, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status === 'recapagem', 'Este pneu não está na recapagem.');
  const sulco = d.sulco_mm === undefined || d.sulco_mm === '' ? null : v.numero(d.sulco_mm, 'o sulco novo', { min: 0, max: 40 });
  transacao(db, () => {
    db.prepare("UPDATE frota_pneus SET status = 'estoque', vida = vida + 1, sulco_novo_mm = COALESCE(?, sulco_novo_mm), sulco_mm = COALESCE(?, sulco_mm), sulco_em = ?, aviso_sulco = 0 WHERE id = ?")
      .run(sulco, sulco, agora(), p.id);
    evento(db, p, 'recapagem', { veiculo_id: ultimoVeiculo(db, p), km_pneu: p.km_rodado, sulco_mm: sulco, custo_centavos: centavos(d.custo_centavos, 'o custo'), observacao: v.opcional(d.observacao, 'a observação', 200), usuario_id: usuarioId });
  });
}

function enviarRecapagem(db, empresaId, id, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status === 'estoque', 'Só um pneu do estoque vai para a recapagem (desmonte antes).');
  db.prepare("UPDATE frota_pneus SET status = 'recapagem' WHERE id = ?").run(p.id);
  evento(db, p, 'desmontagem', { km_pneu: p.km_rodado, observacao: 'Enviado para a recapagem', usuario_id: usuarioId });
}

function consertoPneu(db, empresaId, id, d, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status !== 'descartado', 'Pneu descartado.');
  evento(db, p, 'conserto', { veiculo_id: ultimoVeiculo(db, p), custo_centavos: centavos(d.custo_centavos, 'o custo'), observacao: v.texto(d.observacao ?? 'Conserto', 'a descrição', 200), usuario_id: usuarioId });
}

function descartarPneu(db, empresaId, id, d, usuarioId) {
  const p = pneuDa(db, empresaId, id);
  v.exigir(p.status === 'estoque' || p.status === 'recapagem', 'Desmonte o pneu antes de descartar.');
  transacao(db, () => {
    db.prepare("UPDATE frota_pneus SET status = 'descartado' WHERE id = ?").run(p.id);
    evento(db, p, 'descarte', { km_pneu: p.km_rodado, observacao: v.opcional(d.motivo, 'o motivo', 200), usuario_id: usuarioId });
  });
}

function historicoPneu(db, empresaId, id) {
  const p = pneuDa(db, empresaId, id);
  return db.prepare(`SELECT e.*, v.placa, u.nome AS usuario, m.nome AS motorista FROM frota_pneu_eventos e LEFT JOIN veiculos v ON v.id = e.veiculo_id
    LEFT JOIN usuarios u ON u.id = e.criado_por LEFT JOIN motoristas m ON m.id = e.motorista_id WHERE e.pneu_id = ? ORDER BY e.id DESC`).all(p.id);
}

/** As posições do veículo e o pneu de cada uma (para o desenho do veículo). */
function pneusDoVeiculo(db, empresaId, veiculoId) {
  const veiculo = veiculoDa(db, empresaId, veiculoId);
  const montados = new Map(listarPneus(db, empresaId, { status: 'montado', veiculoId: veiculo.id }).map((p) => [p.posicao, p]));
  return { veiculo: { id: veiculo.id, placa: veiculo.placa, tipo: veiculo.tipo, km_atual: kmDe(veiculo) },
    posicoes: posicoesDe(veiculo.tipo).map(([codigo, nome]) => ({ codigo, nome, pneu: montados.get(codigo) ?? null })) };
}

// ---------- Documentos ----------
function situacaoDocumento(d, dia = hoje()) {
  if (d.pago && ['ipva', 'licenciamento'].includes(d.tipo)) return { estado: 'pago', dias: diasEntre(dia, d.vencimento) };
  const dias = diasEntre(dia, d.vencimento);
  return { estado: dias < 0 ? 'vencido' : dias <= 30 ? 'vencendo' : 'ok', dias };
}

function listarDocumentos(db, empresaId) {
  const dia = hoje();
  return db.prepare(`SELECT d.*, v.placa, m.nome AS motorista FROM frota_documentos d LEFT JOIN veiculos v ON v.id = d.veiculo_id LEFT JOIN motoristas m ON m.id = d.motorista_id
    WHERE d.empresa_id = ? ORDER BY d.vencimento`).all(empresaId).map((d) => ({ ...d, nome_tipo: TIPOS_DOCUMENTO[d.tipo] ?? d.tipo, ...situacaoDocumento(d, dia) }));
}

function dadosDocumento(db, empresaId, d, atual) {
  const tipo = d.tipo !== undefined ? v.opcao(String(d.tipo), 'o tipo do documento', Object.keys(TIPOS_DOCUMENTO)) : atual.tipo;
  const deMotorista = ['cnh', 'exame'].includes(tipo);
  const veiculoId = deMotorista ? null : (d.veiculo_id !== undefined ? veiculoDa(db, empresaId, d.veiculo_id).id : atual?.veiculo_id);
  const motoristaId = !deMotorista ? null : (d.motorista_id !== undefined ? (() => {
    const m = db.prepare('SELECT id FROM motoristas WHERE id = ? AND empresa_id = ?').get(Number(d.motorista_id), empresaId);
    v.exigir(m, 'Motorista não encontrado.');
    return m.id;
  })() : atual?.motorista_id);
  v.exigir(deMotorista ? motoristaId : veiculoId, deMotorista ? 'Escolha o motorista.' : 'Escolha o veículo.');
  return {
    tipo, veiculo_id: veiculoId, motorista_id: motoristaId,
    descricao: d.descricao !== undefined ? v.opcional(d.descricao, 'a descrição', 120) : atual?.descricao ?? null,
    numero: d.numero !== undefined ? v.opcional(d.numero, 'o número', 60) : atual?.numero ?? null,
    vencimento: d.vencimento !== undefined ? v.data(String(d.vencimento).slice(0, 10), 'o vencimento') : atual.vencimento,
    valor_centavos: d.valor_centavos !== undefined ? centavos(d.valor_centavos, 'o valor') : atual?.valor_centavos ?? 0,
    pago: d.pago !== undefined ? (v.booleano(d.pago) ? 1 : 0) : atual?.pago ?? 0,
  };
}

function criarDocumento(db, empresaId, d) {
  const x = dadosDocumento(db, empresaId, d, { tipo: undefined });
  return Number(db.prepare(`INSERT INTO frota_documentos (empresa_id, veiculo_id, motorista_id, tipo, descricao, numero, vencimento, valor_centavos, pago, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, x.veiculo_id, x.motorista_id, x.tipo, x.descricao, x.numero, x.vencimento, x.valor_centavos, x.pago, agora()).lastInsertRowid);
}

function editarDocumento(db, empresaId, id, d) {
  const atual = documentoDa(db, empresaId, id);
  const x = dadosDocumento(db, empresaId, d, atual);
  db.prepare(`UPDATE frota_documentos SET veiculo_id = ?, motorista_id = ?, tipo = ?, descricao = ?, numero = ?, vencimento = ?, valor_centavos = ?, pago = ?,
    aviso_enviado = CASE WHEN ? <> vencimento THEN 0 ELSE aviso_enviado END WHERE id = ?`)
    .run(x.veiculo_id, x.motorista_id, x.tipo, x.descricao, x.numero, x.vencimento, x.valor_centavos, x.pago, x.vencimento, atual.id);
}

// ---------- Fornecedores ----------
function listarFornecedores(db, empresaId) {
  return db.prepare(`SELECT f.*, (SELECT COALESCE(SUM(total_centavos), 0) FROM frota_os o WHERE o.fornecedor_id = f.id AND o.status = 'concluida') AS gasto_centavos,
    (SELECT COUNT(*) FROM frota_os o WHERE o.fornecedor_id = f.id AND o.status = 'concluida') AS servicos
    FROM frota_fornecedores f WHERE f.empresa_id = ? AND f.ativo = 1 ORDER BY f.nome`).all(empresaId);
}
function dadosFornecedor(d, atual = {}) {
  return {
    nome: d.nome !== undefined ? v.texto(d.nome, 'o nome', 120) : atual.nome,
    tipo: d.tipo !== undefined ? v.opcao(String(d.tipo), 'o tipo', Object.keys(TIPOS_FORNECEDOR)) : atual.tipo ?? 'oficina',
    telefone: d.telefone !== undefined ? (v.digitos(d.telefone) || null) : atual.telefone ?? null,
    documento: d.documento !== undefined ? (v.digitos(d.documento) || null) : atual.documento ?? null,
    cidade: d.cidade !== undefined ? v.opcional(d.cidade, 'a cidade', 80) : atual.cidade ?? null,
    observacao: d.observacao !== undefined ? v.opcional(d.observacao, 'a observação', 300) : atual.observacao ?? null,
  };
}
function salvarFornecedor(db, empresaId, d, id) {
  if (id) {
    const atual = fornecedorDa(db, empresaId, id);
    const x = dadosFornecedor(d, atual);
    db.prepare('UPDATE frota_fornecedores SET nome = ?, tipo = ?, telefone = ?, documento = ?, cidade = ?, observacao = ? WHERE id = ?').run(x.nome, x.tipo, x.telefone, x.documento, x.cidade, x.observacao, atual.id);
    return atual.id;
  }
  const x = dadosFornecedor(d);
  return Number(db.prepare('INSERT INTO frota_fornecedores (empresa_id, nome, tipo, telefone, documento, cidade, observacao, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(empresaId, x.nome, x.tipo, x.telefone, x.documento, x.cidade, x.observacao, agora()).lastInsertRowid);
}

// ---------- Custos e painel ----------
/** Custo de cada veículo no período: combustível, manutenção (OS), pneus, documentos e multas, e o custo por km rodado. */
function custos(db, empresaId, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  const veiculos = db.prepare('SELECT id, placa, descricao, tipo FROM veiculos WHERE empresa_id = ? AND ativo = 1 ORDER BY placa').all(empresaId);
  const q = {
    km: db.prepare('SELECT COALESCE(SUM(distancia_m), 0) AS m FROM uso_diario WHERE veiculo_id = ? AND data BETWEEN ? AND ?'),
    combustivel: db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS c FROM abastecimentos WHERE veiculo_id = ? AND criado_em >= ? AND criado_em < ?'),
    manutencao: db.prepare("SELECT COALESCE(SUM(total_centavos), 0) AS c FROM frota_os WHERE veiculo_id = ? AND status = 'concluida' AND concluida_em >= ? AND concluida_em < ?"),
    // Pneu novo entra no custo do veículo onde foi montado pela primeira vez (km do pneu = 0).
    pneusCompra: db.prepare("SELECT COALESCE(SUM(p.custo_centavos), 0) AS c FROM frota_pneu_eventos e JOIN frota_pneus p ON p.id = e.pneu_id WHERE e.veiculo_id = ? AND e.tipo = 'montagem' AND e.km_pneu = 0 AND e.criado_em >= ? AND e.criado_em < ?"),
    pneusServ: db.prepare("SELECT COALESCE(SUM(custo_centavos), 0) AS c FROM frota_pneu_eventos WHERE veiculo_id = ? AND tipo IN ('recapagem','conserto') AND criado_em >= ? AND criado_em < ?"),
    documentos: db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS c FROM frota_documentos WHERE veiculo_id = ? AND vencimento BETWEEN ? AND ?'),
    multas: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS c FROM multas WHERE veiculo_id = ? AND situacao <> 'cancelada' AND ocorrida_em >= ? AND ocorrida_em < ?"),
  };
  const linhas = veiculos.map((x) => {
    const c = {
      combustivel: q.combustivel.get(x.id, ini, fim).c,
      manutencao: q.manutencao.get(x.id, ini, fim).c,
      pneus: q.pneusCompra.get(x.id, ini, fim).c + q.pneusServ.get(x.id, ini, fim).c,
      documentos: q.documentos.get(x.id, de, ate).c,
      multas: q.multas.get(x.id, ini, fim).c,
    };
    const total = Object.values(c).reduce((s, y) => s + y, 0);
    const km = Math.round(q.km.get(x.id, de, ate).m / 1000);
    return { ...x, ...Object.fromEntries(Object.entries(c).map(([k, y]) => [`${k}_centavos`, y])), total_centavos: total, km, custo_km_centavos: km > 0 ? Math.round((total / km) * 100) / 100 : null };
  });
  const soma = (k) => linhas.reduce((s, y) => s + y[k], 0);
  const totais = { combustivel_centavos: soma('combustivel_centavos'), manutencao_centavos: soma('manutencao_centavos'), pneus_centavos: soma('pneus_centavos'),
    documentos_centavos: soma('documentos_centavos'), multas_centavos: soma('multas_centavos'), total_centavos: soma('total_centavos'), km: soma('km') };
  totais.custo_km_centavos = totais.km > 0 ? Math.round((totais.total_centavos / totais.km) * 100) / 100 : null;
  return { de, ate, veiculos: linhas.sort((a, b) => b.total_centavos - a.total_centavos), totais };
}

/** O que pede atenção agora, do mais grave para o mais leve, e os números do mês. */
function painel(db, empresaId) {
  const dia = hoje();
  const comps = listarComponentes(db, empresaId);
  const pneus = listarPneus(db, empresaId, { status: 'montado' });
  const docs = listarDocumentos(db, empresaId);
  const abertas = db.prepare("SELECT o.id, o.numero, o.descricao, o.prioridade, o.parado, o.status, o.aberta_em, v.placa FROM frota_os o JOIN veiculos v ON v.id = o.veiculo_id WHERE o.empresa_id = ? AND o.status IN ('aberta','em_execucao')").all(empresaId);
  const avarias = db.prepare(`SELECT a.id, a.descricao, a.gravidade, a.criado_em, v.placa, a.veiculo_id, m.nome AS motorista FROM avarias a JOIN veiculos v ON v.id = a.veiculo_id
    LEFT JOIN motoristas m ON m.id = a.motorista_id WHERE a.empresa_id = ? AND a.status = 'aberta' ORDER BY a.criado_em DESC LIMIT 20`).all(empresaId);
  const mes = custos(db, empresaId, `${dia.slice(0, 7)}-01`, dia);
  const atencao = [
    ...comps.filter((c) => c.estado !== 'ok').map((c) => ({ tipo: 'componente', gravidade: c.estado === 'vencido' ? 2 : 1, placa: c.placa, veiculo_id: c.veiculo_id, id: c.id,
      titulo: `${c.nome}${c.posicao ? ` (${c.posicao})` : ''}`, texto: c.estado === 'vencido' ? `Vencido: ${Math.round(c.pct)}% da vida útil` : `${Math.round(c.pct)}% da vida útil${c.previsao ? ` · vence por volta de ${dataBR(c.previsao)}` : ''}` })),
    ...pneus.filter((p) => p.estado === 'trocar' || p.estado === 'atencao').map((p) => ({ tipo: 'pneu', gravidade: p.estado === 'trocar' ? 2 : 1, placa: p.placa, veiculo_id: p.veiculo_id, id: p.id,
      titulo: `Pneu ${p.numero_fogo} (${p.posicao})`, texto: `Sulco ${String(p.sulco_mm).replace('.', ',')} mm${p.estado === 'trocar' ? ': abaixo do limite legal de 1,6 mm' : ''}` })),
    ...docs.filter((d) => d.estado === 'vencido' || d.estado === 'vencendo').map((d) => ({ tipo: 'documento', gravidade: d.estado === 'vencido' ? 2 : 1, placa: d.placa ?? d.motorista, id: d.id,
      titulo: d.nome_tipo, texto: d.estado === 'vencido' ? `Vencido há ${-d.dias} dia(s)` : `Vence em ${d.dias} dia(s)` })),
  ].sort((a, b) => b.gravidade - a.gravidade);
  const veiculos = db.prepare('SELECT COUNT(*) AS n FROM veiculos WHERE empresa_id = ? AND ativo = 1').get(empresaId).n;
  const parados = new Set(abertas.filter((o) => o.parado).map((o) => o.placa)).size;
  return {
    indicadores: {
      custo_mes_centavos: mes.totais.total_centavos, custo_km_centavos: mes.totais.custo_km_centavos, km_mes: mes.totais.km,
      os_abertas: abertas.length, veiculos, parados, disponibilidade: veiculos ? Math.round(((veiculos - parados) / veiculos) * 1000) / 10 : 100,
      vencidos: atencao.filter((a) => a.gravidade === 2).length, atencao: atencao.filter((a) => a.gravidade === 1).length,
      pneus_montados: pneus.length, componentes: comps.length,
    },
    custos_mes: mes.totais, atencao: atencao.slice(0, 60), os_abertas: abertas, avarias,
  };
}

// ---------- Avisos (WhatsApp e painel) ----------
let ultimaRodada = 0;
/** A cada 30 min: avisa uma vez cada componente perto do fim, pneu com sulco baixo e documento perto de vencer. */
function rodadaAvisos(db, { forcar = false } = {}) {
  if (!forcar && Date.now() - ultimaRodada < 30 * 60_000) return 0;
  ultimaRodada = Date.now();
  const notif = require('./notificacoes');
  let n = 0;
  for (const { id: empresaId } of db.prepare("SELECT id FROM empresas WHERE gestao_frota = 1 AND status = 'ativa'").all()) {
    const caminho = `/empresa/${empresaId}/gestao-painel`;
    for (const c of listarComponentes(db, empresaId).filter((x) => x.pct >= 90 && !x.aviso_enviado)) {
      notif.avisar(db, empresaId, 'frota', { titulo: `Manutenção · ${c.placa}`, texto: `${c.nome}: ${Math.round(c.pct)}% da vida útil${c.restante_km !== null ? ` (faltam ${Math.max(0, c.restante_km)} km)` : ''}.`, caminho });
      db.prepare('UPDATE frota_componentes SET aviso_enviado = 1 WHERE id = ?').run(c.id);
      n++;
    }
    for (const p of listarPneus(db, empresaId, { status: 'montado' }).filter((x) => x.sulco_mm !== null && x.sulco_mm <= SULCO_ATENCAO_MM && !x.aviso_sulco)) {
      notif.avisar(db, empresaId, 'frota', { titulo: `Pneu gasto · ${p.placa}`, texto: `Pneu ${p.numero_fogo} (${p.posicao}) com ${String(p.sulco_mm).replace('.', ',')} mm de sulco${p.sulco_mm <= SULCO_LIMITE_MM ? ', abaixo do limite legal' : ''}.`, caminho });
      db.prepare('UPDATE frota_pneus SET aviso_sulco = 1 WHERE id = ?').run(p.id);
      n++;
    }
    for (const d of listarDocumentos(db, empresaId).filter((x) => (x.estado === 'vencendo' && x.dias <= 15 || x.estado === 'vencido') && !x.aviso_enviado)) {
      notif.avisar(db, empresaId, 'frota', { titulo: `Documento · ${d.placa ?? d.motorista ?? ''}`, texto: `${d.nome_tipo} ${d.estado === 'vencido' ? `vencido desde ${dataBR(d.vencimento)}` : `vence em ${d.dias} dia(s) (${dataBR(d.vencimento)})`}.`, caminho });
      db.prepare('UPDATE frota_documentos SET aviso_enviado = 1 WHERE id = ?').run(d.id);
      n++;
    }
  }
  return n;
}

module.exports = {
  TIPOS_FORNECEDOR, COMPONENTES, PLANOS, POSICOES, TIPOS_DOCUMENTO, SULCO_ATENCAO_MM, SULCO_LIMITE_MM, posicoesDe, familia, situacaoComponente,
  listarComponentes, criarComponente, editarComponente, aplicarPlano, trocarComponente, historicoComponentes, componenteDa,
  criarOS, editarOS, adicionarItem, removerItem, iniciarOS, concluirOS, cancelarOS, listarOS, detalheOS,
  listarPneus, cadastrarPneu, montarPneu, desmontarPneu, rodizio, medirPneu, enviarRecapagem, voltarRecapagem, consertoPneu, descartarPneu, historicoPneu, pneusDoVeiculo,
  listarDocumentos, criarDocumento, editarDocumento, documentoDa, listarFornecedores, salvarFornecedor, fornecedorDa, custos, painel, rodadaAvisos,
};
