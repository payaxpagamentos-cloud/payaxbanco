'use strict';

/**
 * Dados de demonstração: uma rede de mídia indoor pronta para explorar o painel —
 * pontos em três cidades, TVs, anunciantes com campanhas no ar, criativos aprovados,
 * cerca de 30 dias de exibições (a prova de exibição), faturas e repasses do mês anterior.
 *
 * Uso: npm run demo   (acrescenta ao banco atual; não apaga nada)
 */

const zlib = require('node:zlib');
const { abrir, agora, transacao, lerConfig, gravarConfig } = require('./db');
const { hashSenha } = require('./lib/senha');
const { hoje, somarDias, mes, somarMeses, inicioDia, local } = require('./lib/datas');
const { montar } = require('./lib/grade');
const arquivos = require('./lib/arquivos');
const faturamento = require('./lib/faturamento');

const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const bloco = (tipo, dados) => {
  const corpo = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);
  const t = Buffer.alloc(4);
  t.writeUInt32BE(dados.length);
  const soma = Buffer.alloc(4);
  soma.writeUInt32BE(crc32(corpo));
  return Buffer.concat([t, corpo, soma]);
};

/** Cartaz PNG de demonstração: faixas de cor (serve de criativo de exemplo). */
function cartaz(largura, altura, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const linhas = [];
  for (let y = 0; y < altura; y++) {
    const linha = Buffer.alloc(1 + largura * 3);
    const faixa = Math.floor((y / altura) * 4);
    for (let x = 0; x < largura; x++) {
      const claro = (faixa % 2 === 0) ? 1 : 0.78;
      const borda = x < largura * 0.06 || x > largura * 0.94 || y < altura * 0.06 || y > altura * 0.94;
      linha[1 + x * 3] = Math.min(255, Math.round((borda ? 255 : r) * claro));
      linha[2 + x * 3] = Math.min(255, Math.round((borda ? 255 : g) * claro));
      linha[3 + x * 3] = Math.min(255, Math.round((borda ? 255 : b) * claro));
    }
    linhas.push(linha);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), bloco('IEND', Buffer.alloc(0)),
  ]);
}

// A rede de demonstração mistura os ambientes típicos: condomínios (onde a contrapartida são os comunicados),
// prédio corporativo, academia e comércio de rua.
const PONTOS = [
  { nome: 'Edifício Jardim das Acácias', categoria: 'condominio_residencial', cidade: 'Campinas', bairro: 'Cambuí', publico_dia: 940, unidades: 96,
    administradora: 'Administra Bem', repasse: 'nenhum', comissao: 0, fixo: 0, responsavel: 'Síndico Paulo Rocha', telefone: '19988881111',
    abre: '00:00', fecha: '23:59', telas: [['Elevador social 1', 'retrato', 'Elevador social', 'dividida'], ['Hall de entrada', 'paisagem', 'Hall de entrada', 'dividida']] },
  { nome: 'Residencial Vista Verde', categoria: 'condominio_residencial', cidade: 'Campinas', bairro: 'Taquaral', publico_dia: 1240, unidades: 128,
    administradora: 'Administra Bem', repasse: 'fixo', comissao: 0, fixo: 30_000, responsavel: 'Síndica Marta Souza', telefone: '19988882222',
    abre: '00:00', fecha: '23:59', telas: [['Elevador social 1', 'retrato', 'Elevador social', 'dividida'], ['Elevador social 2', 'retrato', 'Elevador social', 'dividida'], ['Portaria', 'paisagem', 'Portaria', 'dividida']] },
  { nome: 'Condomínio Alphaville Valinhos', categoria: 'condominio_residencial', cidade: 'Valinhos', bairro: 'Alphaville', publico_dia: 680, unidades: 74,
    administradora: 'Lar Gestão', repasse: 'nenhum', comissao: 0, fixo: 0, responsavel: 'Síndico Tiago Alves', telefone: '19988883333',
    abre: '00:00', fecha: '23:59', telas: [['Hall social', 'retrato', 'Hall de entrada', 'dividida']] },
  { nome: 'Centro Empresarial Nações', categoria: 'condominio_comercial', cidade: 'Campinas', bairro: 'Centro', publico_dia: 2100, unidades: 180,
    administradora: 'Prime Facilities', repasse: 'fixo', comissao: 0, fixo: 60_000, responsavel: 'Gerente predial Helena Dias', telefone: '19988884444',
    abre: '06:00', fecha: '22:00', telas: [['Elevador torre A', 'retrato', 'Elevador social', 'dividida'], ['Recepção', 'paisagem', 'Recepção', 'dividida']] },
  { nome: 'Academia Força Total', categoria: 'academia', cidade: 'Campinas', bairro: 'Cambuí', publico_dia: 430, unidades: 0,
    administradora: null, repasse: 'comissao', comissao: 2500, fixo: 0, responsavel: 'Rafael Dias', telefone: '19988885555',
    abre: '06:00', fecha: '23:00', telas: [['TV da esteira', 'paisagem', 'Área de cardio'], ['Recepção', 'retrato', 'Recepção']] },
  { nome: 'Mercado Bom Preço', categoria: 'mercado', cidade: 'Campinas', bairro: 'Taquaral', publico_dia: 1800, unidades: 0,
    administradora: null, repasse: 'comissao', comissao: 1500, fixo: 0, responsavel: 'Marta Lima', telefone: '19988886666',
    abre: '07:00', fecha: '22:00', telas: [['Fila do caixa', 'paisagem', 'Fila do caixa'], ['Totem da entrada', 'retrato', 'Hall de entrada']] },
  { nome: 'Padaria Pão Quente', categoria: 'padaria', cidade: 'Campinas', bairro: 'Centro', publico_dia: 620, unidades: 0,
    administradora: null, repasse: 'comissao', comissao: 2000, fixo: 0, responsavel: 'Jorge Lima', telefone: '19988887777',
    abre: '06:00', fecha: '20:00', telas: [['TV do balcão', 'paisagem', 'Balcão']] },
  { nome: 'Clínica Vida', categoria: 'clinica', cidade: 'Valinhos', bairro: 'Centro', publico_dia: 260, unidades: 0,
    administradora: null, repasse: 'comissao', comissao: 1800, fixo: 0, responsavel: 'Dra. Helena', telefone: '19988888888',
    abre: '08:00', fecha: '18:00', telas: [['Sala de espera', 'paisagem', 'Sala de espera']] },
];

