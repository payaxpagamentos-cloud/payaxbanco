'use strict';

/** Relatório do ataque em PDF: resumo, gráfico, origens, portas, ações de bloqueio e linha do tempo. */

const { Pdf } = require('./pdf');
const fmt = require('./formato');
const mitigacao = require('./mitigacao');
const { DIRECAO } = require('./fluxos/deteccao');

const VERDE = [25, 114, 78];
const GRAFITE = [21, 38, 30];
const FRACO = [101, 119, 90];
const VERMELHO = [184, 67, 61];
const SEV = { critica: 'Crítica', alta: 'Alta', media: 'Média', baixa: 'Baixa' };
const STATUS_M = { aguardando_aprovacao: 'Aguardando aprovação', ativa: 'Ativa', retirada: 'Retirada', recusada: 'Recusada', bloqueada: 'Impedida pelas proteções' };
const EVENTOS = { inicio: 'Ataque detectado', fim: 'Ataque encerrado', encerrado_manual: 'Encerrado manualmente', mitigacao_ativa: 'Bloqueio ativado',
  mitigacao_aguardando_aprovacao: 'Bloqueio aguardando aprovação', mitigacao_aprovada: 'Bloqueio aprovado', mitigacao_recusada: 'Bloqueio recusado',
  mitigacao_retirada: 'Bloqueio retirado', mitigacao_bloqueada: 'Bloqueio impedido pelas proteções', mitigacao_prorrogada: 'Bloqueio prorrogado',
  mitigacao_estendida: 'Prazo do bloqueio estendido', mitigacao_erro: 'Bloqueio não gerado', comentario: 'Comentário' };

