'use strict';

const { ErroNegocio } = require('./erros');
const { dataLocal, somarDias } = require('./datas');
const conexao = require('./conexao');

/*
 * Panorama: a operação inteira num mapa.
 *
 * A regra que vale para tudo aqui: COR NENHUMA é inventada. O verde e o vermelho saem da leitura do
 * concentrador (lib/conexao.js); quando ninguém leu, ou a leitura é velha demais para valer, o ponto fica
 * cinza e a tela diz por quê. Um mapa que pinta de verde o que não sabe é pior do que não ter mapa: manda
 * a equipe dormir tranquila com o assinante fora do ar.
 *
 * E a diferença que mais importa no dia a dia: quem CAIU e quem foi CORTADO por falta de pagamento não
 * podem ter a mesma cor. Um é defeito para consertar agora; o outro é a cobrança funcionando como deveria.
 */

// Depois disso, a leitura deixa de valer como "agora". Uma leitura de ontem não é estado atual.
const VALIDADE_LEITURA_MIN = 30;
const RAIO_TERRA_M = 6371000;

/**
 * Estado de um ponto no mapa, na ordem em que as perguntas importam:
 * o contrato deveria estar no ar? se deveria, o equipamento confirma que está?
 */
function estadoDo(ponto, { agora: instante = new Date(), validadeMin = VALIDADE_LEITURA_MIN } = {}) {
  const idadeMin = ponto.conexao_em ? (Date.parse(instante) - Date.parse(ponto.conexao_em)) / 60000 : null;

  if (ponto.contrato_situacao === 'cancelado') return { estado: 'cancelado', motivo: 'Contrato cancelado.' };
  if (ponto.contrato_situacao === 'em_implantacao') {
    return { estado: 'implantacao', motivo: 'Contrato em implantação: ainda não deve estar no ar.' };
  }
  if (ponto.contrato_situacao === 'suspenso') return { estado: 'suspenso', motivo: 'Serviço suspenso a pedido do assinante.' };
  if (ponto.contrato_situacao === 'bloqueado') {
    // Bloqueado é o corte por inadimplência: estar fora do ar aqui é o sistema funcionando, não defeito.
    return { estado: 'bloqueado', motivo: 'Cortado por inadimplência. Fora do ar é o esperado.' };
  }
  if (!ponto.servico_id) return { estado: 'sem_servico', motivo: 'Contrato ativo sem serviço provisionado.' };
  if (ponto.conectado === null || ponto.conectado === undefined) {
    return ponto.lido_em
      ? { estado: 'desconhecido', motivo: 'O concentrador não encontrou este login: é divergência de provisionamento, não queda.' }
      : { estado: 'nunca_lido', motivo: 'Nunca lido no concentrador. O sistema não sabe se está no ar.' };
  }
  if (idadeMin !== null && idadeMin > validadeMin) {
    return {
      estado: 'leitura_antiga',
      motivo: `Última leitura há ${Math.round(idadeMin)} min. Velha demais para dizer o que vale agora.`,
      era: ponto.conectado ? 'conectado' : 'sem_conexao',
    };
  }
  return ponto.conectado
    ? { estado: 'conectado', motivo: 'Sessão ativa no concentrador.' }
    : { estado: 'sem_conexao', motivo: 'Contrato ativo e sem sessão no concentrador.' };
}

/** Os estados que pedem ação da equipe técnica agora. */
const PRECISA_ATENCAO = new Set(['sem_conexao', 'sem_servico', 'desconhecido']);

// ---------------- Pontos ----------------

