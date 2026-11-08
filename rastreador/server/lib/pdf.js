'use strict';

const PDFDocument = require('pdfkit');
const { local, intervalo } = require('./datas');
const { calcular } = require('./desempenho');
const { TIPOS: TIPOS_ALERTA } = require('./alertas');

/**
 * PDFs do sistema, gerados no servidor: o relatório do período (frota, segurança, motoristas e custos) e o relatório de
 * uma ocorrência de roubo (para a polícia ou o seguro). Fonte padrão do PDF (Helvetica), que já tem os acentos.
 */
const COR = { marinho: '#0C1429', azul: '#1559DE', ciano: '#027D83', tinta: '#152137', mudo: '#63728A', linha: '#E3EAF3', suave: '#F5F8FC', perigo: '#C8323F' };
const dataBr = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const dataHora = (iso) => { if (!iso) return '—'; const l = local(iso); return `${dataBr(l.data)} ${String(l.hora).padStart(2, '0')}:${String(l.minuto).padStart(2, '0')}`; };
const horas = (s) => { const t = Math.round(s ?? 0); return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`; };
const reais = (c) => (c === null || c === undefined ? '—' : `R$ ${(c / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`);
const km = (x) => `${Number(x ?? 0).toFixed(1).replace('.', ',')} km`;

function novoDoc(titulo) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: titulo, Author: 'Rastreador' }, bufferPages: true });
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  const pronto = new Promise((ok) => doc.on('end', () => ok(Buffer.concat(partes))));
  return { doc, pronto };
}

function cabecalho(doc, { plataforma, empresa, titulo, sub }) {
  doc.rect(0, 0, doc.page.width, 92).fill(COR.marinho);
  doc.fillColor('#7DF3DC').font('Helvetica-Bold').fontSize(9).text(String(plataforma).toUpperCase(), 40, 24, { characterSpacing: 1.5 });
  doc.fillColor('#FFFFFF').fontSize(18).text(titulo, 40, 38);
  doc.fillColor('#BFD3E6').font('Helvetica').fontSize(10).text(`${empresa} · ${sub}`, 40, 64);
  doc.fillColor(COR.tinta);
  doc.y = 112;
}

function secao(doc, titulo) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COR.tinta).text(titulo, 40);
  doc.moveTo(40, doc.y + 3).lineTo(doc.page.width - 40, doc.y + 3).strokeColor(COR.linha).lineWidth(1).stroke();
  doc.moveDown(0.6);
}

/** Tabela simples: colunas { titulo, largura, alinhar? }, linhas = arrays de texto. Quebra a página quando precisa. */
function tabela(doc, colunas, linhas, vazio = 'Nada no período.') {
  const x0 = 40;
  const altura = 18;
  const desenharTopo = () => {
    let x = x0;
    doc.rect(x0, doc.y, doc.page.width - 80, altura).fill(COR.suave);
    doc.fillColor(COR.mudo).font('Helvetica-Bold').fontSize(8);
    const y = doc.y + 5;
    for (const c of colunas) { doc.text(c.titulo, x + 4, y, { width: c.largura - 8, align: c.alinhar ?? 'left' }); x += c.largura; }
    doc.y = y + altura - 5;
  };
  if (!linhas.length) { doc.font('Helvetica').fontSize(9).fillColor(COR.mudo).text(vazio, x0); doc.moveDown(0.4); return; }
  desenharTopo();
  doc.font('Helvetica').fontSize(8.5).fillColor(COR.tinta);
  for (const l of linhas) {
    const h = Math.max(altura, ...l.map((t, i) => doc.heightOfString(String(t ?? '—'), { width: colunas[i].largura - 8 }) + 8));
    if (doc.y + h > doc.page.height - 50) { doc.addPage(); desenharTopo(); doc.font('Helvetica').fontSize(8.5).fillColor(COR.tinta); }
    let x = x0;
    const y = doc.y + 4;
    l.forEach((t, i) => { doc.text(String(t ?? '—'), x + 4, y, { width: colunas[i].largura - 8, align: colunas[i].alinhar ?? 'left' }); x += colunas[i].largura; });
    doc.y = y + h - 4;
    doc.moveTo(x0, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor(COR.linha).lineWidth(0.6).stroke();
  }
  doc.moveDown(0.5);
}

function numeros(doc, itens) {
  const largura = (doc.page.width - 80 - (itens.length - 1) * 8) / itens.length;
  const y = doc.y;
  itens.forEach(([rotulo, valor], i) => {
    const x = 40 + i * (largura + 8);
    doc.roundedRect(x, y, largura, 52, 6).strokeColor(COR.linha).lineWidth(1).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(COR.mudo).text(rotulo, x + 10, y + 10, { width: largura - 20 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(COR.tinta).text(valor, x + 10, y + 24, { width: largura - 20 });
  });
  doc.y = y + 64;
}

function rodape(doc, texto) {
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7.5).fillColor(COR.mudo)
      .text(`${texto} · página ${i + 1} de ${paginas.count}`, 40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center', lineBreak: false });
  }
}

/** Relatório do período. `conteudo`: lista entre frota, seguranca, motoristas e custos. */
async function relatorioPeriodo(db, empresaId, de, ate, conteudo = ['frota', 'seguranca', 'motoristas', 'custos'], plataforma = 'Rastreador') {
  const empresa = db.prepare('SELECT nome FROM empresas WHERE id = ?').get(empresaId).nome;
  const d = calcular(db, empresaId, de, ate);
  const [ini, fim] = intervalo(de, ate);
  const { doc, pronto } = novoDoc(`Relatório ${empresa}`);
  cabecalho(doc, { plataforma, empresa, titulo: 'Relatório da frota', sub: de === ate ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}` });
  const alertas = db.prepare('SELECT tipo, COUNT(*) AS n FROM alertas WHERE empresa_id = ? AND ocorrido_em >= ? AND ocorrido_em < ? GROUP BY tipo ORDER BY n DESC').all(empresaId, ini, fim);
  numeros(doc, [['Rodados', km(d.totais.km)], ['Alertas', String(alertas.reduce((s, a) => s + a.n, 0))],
    ['Nota média', d.totais.nota_media === null ? '—' : String(d.totais.nota_media)], ['Custo estimado', reais(d.totais.custo_centavos)]]);
  if (conteudo.includes('frota')) {
    secao(doc, 'Frota');
    tabela(doc, [{ titulo: 'Veículo', largura: 120 }, { titulo: 'Motorista', largura: 120 }, { titulo: 'Rodados', largura: 70, alinhar: 'right' },
      { titulo: 'Motor ligado', largura: 75, alinhar: 'right' }, { titulo: 'Vel. máx.', largura: 65, alinhar: 'right' }, { titulo: 'Alertas', largura: 65, alinhar: 'right' }],
    d.veiculos.map((x) => [`${x.placa}${x.descricao ? ` · ${x.descricao}` : ''}`, x.motorista ?? '—', km(x.km), horas(x.ligado_s), `${Math.round(x.velocidade_max_kmh)} km/h`, String(x.alertas)]));
  }
  if (conteudo.includes('seguranca')) {
    secao(doc, 'Segurança');
    const ocorr = db.prepare(`SELECT o.criada_em, o.status, o.encerrada_em, v.placa FROM ocorrencias o JOIN veiculos v ON v.id = o.veiculo_id
      WHERE o.empresa_id = ? AND o.tipo = 'roubo' AND o.criada_em >= ? AND o.criada_em < ? ORDER BY o.criada_em`).all(empresaId, ini, fim);
    tabela(doc, [{ titulo: 'Modo Roubo', largura: 140 }, { titulo: 'Acionado', largura: 130 }, { titulo: 'Situação', largura: 120 }, { titulo: 'Encerrado', largura: 125 }],
      ocorr.map((o) => [o.placa, dataHora(o.criada_em), { aguardando: 'aguardando velocidade', bloqueio_enviado: 'corte enviado', bloqueado: 'bloqueado', encerrada: 'encerrada' }[o.status], dataHora(o.encerrada_em)]),
      'Nenhum Modo Roubo no período.');
    tabela(doc, [{ titulo: 'Alertas por tipo', largura: 395 }, { titulo: 'Quantidade', largura: 120, alinhar: 'right' }], alertas.map((a) => [TIPOS_ALERTA[a.tipo] ?? a.tipo, String(a.n)]), 'Nenhum alerta no período.');
  }
  if (conteudo.includes('motoristas')) {
    secao(doc, 'Nota dos motoristas');
    tabela(doc, [{ titulo: 'Motorista', largura: 150 }, { titulo: 'Nota', largura: 55, alinhar: 'right' }, { titulo: 'Excessos', largura: 65, alinhar: 'right' },
      { titulo: 'Fora do horário', largura: 85, alinhar: 'right' }, { titulo: 'Motor ligado parado', largura: 100, alinhar: 'right' }, { titulo: 'Bruscas', largura: 60, alinhar: 'right' }],
    d.ranking.map((m) => [m.nome, String(m.nota), String(m.excessos), String(m.fora_horario), horas(m.ocioso_s), String(m.bruscos)]), 'Nenhum veículo com motorista fixo.');
  }
  if (conteudo.includes('custos')) {
    secao(doc, 'Custos estimados');
    tabela(doc, [{ titulo: 'Veículo', largura: 150 }, { titulo: 'Rodados', largura: 80, alinhar: 'right' }, { titulo: 'Litros', largura: 80, alinhar: 'right' },
      { titulo: 'Motor ligado parado', largura: 100, alinhar: 'right' }, { titulo: 'Custo', largura: 105, alinhar: 'right' }],
    d.veiculos.map((x) => [x.placa, km(x.km), x.litros === null ? 'sem consumo' : String(x.litros).replace('.', ','), reais(x.custo_ocioso_centavos), reais(x.custo_centavos)]));
    if (!d.preco_combustivel_centavos) doc.font('Helvetica').fontSize(8).fillColor(COR.mudo).text('Cadastre o preço do combustível em Configurações e o consumo de cada veículo para ver o custo.', 40);
  }
  rodape(doc, `${plataforma} · ${empresa} · gerado em ${dataHora(new Date().toISOString())}`);
  doc.end();
  return pronto;
}