function gerarRelatorioAtaque({ ataque: a, organizacao, grupo, serie, mitigacoes, eventos, assinante }) {
  const pdf = new Pdf();
  const fuso = organizacao.fuso;
  let y = 0;
  let pagina = 1;
  const rodape = () => {
    pdf.linha(40, 812, 555, 812);
    pdf.texto(40, 826, 'Volumes medidos por flows amostrados: são estimativas pela taxa de amostragem dos roteadores.', { tam: 7.5, rgb: FRACO });
    pdf.texto(555, 826, `Página ${pagina}`, { tam: 7.5, rgb: FRACO, direita: true });
  };
  const espaco = (h) => { if (y + h > 795) { rodape(); pdf.novaPagina(); pagina++; y = 50; } };
  const titulo = (t) => { espaco(40); y += 22; pdf.texto(40, y, t, { tam: 12, negrito: true, rgb: GRAFITE }); y += 6; pdf.linha(40, y, 555, y, { rgb: VERDE, larg: 1.2 }); y += 16; };

  // Cabeçalho
  pdf.retangulo(0, 0, 595, 92, { preencher: GRAFITE });
  pdf.texto(40, 38, 'Manager Network', { tam: 20, negrito: true, rgb: [255, 255, 255] });
  pdf.texto(40, 58, `Relatório de ataque #${a.numero}`, { tam: 12, rgb: [145, 217, 160] });
  pdf.texto(40, 76, organizacao.nome, { tam: 9, rgb: [201, 216, 205] });
  pdf.texto(555, 38, a.status === 'ativo' ? 'EM ANDAMENTO' : 'ENCERRADO', { tam: 10, negrito: true, rgb: a.status === 'ativo' ? [213, 139, 58] : [145, 217, 160], direita: true });
  pdf.texto(555, 76, `Gerado em ${fmt.dataHora(new Date().toISOString(), fuso)}`, { tam: 8, rgb: [201, 216, 205], direita: true });
  y = 100;

  titulo('Resumo');
  const fim = a.fim ?? null;
  const pares = [
    ['Alvo', a.alvo_tipo === 'grupo' ? `Grupo ${grupo?.nome ?? ''} (soma do grupo)` : a.alvo], ['Grupo de IPs', grupo?.nome ?? '—'],
    ['Direção', `${a.direcao === 'entrada' ? 'Externo → interno' : a.direcao === 'saida' ? 'Interno → externo' : 'Interno → interno'} (${DIRECAO[a.direcao]})`],
    ['Vetor', a.vetor ?? '—'], ['Severidade', SEV[a.severidade]], ['Início', fmt.dataHora(a.inicio, fuso, { segundos: true })],
    ['Fim', fim ? fmt.dataHora(fim, fuso, { segundos: true }) : 'Em andamento'], ['Duração', fmt.duracao((fim ? Date.parse(fim) : Date.now()) - Date.parse(a.inicio))],
    ['Pico de tráfego', `${fmt.bits(a.pico_bps)} · ${fmt.pacotes(a.pico_pps)}`], ['Limite violado', `${fmt.metrica(a.metrica, a.limite)} (média de ${a.janela_s} s)`],
    ['Volume estimado', a.total_bytes ? fmt.bytes(a.total_bytes) : '—'],
    assinante ? ['Assinante (PPPoE)', `${assinante.login}${assinante.mac ? ` · ${assinante.mac}` : ''}`] : null,
    a.motivo_encerramento ? ['Encerramento', a.motivo_encerramento] : null,
  ].filter(Boolean);
  for (let i = 0; i < pares.length; i += 2) {
    espaco(16);
    for (const [j, x] of [[0, 40], [1, 300]]) {
      const p = pares[i + j];
      if (!p) continue;
      pdf.texto(x, y, p[0], { tam: 8, rgb: FRACO });
      pdf.texto(x + 95, y, p[1], { tam: 9.5, negrito: j === 0 && i === 0, max: 160 });
    }
    y += 16;
  }

  // Gráfico do tráfego
  titulo('Tráfego no alvo (média de 10 s)');
  espaco(170);
  const gx = 70; const gy = y; const gw = 480; const gh = 130;
  pdf.retangulo(gx, gy, gw, gh, { borda: [231, 235, 229] });
  if (serie.length >= 2) {
    const t0 = Date.parse(serie[0].em);
    const t1 = Math.max(Date.parse(serie.at(-1).em), t0 + 1);
    const limiteBps = a.metrica === 'bps' ? a.limite : null;
    const max = Math.max(...serie.map((s) => s.bps), limiteBps ?? 0) * 1.1 || 1;
    if (limiteBps) {
      const ly = gy + gh - (limiteBps / max) * gh;
      pdf.linha(gx, ly, gx + gw, ly, { rgb: VERMELHO, larg: 0.8 });
      pdf.texto(gx + gw - 4, ly - 3, `limite ${fmt.bits(limiteBps)}`, { tam: 7, rgb: VERMELHO, direita: true });
    }
    pdf.polilinha(serie.map((s) => [gx + ((Date.parse(s.em) - t0) / (t1 - t0)) * gw, gy + gh - (s.bps / max) * gh]));
    pdf.texto(gx - 6, gy + 6, fmt.bits(max), { tam: 7, rgb: FRACO, direita: true });
    pdf.texto(gx - 6, gy + gh, '0', { tam: 7, rgb: FRACO, direita: true });
    pdf.texto(gx, gy + gh + 12, fmt.dataHora(serie[0].em, fuso, { segundos: true }), { tam: 7, rgb: FRACO });
    pdf.texto(gx + gw, gy + gh + 12, fmt.dataHora(serie.at(-1).em, fuso, { segundos: true }), { tam: 7, rgb: FRACO, direita: true });
  } else {
    pdf.texto(gx + 12, gy + gh / 2, 'Medições insuficientes para o gráfico.', { tam: 9, rgb: FRACO });
  }
  y = gy + gh + 22;

  // Origens e portas
  const tabela = (cab, linhas, colunas, vazioTexto = 'Sem dados capturados.') => {
    espaco(28);
    colunas.forEach(([x, , dir], i) => pdf.texto(x, y, cab[i], { tam: 8, negrito: true, rgb: FRACO, direita: dir }));
    y += 5; pdf.linha(40, y, 555, y); y += 12;
    if (!linhas.length) { pdf.texto(40, y, vazioTexto, { tam: 9, rgb: FRACO }); y += 14; return; }
    for (const l of linhas) {
      espaco(14);
      colunas.forEach(([x, max, dir], i) => pdf.texto(x, y, l[i], { tam: 9, max, direita: dir }));
      y += 14;
    }
  };
  const total = a.total_bytes || 1;
  const parse = (s) => { try { return JSON.parse(s ?? '[]'); } catch { return []; } };
  titulo(a.direcao === 'saida' ? 'Principais destinos' : 'Principais origens');
  tabela(['Endereço', 'Volume', 'Participação', 'Pacotes'], parse(a.origens).slice(0, 10).map((o) => [o.chave, fmt.bytes(o.bytes), `${fmt.num((o.bytes / total) * 100, 1)}%`, fmt.num(o.pkts)]),
    [[40, 220], [360, 90, true], [450, 80, true], [555, 90, true]]);
  const proto = (k) => { const [p, porta] = String(k).split('/'); return `${mitigacao.NOMES_PROTO[p] ?? p}${porta !== undefined ? ` ${porta}` : ''}`; };
  titulo('Portas e protocolos');
  tabela(['Porta de origem', 'Volume', 'Porta de destino', 'Volume'], Array.from({ length: Math.max(parse(a.portas_origem).length, parse(a.portas_destino).length, 0) }, (_, i) => {
    const o = parse(a.portas_origem)[i]; const d = parse(a.portas_destino)[i];
    return [o ? `${proto(o.chave)}${mitigacao.AMPLIFICACAO[o.chave.split('/')[1]] && o.chave.startsWith('17/') ? ` (${mitigacao.AMPLIFICACAO[o.chave.split('/')[1]]})` : ''}` : '',
      o ? fmt.bytes(o.bytes) : '', d ? proto(d.chave) : '', d ? fmt.bytes(d.bytes) : ''];
  }).slice(0, 8), [[40, 200], [290, 80, true], [320, 160], [555, 80, true]]);
  const protos = parse(a.protocolos);
  if (protos.length) { espaco(18); y += 4; pdf.texto(40, y, `Protocolos: ${protos.map((p) => `${mitigacao.NOMES_PROTO[p.chave] ?? p.chave} ${fmt.num((p.bytes / total) * 100, 0)}%`).join(' · ')}`, { tam: 9 }); y += 14; }

  titulo('Ações de bloqueio (BGP)');
  tabela(['Ação', 'Situação', 'Pedido / aprovação', 'Ativa de → até'], mitigacoes.map((m) => [
    mitigacao.descricao(m), STATUS_M[m.status] ?? m.status,
    `${m.origem === 'automatica' ? 'Automático' : m.solicitante ?? 'Manual'}${m.aprovador ? ` / ${m.aprovador}` : ''}`,
    m.ativada_em ? `${fmt.dataHora(m.ativada_em, fuso)} → ${fmt.dataHora(m.retirada_em ?? m.expira_em, fuso)}` : m.motivo ?? '—']),
  [[40, 210], [255, 85], [345, 95], [445, 110]], 'Nenhuma ação de bloqueio para este ataque.');

  titulo('Linha do tempo');
  for (const e of eventos) {
    espaco(26);
    let det = e.detalhes ?? '';
    try { const x = JSON.parse(det); det = x.descricao ?? x.motivo ?? (x.medido ? `${fmt.metrica(x.metrica, x.medido)} acima do limite de ${fmt.metrica(x.metrica, x.limite)}` : ''); } catch { /* texto */ }
    pdf.texto(40, y, fmt.dataHora(e.em, fuso, { segundos: true }), { tam: 8, rgb: FRACO });
    pdf.texto(150, y, EVENTOS[e.tipo] ?? e.tipo.replaceAll('_', ' '), { tam: 9, negrito: true });
    pdf.texto(555, y, e.usuario_nome ?? 'Sistema', { tam: 8, rgb: FRACO, direita: true });
    y += 12;
    if (det) { pdf.texto(150, y, det, { tam: 8.5, max: 400 }); y += 12; }
    y += 2;
  }
  rodape();
  return pdf.gerar();
}

module.exports = { gerarRelatorioAtaque };