const NUM = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function condicoes(filtros = {}) {
  const f = ['c.organizacao_id = ?'];
  const p = [];
  const add = (sql, valor) => { f.push(sql); p.push(valor); };

  if (!filtros.incluir_cancelados) f.push("c.situacao <> 'cancelado'");
  if (filtros.contrato_situacao) add('c.situacao = ?', String(filtros.contrato_situacao));
  if (NUM(filtros.plano_id)) add('c.plano_id = ?', NUM(filtros.plano_id));
  if (NUM(filtros.cto_id)) add('c.cto_id = ?', NUM(filtros.cto_id));
  if (NUM(filtros.concentrador_id)) add('s.concentrador_id = ?', NUM(filtros.concentrador_id));
  if (NUM(filtros.olt_id)) add('s.olt_id = ?', NUM(filtros.olt_id));
  if (filtros.tecnologia) add('p.tecnologia = ?', String(filtros.tecnologia));
  if (filtros.tipo_acesso) add('s.tipo_acesso = ?', String(filtros.tipo_acesso));
  if (filtros.bairro) add('LOWER(COALESCE(c.bairro, a.bairro)) = LOWER(?)', String(filtros.bairro));
  if (filtros.busca) {
    f.push('(a.nome LIKE ? ESCAPE \'\\\' OR a.documento LIKE ? ESCAPE \'\\\' OR s.login LIKE ? ESCAPE \'\\\')');
    const t = `%${String(filtros.busca).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    p.push(t, t, t);
  }
  if (NUM(filtros.quedas_min)) add('COALESCE(s.quedas_hoje, 0) >= ?', NUM(filtros.quedas_min));
  return { onde: f.join(' AND '), params: p };
}

const SELECT_PONTOS = `
  SELECT c.id AS contrato_id, c.numero AS contrato_numero, c.situacao AS contrato_situacao, c.mensalidade_centavos,
         COALESCE(c.latitude, a.latitude) AS lat, COALESCE(c.longitude, a.longitude) AS lng,
         COALESCE(c.bairro, a.bairro) AS bairro, COALESCE(c.logradouro, a.logradouro) AS logradouro,
         COALESCE(c.numero_endereco, a.numero) AS numero_endereco,
         c.cto_id, ct.codigo AS cto_codigo, c.porta_id, po.numero AS porta_numero,
         a.id AS assinante_id, a.codigo AS assinante_codigo, a.nome AS assinante_nome, a.telefone, a.documento,
         p.id AS plano_id, p.nome AS plano_nome, p.tecnologia, p.download_mbps, p.upload_mbps,
         s.id AS servico_id, s.login, s.tipo_acesso, s.concentrador_id, s.olt_id, s.pon, s.onu_serial,
         s.conectado, s.conexao_em, s.conexao_desde, s.conexao_ip, s.lido_em,
         COALESCE(s.quedas_hoje, 0) AS quedas_hoje, s.quedas_dia,
         eq.nome AS concentrador_nome
  FROM contratos c
  JOIN assinantes a ON a.id = c.assinante_id
  JOIN planos p ON p.id = c.plano_id
  LEFT JOIN servicos s ON s.contrato_id = c.id
  LEFT JOIN ativos_rede ct ON ct.id = c.cto_id
  LEFT JOIN portas_rede po ON po.id = c.porta_id
  LEFT JOIN equipamentos eq ON eq.id = s.concentrador_id`;

/**
 * Pontos do mapa. Devolve SEMPRE, junto, quantos ficaram de fora por não ter coordenada:
 * um mapa que esconde em silêncio parte da carteira está mentindo por omissão.
 */
function pontos(db, org, filtros = {}, opcoes = {}) {
  const { onde, params } = condicoes(filtros);
  const linhas = db.prepare(`${SELECT_PONTOS} WHERE ${onde} ORDER BY c.id`).all(org, ...params);
  const hoje = dataLocal(opcoes.fuso ?? 'America/Sao_Paulo', opcoes.agora ?? new Date());

  const comPonto = [];
  const semCoordenada = [];
  for (const l of linhas) {
    const e = estadoDo(l, opcoes);
    // A contagem de quedas só vale para o dia a que ela se refere.
    const quedas = l.quedas_dia === hoje ? l.quedas_hoje : 0;
    const item = {
      contrato_id: l.contrato_id,
      contrato_numero: l.contrato_numero,
      contrato_situacao: l.contrato_situacao,
      assinante_id: l.assinante_id,
      assinante_codigo: l.assinante_codigo,
      assinante_nome: l.assinante_nome,
      telefone: l.telefone,
      documento: l.documento,
      endereco: [l.logradouro, l.numero_endereco].filter(Boolean).join(', ') || null,
      bairro: l.bairro,
      plano_id: l.plano_id,
      plano_nome: l.plano_nome,
      tecnologia: l.tecnologia,
      download_mbps: l.download_mbps,
      mensalidade_centavos: l.mensalidade_centavos,
      cto_id: l.cto_id,
      cto_codigo: l.cto_codigo,
      porta_numero: l.porta_numero,
      servico_id: l.servico_id,
      login: l.login,
      tipo_acesso: l.tipo_acesso,
      concentrador_id: l.concentrador_id,
      concentrador_nome: l.concentrador_nome,
      olt_id: l.olt_id,
      pon: l.pon,
      onu_serial: l.onu_serial,
      ip: l.conexao_ip,
      lido_em: l.conexao_em ?? l.lido_em,
      desde: l.conexao_desde,
      quedas_hoje: quedas,
      lat: l.lat,
      lng: l.lng,
      ...e,
      atencao: PRECISA_ATENCAO.has(e.estado),
    };
    if (l.lat === null || l.lng === null) semCoordenada.push(item);
    else comPonto.push(item);
  }

  const filtrados = filtros.estado ? comPonto.filter((x) => [].concat(filtros.estado).includes(x.estado)) : comPonto;
  return {
    pontos: filtrados,
    total: comPonto.length + semCoordenada.length,
    no_mapa: filtrados.length,
    sem_coordenada: semCoordenada.length,
    // A lista vem junto para a tela poder resolver o problema, não só informar que ele existe.
    fora_do_mapa: semCoordenada.slice(0, 200).map((x) => ({
      contrato_id: x.contrato_id, contrato_numero: x.contrato_numero, assinante_id: x.assinante_id,
      assinante_nome: x.assinante_nome, endereco: x.endereco, bairro: x.bairro, estado: x.estado,
    })),
    por_estado: contarPorEstado(comPonto),
  };
}

function contarPorEstado(lista) {
  const c = {};
  for (const x of lista) c[x.estado] = (c[x.estado] ?? 0) + 1;
  return c;
}

/** Opções dos filtros, tiradas do que a operação realmente tem (nada de lista fixa). */
function opcoesDeFiltro(db, org) {
  return {
    planos: db.prepare(`SELECT DISTINCT p.id, p.nome FROM planos p JOIN contratos c ON c.plano_id = p.id
      WHERE c.organizacao_id = ? ORDER BY p.nome`).all(org),
    concentradores: db.prepare(`SELECT DISTINCT e.id, e.nome FROM equipamentos e JOIN servicos s ON s.concentrador_id = e.id
      WHERE s.organizacao_id = ? ORDER BY e.nome`).all(org),
    olts: db.prepare(`SELECT DISTINCT e.id, e.nome FROM equipamentos e JOIN servicos s ON s.olt_id = e.id
      WHERE s.organizacao_id = ? ORDER BY e.nome`).all(org),
    ctos: db.prepare(`SELECT DISTINCT ct.id, ct.codigo FROM ativos_rede ct JOIN contratos c ON c.cto_id = ct.id
      WHERE c.organizacao_id = ? ORDER BY ct.codigo`).all(org),
    bairros: db.prepare(`SELECT DISTINCT COALESCE(c.bairro, a.bairro) AS bairro FROM contratos c JOIN assinantes a ON a.id = c.assinante_id
      WHERE c.organizacao_id = ? AND COALESCE(c.bairro, a.bairro) IS NOT NULL ORDER BY 1`).all(org).map((x) => x.bairro),
    tecnologias: db.prepare(`SELECT DISTINCT p.tecnologia FROM planos p JOIN contratos c ON c.plano_id = p.id
      WHERE c.organizacao_id = ? AND p.tecnologia IS NOT NULL ORDER BY 1`).all(org).map((x) => x.tecnologia),
  };
}

// ---------------- Rede, chamados e frota no mesmo mapa ----------------

/** Ativos ópticos com coordenada, com a ocupação de portas, para o mapa mostrar onde ainda cabe cliente. */
function rede(db, org) {
  const ativos = db.prepare(`SELECT id, codigo, tipo, nome, bairro, lat, lng, capacidade, status_operacional, status_origem
    FROM ativos_rede WHERE organizacao_id = ? AND ativo = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY tipo, codigo`).all(org);
  const portas = db.prepare(`SELECT ativo_id, situacao, COUNT(*) AS n FROM portas_rede
    WHERE ativo_id IN (SELECT id FROM ativos_rede WHERE organizacao_id = ?) GROUP BY ativo_id, situacao`).all(org);
  const porAtivo = new Map();
  for (const p of portas) {
    const x = porAtivo.get(p.ativo_id) ?? { total: 0, livre: 0, ocupada: 0, reservada: 0, defeito: 0 };
    x[p.situacao] = p.n;
    x.total += p.n;
    porAtivo.set(p.ativo_id, x);
  }
  return ativos.map((a) => ({ ...a, portas: porAtivo.get(a.id) ?? null }));
}

/** Chamados abertos com coordenada: quem está esperando atendimento, no mesmo mapa do cliente parado. */
const chamados = (db, org) => db.prepare(`SELECT ch.id, ch.numero, ch.tipo, ch.status, ch.prioridade, ch.lat, ch.lng, ch.endereco,
    ch.agendado_para, t.nome AS tecnico_nome FROM chamados ch LEFT JOIN tecnicos t ON t.id = ch.tecnico_id
  WHERE ch.organizacao_id = ? AND ch.status NOT IN ('aprovado','cancelado') AND ch.lat IS NOT NULL AND ch.lng IS NOT NULL
  ORDER BY ch.id DESC LIMIT 500`).all(org);

// ---------------- Geometria ----------------

/** Distância em linha reta (haversine). NÃO é metragem de cabo nem distância de rua — a tela diz isso. */
function distanciaM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * RAIO_TERRA_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Ponto dentro de polígono, por lançamento de raio.
 *
 * O teste é feito em graus, sem projeção: para a área de um bairro ou de uma CTO o erro é desprezível.
 * Para um polígono que cruze o antimeridiano (longitude 180) não serve — e nenhum provedor brasileiro
 * tem área assim, então o caso fica declarado aqui em vez de virar bug silencioso.
 */
function dentro(ponto, poligono) {
  let dentroDele = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [lati, lngi] = [poligono[i].lat, poligono[i].lng];
    const [latj, lngj] = [poligono[j].lat, poligono[j].lng];
    const cruza = (lngi > ponto.lng) !== (lngj > ponto.lng)
      && ponto.lat < ((latj - lati) * (ponto.lng - lngi)) / (lngj - lngi) + lati;
    if (cruza) dentroDele = !dentroDele;
  }
  return dentroDele;
}

function validarPoligono(bruto) {
  const pts = (Array.isArray(bruto) ? bruto : []).map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }));
  if (pts.length < 3) throw new ErroNegocio('A área precisa de pelo menos três pontos.', 422);
  if (pts.length > 200) throw new ErroNegocio('A área tem pontos demais (máximo 200).', 422);
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      throw new ErroNegocio('A área tem um ponto com coordenada inválida.', 422);
    }
  }
  return pts;
}

// ---------------- Área de impacto ----------------

/**
 * Quem está dentro da área desenhada, e o que isso significa.
 *
 * Serve para a pergunta que todo NOC faz quando cai um trecho: "quem é que eu vou ter no telefone?".
 * Por isso vem junto quanto de mensalidade está na área e quais CTOs estão envolvidas — e a contagem
 * separa quem está fora do ar de quem o sistema simplesmente não leu.
 */
function impacto(db, org, poligono, filtros = {}, opcoes = {}) {
  const area = validarPoligono(poligono);
  const todos = pontos(db, org, filtros, opcoes);
  const dentroDaArea = todos.pontos.filter((p) => dentro(p, area));
  const ctos = new Map();
  for (const p of dentroDaArea) if (p.cto_id) ctos.set(p.cto_id, { id: p.cto_id, codigo: p.cto_codigo, assinantes: (ctos.get(p.cto_id)?.assinantes ?? 0) + 1 });

  const ativosNaArea = rede(db, org).filter((a) => dentro(a, area));
  const chamadosNaArea = chamados(db, org).filter((c) => dentro(c, area));
  const porEstado = contarPorEstado(dentroDaArea);
  return {
    assinantes: dentroDaArea.length,
    por_estado: porEstado,
    sem_conexao: porEstado.sem_conexao ?? 0,
    conectados: porEstado.conectado ?? 0,
    sem_leitura: (porEstado.nunca_lido ?? 0) + (porEstado.leitura_antiga ?? 0) + (porEstado.desconhecido ?? 0),
    bloqueados: porEstado.bloqueado ?? 0,
    mensalidade_centavos: dentroDaArea.reduce((s, p) => s + (p.mensalidade_centavos ?? 0), 0),
    ctos: [...ctos.values()].sort((a, b) => b.assinantes - a.assinantes),
    ativos: ativosNaArea.map((a) => ({ id: a.id, codigo: a.codigo, tipo: a.tipo, status_operacional: a.status_operacional })),
    chamados_abertos: chamadosNaArea.length,
    // O que o NOC precisa para abrir o incidente sem redigitar nada.
    contratos: dentroDaArea.map((p) => p.contrato_id),
    itens: dentroDaArea.sort((a, b) => Number(b.atencao) - Number(a.atencao) || a.assinante_nome.localeCompare(b.assinante_nome, 'pt-BR')),
    aviso: todos.sem_coordenada
      ? `${todos.sem_coordenada} contrato(s) sem coordenada não entram em nenhuma área: podem estar dentro desta e não aparecer aqui.`
      : null,
  };
}

// ---------------- Viabilidade ----------------

/**
 * Tem como atender neste endereço? Responde com as CTOs mais próximas que ainda têm porta livre.
 *
 * A distância é em LINHA RETA. A metragem de cabo é maior (e às vezes muito maior: atravessar uma avenida
 * pode custar duzentos metros de poste). O número serve para ordenar candidatas e descartar o que está
 * longe demais — nunca para prometer prazo ou custo ao cliente, e a tela diz isso.
 */
function viabilidade(db, org, { lat, lng, raio_m = 300, limite = 8 } = {}) {
  const alvo = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(alvo.lat) || !Number.isFinite(alvo.lng) || Math.abs(alvo.lat) > 90 || Math.abs(alvo.lng) > 180) {
    throw new ErroNegocio('Informe uma coordenada válida para consultar a viabilidade.', 422);
  }
  const raio = Math.min(Math.max(Number(raio_m) || 300, 50), 5000);
  const candidatas = rede(db, org)
    .filter((a) => a.tipo === 'cto')
    .map((a) => ({ ...a, distancia_m: distanciaM(alvo, a) }))
    .filter((a) => a.distancia_m <= raio)
    .sort((a, b) => a.distancia_m - b.distancia_m)
    .slice(0, Math.min(Number(limite) || 8, 50));

  const comPorta = candidatas.filter((a) => (a.portas?.livre ?? 0) > 0);
  return {
    consulta: { ...alvo, raio_m: raio },
    caixas: candidatas.map((a) => ({
      id: a.id, codigo: a.codigo, tipo: a.tipo, bairro: a.bairro, lat: a.lat, lng: a.lng,
      distancia_m: a.distancia_m, status_operacional: a.status_operacional, status_origem: a.status_origem,
      portas: a.portas,
      livre: (a.portas?.livre ?? 0) > 0,
      // Reservada não é livre: alguém já prometeu aquela porta a outro cliente.
      observacao: !a.portas ? 'Caixa sem portas cadastradas: a ocupação é desconhecida.'
        : (a.portas.livre ?? 0) > 0 ? null
          : (a.portas.reservada ?? 0) > 0 ? 'Sem porta livre; há porta reservada para outro atendimento.'
            : 'Todas as portas ocupadas.',
    })),
    atendivel: comPorta.length > 0,
    resumo: comPorta.length
      ? `${comPorta.length} caixa(s) com porta livre em até ${raio} m, a mais próxima a ${comPorta[0].distancia_m} m em linha reta.`
      : candidatas.length
        ? `Há ${candidatas.length} caixa(s) em até ${raio} m, mas nenhuma com porta livre.`
        : `Nenhuma caixa cadastrada em até ${raio} m deste ponto.`,
    ressalva: 'Distância em linha reta entre as coordenadas. A metragem real de cabo é maior e depende do percurso por poste; '
      + 'use como ordem de preferência, não como promessa de prazo ou custo.',
  };
}

// ---------------- Mapa de calor das quedas ----------------

/**
 * Onde a rede mais cai, por período.
 *
 * Em vez de um degradê bonito que sugere precisão que não existe, a resposta é uma GRADE de células com a
 * contagem exata de quedas e de assinantes distintos. Cada célula pode ser aberta: o operador vê de quem
 * são as quedas, em vez de olhar uma mancha vermelha e adivinhar.
 */
function calor(db, org, { de, ate, celula_m = 250, fuso = 'America/Sao_Paulo' } = {}) {
  const fim = ate ?? new Date().toISOString();
  const inicio = de ?? `${somarDias(dataLocal(fuso, fim), -7)}T00:00:00.000Z`;
  const eventos = conexao.quedasNoPeriodo(db, org, inicio, fim);
  const lado = Math.min(Math.max(Number(celula_m) || 250, 50), 5000);

  // Grau de latitude ~111.32 km em qualquer lugar; o de longitude encolhe com o cosseno da latitude.
  const passoLat = lado / 111320;
  const celulas = new Map();
  for (const e of eventos) {
    const passoLng = lado / (111320 * Math.max(0.1, Math.cos((e.lat * Math.PI) / 180)));
    const i = Math.floor(e.lat / passoLat);
    const j = Math.floor(e.lng / passoLng);
    const chave = `${i}:${j}`;
    const c = celulas.get(chave) ?? {
      quedas: 0, servicos: new Set(), contratos: new Set(),
      sul: i * passoLat, norte: (i + 1) * passoLat, oeste: j * passoLng, leste: (j + 1) * passoLng,
    };
    c.quedas += 1;
    c.servicos.add(e.servico_id);
    c.contratos.add(e.contrato_id);
    celulas.set(chave, c);
  }
  const lista = [...celulas.values()].map((c) => ({
    quedas: c.quedas,
    assinantes: c.contratos.size,
    contratos: [...c.contratos],
    sul: c.sul, norte: c.norte, oeste: c.oeste, leste: c.leste,
    centro: { lat: (c.sul + c.norte) / 2, lng: (c.oeste + c.leste) / 2 },
  })).sort((a, b) => b.quedas - a.quedas);

  const maior = lista[0]?.quedas ?? 0;
  return {
    periodo: { de: inicio, ate: fim, celula_m: lado },
    celulas: lista.map((c) => ({ ...c, intensidade: maior ? c.quedas / maior : 0 })),
    quedas: eventos.length,
    assinantes_afetados: new Set(eventos.map((e) => e.contrato_id)).size,
    // Dito na cara: quedas de quem o sistema nunca leu não existem aqui, porque nunca foram observadas.
    ressalva: 'Cada queda vem de uma leitura do concentrador que viu a sessão cair. Serviço que o sistema nunca leu '
      + 'não aparece no mapa de calor — ausência de mancha não é ausência de problema.',
  };
}

module.exports = {
  VALIDADE_LEITURA_MIN, estadoDo, PRECISA_ATENCAO, pontos, opcoesDeFiltro, rede, chamados,
  distanciaM, dentro, validarPoligono, impacto, viabilidade, calor, contarPorEstado,
};