const AGENCIAS = [
  { nome: 'Ponto Alto Publicidade', documento: '11222333000181', contato: 'Carolina Reis', email: 'midia@pontoalto.com.br', telefone: '1933220011', comissao: 2000 },
  { nome: 'Interior Mídia', documento: '04252011000110', contato: 'Fernando Braga', email: 'planejamento@interiormidia.com.br', telefone: '1933220022', comissao: 2000 },
];

const CIRCUITOS = [
  { nome: 'Residencial Campinas', descricao: 'Condomínios residenciais de Campinas: elevadores e halls.', valor: 350_000, cpm: 2200, insercoes: 8,
    alvos: [{ tipo: 'categoria', valor: 'condominio_residencial' }, { tipo: 'cidade', valor: 'Campinas' }] },
  { nome: 'Corporativo', descricao: 'Prédios comerciais e corporativos, no horário comercial.', valor: 280_000, cpm: 2500, insercoes: 6,
    alvos: [{ tipo: 'categoria', valor: 'condominio_comercial' }, { tipo: 'categoria', valor: 'predio_corporativo' }] },
  { nome: 'Comércio e academia', descricao: 'Supermercado, padaria, academia e clínica — alto fluxo de passagem.', valor: 240_000, cpm: 1800, insercoes: 6,
    alvos: [{ tipo: 'categoria', valor: 'mercado' }, { tipo: 'categoria', valor: 'padaria' }, { tipo: 'categoria', valor: 'academia' }, { tipo: 'categoria', valor: 'clinica' }] },
];

const COMUNICADOS = [
  // `evento` (dias a partir de hoje) e `hora` alimentam a agenda "O que vem por aí" na tela.
  { ponto: 0, titulo: 'Assembleia geral', texto: 'Às 19h no salão de festas. Pauta: previsão orçamentária de 2027 e troca do portão social.', tipo: 'assembleia', dias: 12, evento: 12, hora: '19:00' },
  { ponto: 0, titulo: 'Dedetização', texto: 'Garagem e áreas comuns a partir das 8h. Retire os veículos até as 7h30.', tipo: 'manutencao', dias: 5, evento: 4, hora: '08:00' },
  { ponto: 1, titulo: 'Encomendas na portaria', texto: 'Retire suas encomendas em até 48 horas. Depois disso elas voltam para os Correios.', tipo: 'entrega', dias: 20 },
  { ponto: 1, titulo: 'Elevador 2 em manutenção', texto: 'Manutenção preventiva na sexta, das 9h às 12h. Use o elevador 1.', tipo: 'manutencao', dias: 3, pendente: true, evento: 3, hora: '09:00' },
  { ponto: 3, titulo: 'Limpeza da fachada', texto: 'Rapel na torre B entre segunda e quarta. Mantenha as janelas fechadas.', tipo: 'aviso', dias: 7, evento: 6 },
];