/** Relatório de uma ocorrência de roubo: veículo, linha do tempo e as posições desde 2 h antes do acionamento. */
async function relatorioOcorrencia(db, ocorrencia, plataforma = 'Rastreador') {
  const v = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(ocorrencia.veiculo_id);
  const empresa = db.prepare('SELECT nome, telefone, email FROM empresas WHERE id = ?').get(ocorrencia.empresa_id);
  const eventos = db.prepare('SELECT em, texto, velocidade_kmh FROM ocorrencia_eventos WHERE ocorrencia_id = ? ORDER BY id').all(ocorrencia.id);
  const desde = new Date(Date.parse(ocorrencia.criada_em) - 2 * 3_600_000).toISOString();
  const ate = ocorrencia.encerrada_em ?? new Date().toISOString();
  const posicoes = db.prepare('SELECT lat, lng, velocidade_kmh, ignicao, gps_em FROM posicoes WHERE veiculo_id = ? AND gps_em >= ? AND gps_em <= ? ORDER BY gps_em')
    .all(v.id, desde, ate);
  // No máximo 400 linhas: pula posições igualmente espaçadas, mantendo a primeira e a última.
  const passo = Math.max(1, Math.ceil(posicoes.length / 400));
  const amostra = posicoes.filter((_, i) => i % passo === 0 || i === posicoes.length - 1);
  const { doc, pronto } = novoDoc(`Ocorrência ${v.placa}`);
  cabecalho(doc, { plataforma, empresa: empresa.nome, titulo: `Ocorrência de roubo · ${v.placa}`, sub: `acionada em ${dataHora(ocorrencia.criada_em)}` });
  numeros(doc, [['Placa', v.placa], ['Situação', { aguardando: 'Aguardando', bloqueio_enviado: 'Corte enviado', bloqueado: 'Bloqueado', encerrada: 'Encerrada' }[ocorrencia.status]],
    ['Última posição', dataHora(v.posicao_em)], ['Velocidade', `${Math.round(v.velocidade_kmh ?? 0)} km/h`]]);
  secao(doc, 'Veículo');
  tabela(doc, [{ titulo: 'Campo', largura: 140 }, { titulo: 'Valor', largura: 375 }], [
    ['Placa', v.placa], ['Descrição', v.descricao ?? '—'], ['Marca e modelo', [v.marca, v.modelo].filter(Boolean).join(' ') || '—'], ['Cor', v.cor ?? '—'], ['Ano', v.ano ?? '—'],
    ['Empresa', empresa.nome], ['Contato da empresa', [empresa.telefone, empresa.email].filter(Boolean).join(' · ') || '—'],
    ['Última posição', v.lat !== null ? `${v.lat.toFixed(6)}, ${v.lng.toFixed(6)} · https://maps.google.com/?q=${v.lat.toFixed(6)},${v.lng.toFixed(6)}` : '—'],
  ]);
  if (ocorrencia.observacao) { doc.font('Helvetica').fontSize(9).fillColor(COR.tinta).text(`Observação: ${ocorrencia.observacao}`, 40); doc.moveDown(0.4); }
  secao(doc, 'Linha do tempo');
  tabela(doc, [{ titulo: 'Quando', largura: 110 }, { titulo: 'O que aconteceu', largura: 405 }], eventos.map((e) => [dataHora(e.em), e.texto]));
  secao(doc, `Trajeto desde ${dataHora(desde)}`);
  tabela(doc, [{ titulo: 'Quando', largura: 105 }, { titulo: 'Velocidade', largura: 70, alinhar: 'right' }, { titulo: 'Ignição', largura: 55 }, { titulo: 'Posição', largura: 285 }],
    amostra.map((p) => [dataHora(p.gps_em), `${Math.round(p.velocidade_kmh)} km/h`, p.ignicao === null ? '—' : p.ignicao ? 'ligada' : 'desligada', `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`]),
    'Sem posições no período.');
  rodape(doc, `${plataforma} · ocorrência nº ${ocorrencia.id} · gerado em ${dataHora(new Date().toISOString())}`);
  doc.end();
  return pronto;
}

module.exports = { relatorioPeriodo, relatorioOcorrencia };
