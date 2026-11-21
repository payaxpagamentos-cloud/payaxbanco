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

const PONTOS = [
  { nome: 'Padaria Pão Quente', categoria: 'padaria', cidade: 'Campinas', bairro: 'Centro', publico_dia: 620, comissao: 2000, responsavel: 'Jorge Lima', telefone: '19988881111', abre: '06:00', fecha: '20:00' },
  { nome: 'Mercado Bom Preço', categoria: 'mercado', cidade: 'Campinas', bairro: 'Taquaral', publico_dia: 1800, comissao: 1500, responsavel: 'Marta Souza', telefone: '19988882222', abre: '07:00', fecha: '22:00' },
  { nome: 'Academia Força Total', categoria: 'academia', cidade: 'Campinas', bairro: 'Cambuí', publico_dia: 430, comissao: 2500, responsavel: 'Rafael Dias', telefone: '19988883333', abre: '06:00', fecha: '23:00' },
  { nome: 'Clínica Vida', categoria: 'clinica', cidade: 'Valinhos', bairro: 'Centro', publico_dia: 260, comissao: 1800, responsavel: 'Dra. Helena', telefone: '19988884444', abre: '08:00', fecha: '18:00' },
  { nome: 'Barbearia Navalha', categoria: 'salao', cidade: 'Valinhos', bairro: 'Jardim', publico_dia: 140, comissao: 3000, responsavel: 'Tiago Alves', telefone: '19988885555', abre: '09:00', fecha: '19:00' },
  { nome: 'Restaurante Prato Cheio', categoria: 'restaurante', cidade: 'Indaiatuba', bairro: 'Centro', publico_dia: 520, comissao: 2000, responsavel: 'Dona Cida', telefone: '19988886666', abre: '10:00', fecha: '16:00' },
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
    const id = inserir(`INSERT INTO locais (nome, categoria, cidade, uf, bairro, logradouro, numero, responsavel, telefone, publico_dia, comissao_percentual,
        status, inicio_parceria, criado_em) VALUES (?, ?, ?, 'SP', ?, 'Rua Exemplo', ?, ?, ?, ?, ?, 'ativo', ?, ?)`,
      p.nome, p.categoria, p.cidade, p.bairro, String(100 + Math.floor(Math.random() * 900)), p.responsavel, p.telefone, p.publico_dia, p.comissao,
      somarDias(hoje(), -120), criado);
    for (let d = 0; d <= 6; d++) {
      if (d === 0 && p.categoria !== 'mercado' && p.categoria !== 'restaurante') continue;
      inserir('INSERT INTO local_horarios (local_id, dia_semana, abre, fecha) VALUES (?, ?, ?, ?)', id, d, p.abre, p.fecha);
    }
    return { ...p, id };
  });

  // Uma TV por ponto; o mercado e a academia ganham a segunda (uma delas em retrato, tipo totem).
  const telas = [];
  for (const p of pontos) {
    telas.push({
      id: inserir(`INSERT INTO telas (local_id, nome, orientacao, status, relogio, legenda, pareada_em, aparelho, largura, altura, versao_player,
          ultimo_contato, criado_em) VALUES (?, ?, 'paisagem', 'ativa', 1, ?, ?, 'TV Box Android 11', 1920, 1080, '1.0', ?, ?)`,
        p.id, `TV ${p.nome.split(' ').slice(-1)[0]}`, `Bem-vindo à ${p.nome}`, criado, agora(), criado),
      local_id: p.id,
      ponto: p,
    });
  }
  const mercado = pontos.find((p) => p.categoria === 'mercado');
  telas.push({ id: inserir(`INSERT INTO telas (local_id, nome, orientacao, status, relogio, pareada_em, aparelho, largura, altura, versao_player, ultimo_contato, criado_em)
    VALUES (?, 'Totem da entrada', 'retrato', 'ativa', 1, ?, 'Mini PC', 1080, 1920, '1.0', ?, ?)`, mercado.id, criado, agora(), criado), local_id: mercado.id, ponto: mercado });
  const academia = pontos.find((p) => p.categoria === 'academia');
  telas.push({ id: inserir(`INSERT INTO telas (local_id, nome, orientacao, status, relogio, pareada_em, aparelho, largura, altura, versao_player, ultimo_contato, criado_em)
    VALUES (?, 'TV da esteira', 'paisagem', 'ativa', 0, ?, 'Fire TV Stick', 1920, 1080, '1.0', ?, ?)`, academia.id, criado, agora(), criado), local_id: academia.id, ponto: academia });
  // Uma TV recém-instalada, ainda sem parear (aparece no diagnóstico).
  inserir(`INSERT INTO telas (local_id, nome, orientacao, status, criado_em) VALUES (?, 'TV nova (a parear)', 'paisagem', 'ativa', ?)`,
    pontos.at(-1).id, criado);

  const gravarMidia = (dados, { anuncianteId = null, localId = null, nome, uso = 'campanha', duracao = cfg.duracao_imagem_s }) => {
    const lido = arquivos.salvar(dados, { duracaoInformada: duracao, duracaoImagemPadrao: cfg.duracao_imagem_s });
    return inserir(`INSERT INTO midias (anunciante_id, local_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
        status, aprovada_em, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', ?, ?)`,
      anuncianteId, localId, nome, uso, lido.tipo, lido.arquivo, lido.mime, lido.bytes, lido.sha256, lido.largura, lido.altura, lido.duracao_s, lido.orientacao,
      criado, criado);
  };

  // Institucional da rede (preenche a grade quando falta publicidade) e conteúdo de um ponto.
  gravarMidia(cartaz(1920, 1080, [11, 27, 63]), { nome: 'Anuncie aqui — fale com a equipe', uso: 'institucional', duracao: 10 });
  gravarMidia(cartaz(1080, 1920, [11, 27, 63]), { nome: 'Anuncie aqui (retrato)', uso: 'institucional', duracao: 10 });
  gravarMidia(cartaz(1920, 1080, [217, 119, 6]), { nome: 'Promoção do dia da padaria', uso: 'institucional', localId: pontos[0].id, duracao: 10 });

  const anunciantes = ANUNCIANTES.map((a) => ({
    ...a,
    id: inserir('INSERT INTO anunciantes (nome, documento, contato, email, telefone, status, criado_em) VALUES (?, ?, ?, ?, ?, \'ativo\', ?)',
      a.nome, a.documento, a.nome.split(' ')[0], a.email, a.telefone, criado),
  }));

  // Campanhas: formatos de cobrança e segmentações diferentes, para mostrar o painel com vida.
  const planos = [
    { a: 0, nome: 'Óculos de sol — verão', cobranca: 'mensal', valor: 180_000, insercoes: 8, alvos: [], dias: '0123456', hi: '00:00', hf: '00:00', prioridade: 4 },
    { a: 1, nome: 'Pizza em dobro na terça', cobranca: 'mensal', valor: 90_000, insercoes: 6, alvos: [{ tipo: 'categoria', valor: 'mercado' }, { tipo: 'categoria', valor: 'academia' }], dias: '12', hi: '16:00', hf: '22:00', prioridade: 3 },
    { a: 2, nome: 'Apartamentos no Cambuí', cobranca: 'cpm', cpm: 1800, insercoes: 4, alvos: [{ tipo: 'cidade', valor: 'Campinas' }], dias: '0123456', hi: '08:00', hf: '20:00', prioridade: 3 },
    { a: 3, nome: 'Vestibular 2027', cobranca: 'mensal', valor: 240_000, insercoes: 10, alvos: [], dias: '0123456', hi: '00:00', hf: '00:00', prioridade: 5 },
    { a: 4, nome: 'Revisão com desconto', cobranca: 'cpm', cpm: 1500, insercoes: 3, alvos: [{ tipo: 'categoria', valor: 'padaria' }, { tipo: 'categoria', valor: 'restaurante' }], dias: '12345', hi: '06:00', hf: '18:00', prioridade: 2 },
  ];

  const campanhas = planos.map((p, i) => {
    const anunciante = anunciantes[p.a];
    const id = inserir(`INSERT INTO campanhas (anunciante_id, nome, status, inicio, fim, cobranca, valor_centavos, cpm_centavos, insercoes_hora, prioridade,
        dias_semana, hora_inicio, hora_fim, aprovada_em, criado_em) VALUES (?, ?, 'ativa', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      anunciante.id, p.nome, somarDias(hoje(), -40), somarDias(hoje(), 50), p.cobranca, p.valor ?? 0, p.cpm ?? 0, p.insercoes, p.prioridade,
      p.dias, p.hi, p.hf, criado, criado);
    const paisagem = gravarMidia(cartaz(1920, 1080, anunciante.cor), { anuncianteId: anunciante.id, nome: `${p.nome} — 16:9`, duracao: 10 + (i % 3) * 5 });
    const retrato = gravarMidia(cartaz(1080, 1920, anunciante.cor), { anuncianteId: anunciante.id, nome: `${p.nome} — 9:16`, duracao: 10 + (i % 3) * 5 });
    db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, 0)').run(id, paisagem);
    db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, 1)').run(id, retrato);
    for (const alvo of p.alvos) db.prepare('INSERT INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, alvo.tipo, alvo.valor);
    return { id, ...p };
  });

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
  const DETALHE_DIAS = 7;
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
  acesso(`${pontos[0].responsavel}`, 'lojista@midia.com.br', 'lojista', { local_id: pontos[0].id });

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
    exibicoes: gravadas, resumidas, fechamento, senhas };
}

if (require.main === module) {
  const db = abrir();
  if (db.prepare('SELECT COUNT(*) AS n FROM locais').get().n) {
    console.log('[Mídia Indoor] O banco já tem pontos cadastrados. A demonstração foi feita para um banco novo.');
    console.log('[Mídia Indoor] Apague o arquivo do banco (ou use MIDIA_DB=./data/demo.db npm run demo) e rode de novo.');
    process.exit(1);
  }
  const r = transacao(db, () => criar(db));
  console.log(`[Mídia Indoor] Demonstração criada: ${r.pontos} pontos, ${r.telas} telas, ${r.anunciantes} anunciantes, ${r.campanhas} campanhas,`);
  console.log(`[Mídia Indoor] ${r.exibicoes.toLocaleString('pt-BR')} exibições detalhadas (últimos 7 dias) e mais `
    + `${r.resumidas.toLocaleString('pt-BR')} no resumo diário; ${r.fechamento.geradas} faturas (${r.fechamento.competencia}).`);
  console.log('[Mídia Indoor] Acessos de demonstração:');
  for (const s of r.senhas) console.log(`  ${s.perfil.padEnd(11)} ${s.email}  senha: ${s.senha}`);
  console.log(`  master      ${require('./config').admin.email}  senha: ${require('./config').admin.senha}`);
}

module.exports = { criar, cartaz };