const ANUNCIANTES = [
  { nome: 'Ótica Visão Clara', documento: '11222333000181', email: 'marketing@oticavisaoclara.com.br', telefone: '1933221100', cor: [37, 99, 235] },
  { nome: 'Pizzaria Forno de Pedra', documento: '04252011000110', email: 'contato@fornodepedra.com.br', telefone: '1933221101', cor: [220, 38, 38] },
  { nome: 'Imobiliária Casa Nova', documento: '27865757000102', email: 'anuncios@casanova.com.br', telefone: '1933221102', cor: [22, 163, 74] },
  { nome: 'Faculdade Horizonte', documento: '33000167000101', email: 'captacao@horizonte.edu.br', telefone: '1933221103', cor: [124, 58, 237] },
  { nome: 'Auto Center Giro', documento: '47960950000121', email: 'giro@autocentergiro.com.br', telefone: '1933221104', cor: [234, 122, 11] },
];

function criar(db) {
  const cfg = lerConfig(db);
  const inserir = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  const criado = agora();

  const pontos = PONTOS.map((p) => {
    const id = inserir(`INSERT INTO locais (nome, categoria, administradora, unidades, cidade, uf, bairro, logradouro, numero, responsavel, telefone,
        publico_dia, repasse_tipo, comissao_percentual, repasse_fixo_centavos, status, inicio_parceria, criado_em)
      VALUES (?, ?, ?, ?, ?, 'SP', ?, 'Rua Exemplo', ?, ?, ?, ?, ?, ?, ?, 'ativo', ?, ?)`,
      p.nome, p.categoria, p.administradora, p.unidades, p.cidade, p.bairro, String(100 + Math.floor(Math.random() * 900)), p.responsavel, p.telefone,
      p.publico_dia, p.repasse, p.comissao, p.fixo, somarDias(hoje(), -120), criado);
    if (p.categoria.startsWith('condominio')) {
      db.prepare('UPDATE locais SET assinatura = ? WHERE id = ?').run(`Administração / Síndico — ${p.nome}`, id);
    }
    // Logo da administradora no alto do comunicado (na demonstração, uma marca simples gerada aqui).
    if (p.administradora) {
      const img = arquivos.salvarImagem(cartaz(420, 120, [255, 255, 255]));
      db.prepare('UPDATE locais SET logo_arquivo = ?, logo_mime = ? WHERE id = ?').run(img.arquivo, img.mime, id);
    }
    // Condomínio tem tela ligada todo dia; comércio segue o horário de funcionamento (domingo só no mercado).
    const todoDia = p.categoria.startsWith('condominio');
    for (let d = 0; d <= 6; d++) {
      if (!todoDia && d === 0 && p.categoria !== 'mercado') continue;
      inserir('INSERT INTO local_horarios (local_id, dia_semana, abre, fecha) VALUES (?, ?, ?, ?)', id, d, p.abre, p.fecha);
    }
    return { ...p, id };
  });

  // As telas de cada ponto: elevador e hall em condomínio; fila do caixa, balcão e recepção no comércio.
  const telas = [];
  for (const p of pontos) {
    for (const [nome, orientacao, posicao, layout = 'cheia'] of p.telas) {
      const retrato = orientacao === 'retrato';
      telas.push({
        id: inserir(`INSERT INTO telas (local_id, nome, posicao, layout, orientacao, status, relogio, legenda, pareada_em, aparelho, largura, altura,
            versao_player, ultimo_contato, criado_em) VALUES (?, ?, ?, ?, ?, 'ativa', 1, ?, ?, ?, ?, ?, '1.0', ?, ?)`,
          p.id, nome, posicao, layout, orientacao, p.categoria.startsWith('condominio') ? null : `Bem-vindo à ${p.nome}`, criado,
          retrato ? 'Mini PC' : 'TV Box Android 11', retrato ? 1080 : 1920, retrato ? 1920 : 1080, agora(), criado),
        local_id: p.id,
        ponto: p,
      });
    }
  }
  // Uma TV recém-instalada, ainda sem parear (aparece no diagnóstico).
  inserir(`INSERT INTO telas (local_id, nome, posicao, orientacao, status, criado_em) VALUES (?, 'Elevador de serviço', 'Elevador de serviço', 'retrato', 'ativa', ?)`,
    pontos[0].id, criado);

  const gravarMidia = (dados, { anuncianteId = null, localId = null, nome, uso = 'campanha', duracao = cfg.duracao_imagem_s }) => {
    const lido = arquivos.salvar(dados, { duracaoInformada: duracao, duracaoImagemPadrao: cfg.duracao_imagem_s });
    return inserir(`INSERT INTO midias (anunciante_id, local_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
        status, aprovada_em, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', ?, ?)`,
      anuncianteId, localId, nome, uso, lido.tipo, lido.arquivo, lido.mime, lido.bytes, lido.sha256, lido.largura, lido.altura, lido.duracao_s, lido.orientacao,
      criado, criado);
  };

  // Conteúdo institucional de um ponto. O "anuncie aqui" da rede não precisa de arte: quando sobra espaço
  // no loop, a própria tela desenha a peça da marca (Configurações › a tela da marca completa o loop).
  const padaria = pontos.find((p) => p.categoria === 'padaria');
  gravarMidia(cartaz(1920, 1080, [217, 119, 6]), { nome: 'Promoção do dia da padaria', uso: 'institucional', localId: padaria.id, duracao: 10 });

  const agencias = AGENCIAS.map((a) => ({
    ...a,
    id: inserir('INSERT INTO agencias (nome, documento, contato, email, telefone, comissao_percentual, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.nome, a.documento, a.contato, a.email, a.telefone, a.comissao, criado),
  }));

  const circuitos = CIRCUITOS.map((c) => {
    const id = inserir('INSERT INTO circuitos (nome, descricao, valor_mes_centavos, cpm_centavos, insercoes_hora, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
      c.nome, c.descricao, c.valor, c.cpm, c.insercoes, criado);
    for (const a of c.alvos) db.prepare('INSERT INTO circuito_alvos (circuito_id, tipo, valor) VALUES (?, ?, ?)').run(id, a.tipo, a.valor);
    return { ...c, id };
  });

  for (const c of COMUNICADOS) {
    const ponto = pontos[c.ponto];
    inserir(`INSERT INTO comunicados (local_id, titulo, texto, tipo, evento_em, evento_hora, inicio, fim, duracao_s, status, aprovado_em, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?)`,
      ponto.id, c.titulo, c.texto, c.tipo, c.evento === undefined ? null : somarDias(hoje(), c.evento), c.hora ?? null,
      somarDias(hoje(), -2), somarDias(hoje(), c.dias), c.pendente ? 'pendente' : 'aprovado',
      c.pendente ? null : criado, criado);
  }

  const anunciantes = ANUNCIANTES.map((a) => ({
    ...a,
    id: inserir('INSERT INTO anunciantes (nome, documento, contato, email, telefone, status, criado_em) VALUES (?, ?, ?, ?, ?, \'ativo\', ?)',
      a.nome, a.documento, a.nome.split(' ')[0], a.email, a.telefone, criado),
  }));

  // Campanhas: formatos de cobrança e segmentações diferentes, para mostrar o painel com vida.
  const planos = [
    // Construtora no circuito residencial, comprada por agência (com PI) — o caso clássico de elevador.
    { a: 2, nome: 'Lançamento Residencial Aurora', cobranca: 'mensal', valor: 350_000, insercoes: 8, circuito: 0, agencia: 0, pi: 'PI-2026-4471',
      dias: '0123456', hi: '00:00', hf: '00:00', prioridade: 5 },
    { a: 0, nome: 'Óculos de sol — verão', cobranca: 'mensal', valor: 180_000, insercoes: 8, alvos: [], dias: '0123456', hi: '00:00', hf: '00:00', prioridade: 4 },
    { a: 1, nome: 'Pizza em dobro na terça', cobranca: 'mensal', valor: 90_000, insercoes: 6, circuito: 2, dias: '12', hi: '16:00', hf: '22:00', prioridade: 3 },
    { a: 3, nome: 'Vestibular 2027', cobranca: 'cpm', cpm: 2200, insercoes: 10, circuito: 1, agencia: 1, pi: 'PI-2026-0098',
      dias: '12345', hi: '07:00', hf: '20:00', prioridade: 4 },
    { a: 4, nome: 'Revisão com desconto', cobranca: 'cpm', cpm: 1500, insercoes: 3,
      alvos: [{ tipo: 'categoria', valor: 'padaria' }, { tipo: 'categoria', valor: 'mercado' }], dias: '12345', hi: '06:00', hf: '18:00', prioridade: 2 },
  ];

  const campanhas = planos.map((p, i) => {
    const anunciante = anunciantes[p.a];
    const agencia = p.agencia !== undefined ? agencias[p.agencia] : null;
    const circuito = p.circuito !== undefined ? circuitos[p.circuito] : null;
    const id = inserir(`INSERT INTO campanhas (anunciante_id, agencia_id, circuito_id, pi, comissao_agencia_percentual, nome, status, inicio, fim, cobranca,
        valor_centavos, cpm_centavos, insercoes_hora, prioridade, dias_semana, hora_inicio, hora_fim, aprovada_em, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, 'ativa', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      anunciante.id, agencia?.id ?? null, circuito?.id ?? null, p.pi ?? null, agencia?.comissao ?? 0,
      p.nome, somarDias(hoje(), -40), somarDias(hoje(), 50), p.cobranca, p.valor ?? 0, p.cpm ?? 0, p.insercoes, p.prioridade,
      p.dias, p.hi, p.hf, criado, criado);
    // Campanha vendida em circuito herda os alvos dele.
    if (circuito) {
      for (const a of db.prepare('SELECT tipo, valor FROM circuito_alvos WHERE circuito_id = ?').all(circuito.id)) {
        db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, a.tipo, a.valor);
      }
    }
    const paisagem = gravarMidia(cartaz(1920, 1080, anunciante.cor), { anuncianteId: anunciante.id, nome: `${p.nome} — 16:9`, duracao: 10 + (i % 3) * 5 });
    const retrato = gravarMidia(cartaz(1080, 1920, anunciante.cor), { anuncianteId: anunciante.id, nome: `${p.nome} — 9:16`, duracao: 10 + (i % 3) * 5 });
    db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, 0)').run(id, paisagem);
    db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, 1)').run(id, retrato);
    for (const alvo of p.alvos ?? []) db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, alvo.tipo, alvo.valor);
    return { id, ...p };
  });

  // Contratos: o acordo que sustenta as campanhas de cada cliente (ficam na ficha dele).
  campanhas.forEach((c, i) => {
    const anunciante = anunciantes[c.a];
    const numero = `2026-${String(14 + i).padStart(3, '0')}`;
    // O primeiro cliente é de renovação: começou há mais de um ano, então já passou da data do reajuste
    // e está perto do fim — é assim que a tela de contratos mostra o que precisa de atenção.
    const antigo = i === 0;
    const contrato = inserir(`INSERT INTO contratos (anunciante_id, agencia_id, numero, objeto, inicio, fim, cobranca, valor_centavos, vencimento_dia,
        reajuste, reajuste_meses, reajuste_percentual, renovacao_automatica, status, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 'IPCA a cada 12 meses', 12, 0, ?, 'ativo', ?)`,
      anunciante.id, c.agencia !== undefined ? agencias[c.agencia].id : null, numero,
      `Veiculação de "${c.nome}"${c.circuito !== undefined ? ` no circuito ${circuitos[c.circuito].nome}` : ' na rede'}`,
      somarDias(hoje(), antigo ? -400 : -40), somarDias(hoje(), antigo ? 20 : 325),
      c.cobranca === 'cpm' ? 'cpm' : 'mensal', c.valor ?? 0, i % 2 === 0 ? 1 : 0, criado);
    db.prepare('UPDATE campanhas SET contrato_id = ? WHERE id = ?').run(contrato, c.id);
    db.prepare('UPDATE faturas SET contrato_id = ? WHERE anunciante_id = ? AND contrato_id IS NULL').run(contrato, anunciante.id);
  });

  // Clima: na demonstração vem preenchido e ligado, para a tela mostrar o quadro do dia.
  // Em produção, o servidor busca sozinho no Open-Meteo (quando ligado nas configurações).
  gravarConfig(db, 'clima_ligado', '1');
  gravarConfig(db, 'whatsapp', '19999990000');
  for (const [cidade, uf, temp, max, min, codigo] of [['Campinas', 'SP', 27.4, 31, 19, 2], ['Valinhos', 'SP', 26.1, 30, 18, 3]]) {
    db.prepare(`INSERT INTO clima (cidade, uf, temperatura, maxima, minima, codigo, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(cidade, uf, temp, max, min, codigo, new Date().toISOString());
  }

  // CRM: o funil do comercial — quem ainda não é cliente, em que pé está e o que ficou combinado.
  const equipeId = db.prepare("SELECT id FROM usuarios WHERE perfil = 'operador' LIMIT 1").get()?.id ?? null;
  const LEADS = [
    { nome: 'Rede Pão Dourado', tipo: 'anunciante', contato: 'Marcos Lima', telefone: '19988770011', cidade: 'Campinas', uf: 'SP',
      origem: 'site', etapa: 'negociacao', valor: 450_000, passo: 'Fechar o desconto do trimestre', dias: 1,
      mensagem: 'Vi a tela no elevador do meu prédio e quero anunciar nas três lojas.',
      conversas: [['ligacao', 'Conversa com o Marcos: quer 3 meses em condomínios do Cambuí.'], ['reuniao', 'Reunião no escritório. Pediu desconto para pagamento trimestral.']] },
    { nome: 'Edifício Vista Alegre', tipo: 'ponto', contato: 'Síndica Helena', telefone: '19988770022', cidade: 'Campinas', uf: 'SP',
      origem: 'indicacao', etapa: 'proposta', valor: 0, passo: 'Levar o contrato de parceria na assembleia', dias: 4,
      conversas: [['visita', 'Visita ao prédio: dois elevadores sociais e hall com boa circulação.']] },
    { nome: 'Clínica Sorriso', tipo: 'anunciante', contato: 'Dra. Paula', email: 'contato@clinicasorriso.com.br', cidade: 'Valinhos', uf: 'SP',
      origem: 'prospeccao', etapa: 'contato', valor: 120_000, passo: 'Enviar o mídia kit', dias: -2,
      conversas: [['email', 'Mandei o mídia kit. Aguardando retorno.']] },
    { nome: 'Auto Posto Central', tipo: 'anunciante', contato: 'Seu Jorge', telefone: '19988770033', cidade: 'Campinas', uf: 'SP',
      origem: 'evento', etapa: 'novo', valor: 90_000, passo: null, dias: null, conversas: [] },
    { nome: 'Condomínio Parque das Flores', tipo: 'ponto', contato: 'Zelador Beto', telefone: '19988770044', cidade: 'Valinhos', uf: 'SP',
      origem: 'site', etapa: 'novo', valor: 0, passo: 'Ligar para o síndico', dias: 0,
      mensagem: 'O condomínio tem interesse em colocar tela no hall.', conversas: [] },
  ];
  for (const l of LEADS) {
    const id = inserir(`INSERT INTO leads (nome, tipo, contato, email, telefone, cidade, uf, origem, etapa, responsavel_id,
        valor_estimado_centavos, proximo_passo, proximo_em, mensagem, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.nome, l.tipo, l.contato ?? null, l.email ?? null, l.telefone ?? null, l.cidade, l.uf, l.origem, l.etapa, equipeId,
      l.valor, l.passo, l.dias === null ? null : somarDias(hoje(), l.dias), l.mensagem ?? null, criado, criado);
    if (l.mensagem) {
      db.prepare("INSERT INTO lead_interacoes (lead_id, tipo, texto, criado_em) VALUES (?, 'nota', ?, ?)")
        .run(id, `Pedido pelo site: ${l.mensagem}`, criado);
    }
    for (const [tipo, texto] of l.conversas) {
      db.prepare('INSERT INTO lead_interacoes (lead_id, tipo, texto, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)')
        .run(id, tipo, texto, equipeId, criado);
    }
  }
  // Um ganho e um perdido, para o quadro mostrar os dois fins possíveis.
  inserir(`INSERT INTO leads (nome, tipo, contato, telefone, cidade, uf, origem, etapa, responsavel_id, valor_estimado_centavos,
      anunciante_id, ganho_em, criado_em, atualizado_em) VALUES (?, 'anunciante', ?, ?, 'Campinas', 'SP', 'indicacao', 'ganho', ?, ?, ?, ?, ?, ?)`,
    'Pizzaria Forno de Pedra', 'Luigi', '19988770055', equipeId, 300_000, anunciantes[1].id, somarDias(hoje(), -12), criado, criado);
  inserir(`INSERT INTO leads (nome, tipo, contato, telefone, cidade, uf, origem, etapa, responsavel_id, valor_estimado_centavos,
      motivo, criado_em, atualizado_em) VALUES (?, 'anunciante', ?, ?, 'Valinhos', 'SP', 'prospeccao', 'perdido', ?, ?, ?, ?, ?)`,
    'Loja do Celular', 'Rafael', '19988770066', equipeId, 60_000, 'Achou caro para uma loja só.', criado, criado);

  // Propostas: o funil do comercial — uma na mesa do cliente, uma recusada e uma que virou contrato.
  const propostasLib = require('./lib/propostas');
  const proposta = (circuitoIdx, anuncianteIdx, meses, desconto, observacao) => propostasLib.criar(db, {
    circuito_id: circuitos[circuitoIdx].id,
    anunciante_id: anuncianteIdx === null ? null : anunciantes[anuncianteIdx].id,
    meses, desconto_percentual: desconto, validade_dias: 20, observacao,
  }, db.prepare("SELECT id FROM usuarios WHERE perfil = 'master' LIMIT 1").get()?.id ?? null);

  const naMesa = proposta(0, 3, 6, 1000, 'Produção da peça incluída no primeiro mês.');
  db.prepare("UPDATE propostas SET status = 'enviada', enviada_em = ? WHERE id = ?").run(somarDias(hoje(), -4), naMesa.id);
  const recusada = proposta(1, 4, 3, 0, null);
  db.prepare("UPDATE propostas SET status = 'recusada', enviada_em = ?, respondida_em = ?, motivo = ? WHERE id = ?")
    .run(somarDias(hoje(), -20), somarDias(hoje(), -12), 'Ficou acima do orçamento do semestre.', recusada.id);
  proposta(0, null, 12, 1500, 'Circuito inteiro, pagamento trimestral.');

  // Contas a pagar da operação, além dos repasses: internet dos prédios, aparelhos e manutenção.
  const despesa = (descricao, fornecedor, categoria, localId, diasParaVencer, valor, meses = 0) => {
    for (let i = 0; i <= meses; i++) {
      inserir(`INSERT INTO despesas (descricao, fornecedor, categoria, local_id, vencimento, valor_centavos, status, pago_em, repete_meses, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        descricao, fornecedor, categoria, localId, somarDias(hoje(), diasParaVencer + i * 30), valor,
        diasParaVencer + i * 30 < -5 ? 'paga' : 'aberta', diasParaVencer + i * 30 < -5 ? somarDias(hoje(), diasParaVencer + i * 30) : null, meses, criado);
    }
  };
  despesa('Internet do Edifício Jardim das Acácias', 'Provedor Fibra', 'internet', pontos[0].id, -35, 12_900, 2);
  despesa('Internet do Centro Empresarial Nações', 'Provedor Fibra', 'internet', pontos[3].id, -33, 19_900, 2);
  despesa('Compra de 2 TV box para o Vista Verde', 'Loja de Informática', 'aparelho', pontos[1].id, -12, 89_800);
  despesa('Instalação das telas do Vista Verde', 'Eletricista Souza', 'instalacao', pontos[1].id, 4, 45_000);
  despesa('Comissão de venda — circuito residencial', 'Vendedor Externo', 'comissao', null, 8, 35_000);

  // Uma campanha esperando aprovação e um criativo na fila, para a tela de aprovações ter conteúdo.
  const aguardando = inserir(`INSERT INTO campanhas (anunciante_id, nome, status, inicio, fim, cobranca, valor_centavos, insercoes_hora, prioridade,
      dias_semana, hora_inicio, hora_fim, criado_em) VALUES (?, 'Lançamento da loja nova', 'aguardando', ?, ?, 'mensal', 120000, 6, 3, '0123456', '09:00', '21:00', ?)`,
    anunciantes[0].id, hoje(), somarDias(hoje(), 30), criado);
  const pendente = arquivos.salvar(cartaz(1920, 1080, [15, 118, 110]), { duracaoInformada: 12, duracaoImagemPadrao: cfg.duracao_imagem_s });
  const midiaPendente = inserir(`INSERT INTO midias (anunciante_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
      status, criado_em) VALUES (?, 'Lançamento — cartaz', 'campanha', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)`,
    anunciantes[0].id, pendente.tipo, pendente.arquivo, pendente.mime, pendente.bytes, pendente.sha256, pendente.largura, pendente.altura,
    pendente.duracao_s, pendente.orientacao, criado);
  db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, 0)').run(aguardando, midiaPendente);

  // ---------------------------------------------------------------- Histórico: 30 dias de exibições
  const inserirExibicao = db.prepare(`INSERT OR IGNORE INTO exibicoes (tela_id, local_id, campanha_id, anunciante_id, midia_id, data, exibida_em, duracao_s, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const somarResumo = db.prepare(`INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (data, tela_id, campanha_id) DO UPDATE SET insercoes = insercoes + excluded.insercoes, segundos = segundos + excluded.segundos`);

  // Os últimos DETALHE_DIAS ficam com a prova de exibição linha por linha (é o que se consulta no dia a dia);
  // os dias mais antigos entram só como resumo diário, que é o que alimenta relatórios e faturamento.
  const DETALHE_DIAS = 3;
  let gravadas = 0;
  let resumidas = 0;
  for (let d = 30; d >= 0; d--) {
    const data = somarDias(hoje(), -d);
    const detalhar = d < DETALHE_DIAS;
    const diaSemana = local(Date.parse(inicioDia(data)) + 12 * 3_600_000).diaSemana;
    for (const tela of telas) {
      const linha = db.prepare('SELECT t.*, l.categoria, l.cidade FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?').get(tela.id);
      const horario = db.prepare('SELECT abre, fecha FROM local_horarios WHERE local_id = ? AND dia_semana = ?').get(tela.local_id, diaSemana);
      if (!horario) continue;
      const abre = Number(horario.abre.slice(0, 2));
      const fecha = Number(horario.fecha.slice(0, 2));
      // Monta a grade de cada hora aberta e repete o loop como a TV faria naquela hora.
      for (let hora = abre; hora < fecha; hora++) {
        const instante = Date.parse(inicioDia(data)) + hora * 3_600_000;
        const g = montar(db, linha, new Date(instante));
        if (!g.itens.length) continue;
        const voltas = Math.max(1, Math.floor(3600 / g.duracao_s));
        if (detalhar) {
          for (let volta = 0; volta < voltas; volta++) {
            let desloc = volta * g.duracao_s;
            for (const item of g.itens) {
              const quando = new Date(instante + desloc * 1000).toISOString();
              const r = inserirExibicao.run(tela.id, tela.local_id, item.campanha_id, item.anunciante_id, item.midia_id, data, quando, item.duracao_s, criado);
              if (r.changes) {
                somarResumo.run(data, tela.id, item.campanha_id ?? 0, tela.local_id, 1, item.duracao_s);
                gravadas++;
              }
              desloc += item.duracao_s;
            }
          }
        } else {
          // Só o resumo: uma linha por campanha, com as inserções e os segundos daquela hora.
          const porCampanha = new Map();
          for (const item of g.itens) {
            const chave = item.campanha_id ?? 0;
            const x = porCampanha.get(chave) ?? { insercoes: 0, segundos: 0 };
            x.insercoes += voltas;
            x.segundos += voltas * item.duracao_s;
            porCampanha.set(chave, x);
          }
          for (const [campanhaId, x] of porCampanha) {
            somarResumo.run(data, tela.id, campanhaId, tela.local_id, x.insercoes, x.segundos);
            resumidas += x.insercoes;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- Acessos, faturas e repasses
  const senhas = [];
  const acesso = (nome, email, perfil, campos) => {
    const senha = `${perfil}-demo-2026`;
    inserir(`INSERT INTO usuarios (nome, email, senha_hash, perfil, anunciante_id, local_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      nome, email, hashSenha(senha), perfil, campos.anunciante_id ?? null, campos.local_id ?? null, criado);
    senhas.push({ perfil, email, senha });
  };
  acesso('Carla Operadora', 'operador@midia.com.br', 'operador', {});
  acesso(`${anunciantes[0].nome} — contato`, 'anunciante@midia.com.br', 'anunciante', { anunciante_id: anunciantes[0].id });
  acesso(`${pontos[0].responsavel}`, 'sindico@midia.com.br', 'lojista', { local_id: pontos[0].id });
  acesso(`${pontos.find((p) => p.categoria === 'mercado').responsavel}`, 'lojista@midia.com.br', 'lojista',
    { local_id: pontos.find((p) => p.categoria === 'mercado').id });

  if (!lerConfig(db).pix_chave) {
    gravarConfig(db, 'pix_chave', 'financeiro@midiaindoor.com.br');
    gravarConfig(db, 'pix_nome', 'Midia Indoor Ltda');
    gravarConfig(db, 'pix_cidade', 'Campinas');
  }

  const anterior = somarMeses(mes(), -1);
  const fechamento = faturamento.gerar(db, anterior);
  // Metade das faturas do mês anterior já paga, para a tela de faturas mostrar os dois estados.
  const faturas = db.prepare('SELECT id FROM faturas WHERE competencia = ? ORDER BY id').all(anterior);
  faturas.filter((_, i) => i % 2 === 0).forEach((f) => db.prepare("UPDATE faturas SET status = 'paga', pago_em = ? WHERE id = ?").run(somarDias(hoje(), -3), f.id));

  return { pontos: pontos.length, telas: telas.length + 1, anunciantes: anunciantes.length, campanhas: campanhas.length + 1,
    agencias: agencias.length, circuitos: circuitos.length, comunicados: COMUNICADOS.length, exibicoes: gravadas, resumidas, fechamento, senhas };
}

if (require.main === module) {
  const db = abrir();
  if (db.prepare('SELECT COUNT(*) AS n FROM locais').get().n) {
    console.log('[Vai Mídia] O banco já tem pontos cadastrados. A demonstração foi feita para um banco novo.');
    console.log('[Vai Mídia] Apague o arquivo do banco (ou use MIDIA_DB=./data/demo.db npm run demo) e rode de novo.');
    process.exit(1);
  }
  const r = transacao(db, () => criar(db));
  console.log(`[Vai Mídia] Demonstração criada: ${r.pontos} pontos, ${r.telas} telas, ${r.anunciantes} anunciantes, ${r.agencias} agências,`);
  console.log(`[Vai Mídia] ${r.circuitos} circuitos, ${r.campanhas} campanhas e ${r.comunicados} comunicados de condomínio;`);
  console.log(`[Vai Mídia] ${r.exibicoes.toLocaleString('pt-BR')} exibições detalhadas (últimos 3 dias) e mais `
    + `${r.resumidas.toLocaleString('pt-BR')} no resumo diário; ${r.fechamento.geradas} faturas (${r.fechamento.competencia}).`);
  console.log('[Vai Mídia] Acessos de demonstração:');
  for (const s of r.senhas) console.log(`  ${s.perfil.padEnd(11)} ${s.email}  senha: ${s.senha}`);
  console.log(`  master      ${require('./config').admin.email}  senha: ${require('./config').admin.senha}`);
}

module.exports = { criar, cartaz };
