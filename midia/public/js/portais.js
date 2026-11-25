/** Portais: o anunciante acompanha as próprias campanhas; o lojista acompanha as TVs do ponto dele. */
import { api, qs, baixar } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, campo, escolha, area, lerForm, repetir,
  inteiro, dinheiro, duracao, dataBr, dataHora, etiquetaDe, etiqueta, percentual, competenciaTexto, situacao,
  diasTexto, faixaHorario, COBRANCA, ORIENTACOES, STATUS_CAMPANHA, STATUS_MIDIA, STATUS_FATURA, STATUS_CONTRATO, STATUS_REPASSE, STATUS_COMUNICADO,
  TIPOS_COMUNICADO, REPASSES, CATEGORIAS,
} from './ui.js';
import { cartao, indicador, tabela, vazio, previa, enviarArquivo, campoFotoComunicado } from './comum.js';
import { barras, pizza, CORES } from './graficos.js';

const hojeLocal = () => new Date().toLocaleDateString('en-CA');
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };

// ================================================================ Anunciante
async function resumoAnunciante(ctx) {
  const pintar = async () => {
    const d = await api.get('/anunciante/resumo');
    limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
      el('div', { class: 'c3' }, indicador({ rotulo: 'Campanhas no ar', valor: inteiro(d.campanhas.ativas), ic: 'campanhas', cor: 'roxo', nota: d.campanhas.aguardando ? `${d.campanhas.aguardando} aguardando aprovação` : null })),
      el('div', { class: 'c3' }, indicador({ rotulo: `Inserções em ${competenciaTexto(d.competencia)}`, valor: inteiro(d.mes.insercoes), ic: 'tocar', nota: `em até ${inteiro(d.mes.telas)} TVs` })),
      el('div', { class: 'c3' }, indicador({ rotulo: 'Pessoas alcançadas (estimativa)', valor: inteiro(d.mes.impactos), ic: 'pessoas', cor: 'ciano' })),
      el('div', { class: 'c3' }, indicador({
        rotulo: 'Faturas em aberto', valor: dinheiro(d.faturas.aberto_centavos), ic: 'faturamento',
        cor: d.faturas.atrasadas ? 'vermelho' : 'verde', nota: d.faturas.atrasadas ? `${d.faturas.atrasadas} atrasada(s)` : `${d.faturas.abertas} em aberto`,
      })),
      el('div', { class: 'c8' }, cartao('Inserções por dia (últimos 14 dias)',
        d.por_dia.length
          ? barras(d.por_dia.map((x) => ({ rotulo: x.data, valor: x.insercoes, titulo: `${dataBr(x.data)}: ${inteiro(x.insercoes)} inserções` })))
          : vazio('Sem exibições ainda.'))),
      el('div', { class: 'c4' }, cartao('Hoje',
        el('div', {}, el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Inserções hoje'), el('strong', { class: 'num' }, inteiro(d.hoje.insercoes))),
          el('div', { class: 'chave' }, el('span', { class: 'mudo' }, 'Criativos aguardando aprovação'), el('strong', { class: 'num' }, inteiro(d.midias_pendentes)))))),
      el('div', { class: 'c12' }, cartao('Desempenho das campanhas no mês', tabela([
        [(c) => c.campanha, 'Campanha'],
        [(c) => inteiro(c.insercoes), 'Inserções', 'num dir'],
        [(c) => duracao(c.segundos), 'Tempo no ar', 'num dir'],
        [(c) => inteiro(c.telas), 'TVs', 'num dir'],
        [(c) => inteiro(c.pontos), 'Pontos', 'num dir'],
        [(c) => inteiro(c.impactos), 'Pessoas alcançadas', 'num dir'],
      ], d.desempenho, { vazioTexto: 'Nenhuma exibição neste mês.' })))));
  };
  await pintar();
  ctx.parar(repetir(pintar, 120_000));
}

async function campanhasAnunciante(ctx) {
  const d = await api.get('/anunciante/campanhas');
  limpar(ctx.conteudo, el('div', { class: 'cartao' }, tabela([
    [(c) => c.nome, 'Campanha'],
    [(c) => etiquetaDe(STATUS_CAMPANHA, c.status), 'Situação'],
    [(c) => `${dataBr(c.inicio)} → ${c.fim ? dataBr(c.fim) : 'sem fim'}`, 'Período'],
    [(c) => `${diasTexto(c.dias_semana)} · ${faixaHorario(c.hora_inicio, c.hora_fim)}`, 'Quando passa'],
    [(c) => `${c.insercoes_hora}/h`, 'Inserções', 'num dir'],
    [(c) => inteiro(c.criativos), 'Criativos', 'num dir'],
    [(c) => inteiro(c.insercoes_total), 'Exibições', 'num dir'],
  ], d.itens, { aoClicar: (c) => abrirCampanhaAnunciante(c.id), vazioTexto: 'Nenhuma campanha ainda. Fale com a equipe para criar a primeira.' })));
}

async function abrirCampanhaAnunciante(id) {
  const d = await api.get(`/anunciante/campanhas/${id}`);
  await modal(d.nome, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' }, etiquetaDe(STATUS_CAMPANHA, d.status),
        el('span', { class: 'mudo pequeno' }, `${dataBr(d.inicio)} → ${d.fim ? dataBr(d.fim) : 'sem fim'} · ${diasTexto(d.dias_semana)} · ${faixaHorario(d.hora_inicio, d.hora_fim)}`)),
      el('span', { class: 'mudo pequeno' }, COBRANCA[d.cobranca])),
    d.motivo ? el('p', { class: 'aviso' }, d.motivo) : null,
    el('div', { class: 'grade', style: 'margin:16px 0' },
      indicador({ rotulo: 'Inserções', valor: inteiro(d.desempenho.insercoes), ic: 'tocar' }),
      indicador({ rotulo: 'Pessoas alcançadas', valor: inteiro(d.desempenho.impactos), ic: 'pessoas', cor: 'ciano' }),
      indicador({ rotulo: 'TVs', valor: inteiro(d.desempenho.telas), ic: 'telas', cor: 'roxo' }),
      indicador({ rotulo: 'Tempo no ar', valor: duracao(d.desempenho.segundos), ic: 'relogio', cor: 'verde' })),
    el('h3', {}, 'Criativos'),
    tabela([
      [(m) => m.nome, 'Criativo'], [(m) => (m.tipo === 'video' ? 'Vídeo' : 'Imagem'), 'Tipo'],
      [(m) => `${m.duracao_s}s`, 'Duração', 'num dir'], [(m) => etiquetaDe(STATUS_MIDIA, m.status), 'Situação'],
      [(m) => m.motivo ?? '—', 'Observação'],
    ], d.criativos, { vazioTexto: 'Nenhum criativo nesta campanha.' }),
    el('h3', {}, 'Onde passou'),
    tabela([
      [(p) => p.local, 'Ponto'], [(p) => `${p.cidade}/${p.uf}`, 'Cidade'], [(p) => CATEGORIAS[p.categoria] ?? p.categoria, 'Categoria'],
      [(p) => inteiro(p.telas), 'TVs', 'num dir'], [(p) => inteiro(p.insercoes), 'Inserções', 'num dir'],
    ], d.pontos, { vazioTexto: 'Ainda sem exibições.' }),
    el('div', { class: 'linha entre', style: 'margin-top:18px' }, el('span', {}), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

async function criativosAnunciante(ctx) {
  const corpo = el('div', {});
  const pintar = async () => {
    const d = await api.get('/anunciante/midias');
    limpar(corpo, d.itens.length
      ? el('div', { class: 'midias' }, d.itens.map((m) => el('div', { class: 'midia-cartao' }, previa(m, { rota: 'anunciante' }),
        el('div', { class: 'corpo' },
          el('h3', { title: m.nome }, m.nome),
          el('div', { class: 'linha' }, etiquetaDe(STATUS_MIDIA, m.status), el('span', { class: 'pequeno mudo' }, `${m.duracao_s}s`)),
          m.motivo ? el('div', { class: 'pequeno', style: 'color:var(--erro)' }, m.motivo) : null,
          m.campanhas ? el('div', { class: 'pequeno mudo' }, `Em ${m.campanhas} campanha(s)`) : el('div', { class: 'pequeno mudo' }, 'Ainda não usado em campanha')))))
      : vazio('Nenhum criativo enviado. Envie a imagem ou o vídeo do seu anúncio.'));
  };
  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'A equipe aprova cada criativo antes de ele ir para as telas.'),
      el('button', { class: 'btn primario', onclick: () => enviarCriativoPortal('anunciante', pintar) }, icone('enviar'), 'Enviar criativo')),
    corpo);
  await pintar();
}

async function provaAnunciante(ctx) {
  const estado = { de: diasAtras(29), ate: hojeLocal(), pagina: 1 };
  const corpo = el('div', { class: 'cartao' });
  const pintar = async () => {
    const d = await api.get(`/anunciante/prova${qs({ ...estado, limite: 200 })}`);
    limpar(corpo,
      el('p', { class: 'pequeno mudo' }, `${inteiro(d.total)} exibições no período · ${duracao(d.segundos)} de tela`),
      tabela([
        [(e) => dataHora(e.exibida_em), 'Data e hora'],
        [(e) => el('div', {}, el('div', {}, e.local), el('div', { class: 'pequeno mudo' }, `${e.tela} · ${e.cidade}/${e.uf}`)), 'Onde'],
        [(e) => e.campanha, 'Campanha'],
        [(e) => e.midia ?? '—', 'Criativo'],
        [(e) => `${e.duracao_s}s`, 'Duração', 'num dir'],
      ], d.itens, { vazioTexto: 'Nenhuma exibição no período.' }),
      d.total > 200 ? el('div', { class: 'paginacao' },
        el('button', { class: 'btn pequeno', disabled: estado.pagina <= 1, onclick: () => { estado.pagina--; pintar(); } }, 'Anteriores'),
        el('span', { class: 'pequeno mudo' }, `Página ${estado.pagina} de ${Math.ceil(d.total / 200)}`),
        el('button', { class: 'btn pequeno', disabled: estado.pagina >= Math.ceil(d.total / 200), onclick: () => { estado.pagina++; pintar(); } }, 'Próximas')) : null);
  };
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('De', { type: 'date', value: estado.de, onchange: (e) => { estado.de = e.target.value; estado.pagina = 1; pintar(); } }),
      campo('Até', { type: 'date', value: estado.ate, onchange: (e) => { estado.ate = e.target.value; estado.pagina = 1; pintar(); } }),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, () => baixar(`/anunciante/prova${qs({ de: estado.de, ate: estado.ate, csv: 1 })}`, `prova-de-exibicao-${estado.de}-${estado.ate}.csv`)),
      }, icone('baixar'), 'Baixar CSV')),
    corpo);
  await pintar();
}

const COBRANCA_CONTRATO = { mensal: 'Valor mensal', cpm: 'CPM (por mil impactos)', pacote: 'Pacote fechado', cortesia: 'Cortesia' };

/** O contrato como o cliente precisa ver: o que foi combinado, sem poder mexer. */
const cartaoContrato = (c) => el('div', { class: 'cartao raso' },
  el('div', { class: 'linha entre' },
    el('div', {},
      el('strong', {}, `Contrato ${c.numero}`),
      el('div', { class: 'pequeno mudo' }, c.objeto || 'Veiculação de publicidade na rede de telas')),
    etiquetaDe(STATUS_CONTRATO, c.status)),
  el('div', { class: 'dados', style: 'margin-top:12px' },
    el('div', {}, el('span', { class: 'rotulo' }, 'Vigência'),
      el('span', {}, `${dataBr(c.inicio)} — ${c.fim ? dataBr(c.fim) : 'sem data de término'}`)),
    el('div', {}, el('span', { class: 'rotulo' }, 'Cobrança'),
      el('span', {}, COBRANCA_CONTRATO[c.cobranca] ?? c.cobranca)),
    c.cobranca !== 'cortesia'
      ? el('div', {}, el('span', { class: 'rotulo' }, c.cobranca === 'cpm' ? 'CPM contratado' : 'Valor'),
        el('span', {}, dinheiro(c.valor_centavos)))
      : null,
    el('div', {}, el('span', { class: 'rotulo' }, 'Vencimento'), el('span', {}, `todo dia ${c.vencimento_dia}`)),
    c.reajuste
      ? el('div', {}, el('span', { class: 'rotulo' }, 'Reajuste'),
        el('span', {}, c.ultimo_reajuste ? `${c.reajuste} · último em ${dataBr(c.ultimo_reajuste)}` : c.reajuste))
      : null,
    el('div', {}, el('span', { class: 'rotulo' }, 'Renovação'),
      el('span', {}, (c.renovacao_automatica ? 'Automática' : 'Mediante novo aceite')
        + (c.renovacoes ? ` · ${c.renovacoes}ª vigência` : ''))),
    c.agencia ? el('div', {}, el('span', { class: 'rotulo' }, 'Agência'), el('span', {}, c.agencia)) : null,
    el('div', {}, el('span', { class: 'rotulo' }, 'Campanhas'), el('span', {}, `${inteiro(c.campanhas)} no contrato`))));

async function faturasAnunciante(ctx) {
  const d = await api.get('/anunciante/faturas');
  const ativos = d.contratos.filter((c) => c.status === 'ativo');
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    d.contratos.length
      ? cartao(ativos.length > 1 ? 'Meus contratos' : 'Meu contrato',
        el('div', { class: 'coluna' }, d.contratos.map(cartaoContrato)),
        el('p', { class: 'pequeno mudo', style: 'margin:12px 0 0' },
          'Para alterar qualquer ponto do contrato, fale com a equipe comercial.'))
      : null,
    cartao('Faturas', tabela([
      [(f) => competenciaTexto(f.competencia), 'Competência'],
      [(f) => dinheiro(f.valor_centavos), 'Valor', 'num dir'],
      [(f) => dataBr(f.vencimento), 'Vencimento'],
      [(f) => (f.atrasada ? etiqueta('Atrasada', 'erro') : etiquetaDe(STATUS_FATURA, f.status)), 'Situação'],
      [(f) => (f.pago_em ? dataBr(f.pago_em) : '—'), 'Pagamento'],
      [(f) => (f.nf_numero ? `NF ${f.nf_numero}` : '—'), 'Nota fiscal'],
    ], d.itens, { aoClicar: (f) => abrirFaturaAnunciante(f.id), vazioTexto: 'Nenhuma fatura.' }))));
}

async function abrirFaturaAnunciante(id) {
  const f = await api.get(`/anunciante/faturas/${id}`);
  await modal(`Fatura ${competenciaTexto(f.competencia)}`, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' }, f.atrasada ? etiqueta('Atrasada', 'erro') : etiquetaDe(STATUS_FATURA, f.status),
        el('span', { class: 'mudo pequeno' }, `Vence em ${dataBr(f.vencimento)}`)),
      el('strong', { style: 'font-size:20px' }, dinheiro(f.valor_centavos))),
    f.agencia ? el('p', { class: 'mudo pequeno', style: 'margin:6px 0 0' }, `Veiculação pela agência ${f.agencia}.`) : null,
    el('table', { class: 'fatura-itens', style: 'margin:16px 0' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Campanha'), el('th', { class: 'dir' }, 'Inserções'), el('th', { class: 'dir' }, 'Pessoas alcançadas'), el('th', { class: 'dir' }, 'Valor'))),
      el('tbody', {}, f.itens.map((i) => el('tr', {}, el('td', {}, i.descricao), el('td', { class: 'dir num' }, inteiro(i.insercoes)),
        el('td', { class: 'dir num' }, inteiro(i.impactos)), el('td', { class: 'dir num' }, dinheiro(i.valor_centavos))))),
      f.comissao_agencia_centavos ? el('tfoot', {},
        el('tr', {}, el('td', { colspan: 3 }, 'Bruto'), el('td', { class: 'dir num' }, dinheiro(f.bruto_centavos))),
        el('tr', {}, el('td', { colspan: 3 }, 'Comissão de agência'), el('td', { class: 'dir num' }, `- ${dinheiro(f.comissao_agencia_centavos)}`)),
        el('tr', {}, el('td', { colspan: 3 }, 'Total a pagar'), el('td', { class: 'dir num' }, dinheiro(f.valor_centavos)))) : null),
    f.pix ? el('div', { class: 'pix' },
      f.pix.qr ? el('img', { src: f.pix.qr, alt: 'QR Code do PIX' }) : el('div', {}),
      el('div', {}, el('strong', {}, 'PIX copia e cola'), el('div', { class: 'segredo', style: 'margin:8px 0' }, f.pix.codigo),
        el('button', { class: 'btn pequeno', onclick: () => { navigator.clipboard?.writeText(f.pix.codigo); toast('Código PIX copiado.'); } }, 'Copiar código')))
      : el('p', { class: 'mudo' }, 'Para pagar, fale com a equipe.'),
    f.nf_numero ? el('p', { class: 'pequeno mudo', style: 'margin:12px 0 0' },
      `Nota fiscal ${f.nf_numero}, emitida em ${dataBr(f.nf_emitida_em)}. `,
      f.nf_link ? el('a', { href: f.nf_link, target: '_blank', rel: 'noopener' }, 'Abrir a nota') : null) : null,
    el('div', { class: 'linha entre', style: 'margin-top:18px' }, el('span', {}), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

async function redeAnunciante(ctx) {
  const d = await api.get('/anunciante/rede');
  const total = d.pontos.reduce((t, p) => t + p.publico_dia, 0);
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    el('div', { class: 'grade' },
      indicador({ rotulo: 'Pontos na rede', valor: inteiro(d.pontos.length), ic: 'pontos' }),
      indicador({ rotulo: 'TVs', valor: inteiro(d.pontos.reduce((t, p) => t + p.telas, 0)), ic: 'telas', cor: 'roxo' }),
      indicador({ rotulo: 'Público somado por dia', valor: inteiro(total), ic: 'pessoas', cor: 'ciano' })),
    el('div', { class: 'cartao' }, tabela([
      [(p) => p.nome, 'Ponto'], [(p) => CATEGORIAS[p.categoria] ?? p.categoria, 'Categoria'],
      [(p) => `${p.cidade}/${p.uf}`, 'Cidade'], [(p) => inteiro(p.telas), 'TVs', 'num dir'],
      [(p) => inteiro(p.publico_dia), 'Público/dia', 'num dir'],
    ], d.pontos, { vazioTexto: 'Nenhum ponto ativo.' }))));
}

// ================================================================ Lojista
async function resumoLojista(ctx) {
  const pintar = async () => {
    const d = await api.get('/ponto/resumo');
    limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
      el('div', { class: 'c3' }, indicador({
        rotulo: 'TVs no ar', valor: `${d.telas.filter((t) => t.online).length} de ${d.telas.length}`, ic: 'telas',
        cor: d.telas.every((t) => t.online) ? 'verde' : 'laranja', nota: d.aberto ? 'Ponto aberto agora' : 'Ponto fechado agora',
      })),
      el('div', { class: 'c3' }, indicador({ rotulo: 'Exibições hoje', valor: inteiro(d.hoje.insercoes), ic: 'tocar', nota: duracao(d.hoje.segundos) })),
      el('div', { class: 'c3' }, indicador({ rotulo: `Exibições em ${competenciaTexto(new Date().toLocaleDateString('en-CA').slice(0, 7))}`, valor: inteiro(d.mes.insercoes), ic: 'relatorios', cor: 'roxo' })),
      el('div', { class: 'c3' }, indicador({
        rotulo: d.ponto.repasse_tipo === 'nenhum' ? 'Comunicados no ar' : 'Repasse a receber',
        valor: d.ponto.repasse_tipo === 'nenhum'
          ? inteiro((d.comunicados ?? []).filter((c) => c.status === 'aprovado').length)
          : dinheiro(d.a_receber_centavos),
        ic: d.ponto.repasse_tipo === 'nenhum' ? 'aprovacoes' : 'dinheiro',
        cor: 'verde',
        nota: d.ponto.repasse_tipo === 'fixo'
          ? `${dinheiro(d.ponto.repasse_fixo_centavos)} por mês`
          : REPASSES[d.ponto.repasse_tipo ?? 'comissao'],
      })),

      el('div', { class: 'c12' }, cartao('Minhas TVs',
        el('div', { class: 'telas' }, d.telas.map((t) => el('div', { class: 'tela-cartao' },
          el('div', { class: `moldura${t.orientacao === 'retrato' ? ' retrato' : ''}` },
            el('span', { class: `selo${t.online ? '' : ' off'}` }, t.online ? 'no ar' : 'sem contato'),
            el('div', { class: 'vazia' }, t.item_atual ? el('div', {}, el('div', { style: 'font-size:11px;opacity:.7' }, 'No ar agora'), el('strong', {}, t.item_atual)) : 'Sem informação')),
          el('div', { class: 'corpo' },
            el('h3', {}, t.nome),
            el('div', { class: 'pequeno mudo' }, t.ultimo_contato ? `Último contato: ${dataHora(t.ultimo_contato)}` : 'Aparelho ainda não pareado'),
            t.aviso ? el('p', { class: 'aviso', style: 'margin:0' }, `Seu aviso: “${t.aviso}”`) : null,
            el('div', { class: 'acoes' },
              el('button', { class: 'btn pequeno', onclick: () => verProgramacao(t) }, icone('olho'), 'O que está passando'),
              d.pode_avisar ? el('button', { class: 'btn pequeno', onclick: () => avisoLojista(t, pintar) }, 'Meu aviso') : null))))))),

      el('div', { class: 'c6' }, cartao('Exibições por dia',
        d.por_dia.length ? barras(d.por_dia.map((x) => ({ rotulo: x.data, valor: x.insercoes, titulo: `${dataBr(x.data)}: ${inteiro(x.insercoes)}` }))) : vazio('Sem exibições ainda.'))),

      el('div', { class: 'c6' }, cartao('Meus repasses', tabela([
        [(r) => competenciaTexto(r.competencia), 'Mês'],
        [(r) => dinheiro(r.valor_centavos), 'Valor', 'num dir'],
        [(r) => etiquetaDe(STATUS_REPASSE, r.status), 'Situação'],
      ], d.repasses, { vazioTexto: 'Nenhum repasse ainda.' })))));
  };
  await pintar();
  ctx.parar(repetir(pintar, 60_000));
}

async function verProgramacao(t) {
  const d = await api.get(`/ponto/telas/${t.id}/programacao`);
  await modal(`O que está passando — ${d.tela.nome}`, (fechar) => [
    el('p', { class: 'mudo', style: 'margin:0' }, `Loop de ${duracao(d.duracao_s)}, com ${d.itens.length} itens.`),
    tabela([
      [(i) => i.ordem, '#', 'num'],
      [(i) => i.nome, 'Conteúdo'],
      [(i) => (i.publicidade ? etiqueta('Publicidade', 'info') : etiqueta('Conteúdo da loja / institucional', 'ok')), 'Tipo'],
      [(i) => `${i.duracao_s}s`, 'Duração', 'num dir'],
    ], d.itens, { vazioTexto: 'Esta TV está sem programação agora.' }),
    el('div', { class: 'linha entre', style: 'margin-top:14px' }, el('span', {}), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

const avisoLojista = (t, recarregar) => formModal(`Aviso na TV — ${t.nome}`, () => [
  el('p', { class: 'mudo', style: 'margin:0' }, 'O texto passa na faixa de baixo da TV. Deixe em branco para tirar.'),
  area('Avisos (um por linha; com mais de um, eles passam correndo no rodapé)', { name: 'aviso', rows: 4, maxlength: 1000, placeholder: 'Pão quentinho às 17h\nAmanhã abrimos às 8h' }, t.aviso ?? ''),
  escolha('Por quanto tempo', 'horas', { 2: '2 horas', 6: '6 horas', 12: '12 horas', 24: '1 dia', 48: '2 dias', 72: '3 dias' }, 12),
], async (d) => {
  await api.put(`/ponto/telas/${t.id}/aviso`, { aviso: d.aviso || null, horas: Number(d.horas) });
  toast(d.aviso ? 'Aviso no ar.' : 'Aviso retirado.');
  recarregar();
}, { rotulo: 'Salvar' });

/** Comunicados do ponto: quem responde pelo lugar escreve e o recado entra entre os anúncios. */
async function comunicadosLojista(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const pintar = async () => {
    const d = await api.get('/ponto/comunicados');
    limpar(corpo,
      el('p', { class: 'mudo', style: 'margin:0 0 12px' }, d.automatico
        ? 'O que você publicar entra na TV direto.'
        : 'O que você publicar passa por uma conferência rápida da equipe antes de ir para a TV.'),
      tabela([
        [(c) => el('div', {}, el('div', {}, c.titulo), el('div', { class: 'pequeno mudo' }, c.texto.slice(0, 90))), 'Comunicado'],
        [(c) => TIPOS_COMUNICADO[c.tipo] ?? c.tipo, 'Tipo'],
        [(c) => `${dataBr(c.inicio)} a ${dataBr(c.fim)}`, 'No ar'],
        [(c) => etiquetaDe(STATUS_COMUNICADO, c.status), 'Situação'],
        [(c) => c.motivo ?? '—', 'Observação'],
        [(c) => el('div', { class: 'acoes' },
          el('button', { class: 'btn pequeno', onclick: () => editarComunicadoPonto(c, pintar) }, 'Editar'),
          el('button', {
            class: 'icone-btn perigo', title: 'Remover', onclick: (e) => acao(e.target, async () => {
              if (!await confirmar('Remover comunicado', `Tirar "${c.titulo}" da TV?`, 'Remover')) return;
              await api.del(`/ponto/comunicados/${c.id}`);
              toast('Comunicado removido.');
              pintar();
            }),
          }, icone('lixo'))), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nenhum comunicado ainda. Use para avisar sobre assembleia, manutenção, entrega de encomendas…' }));
  };
  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'Seus recados aparecem na TV entre os anúncios, escritos em letras grandes.'),
      el('button', { class: 'btn primario', onclick: () => editarComunicadoPonto(null, pintar) }, icone('mais'), 'Novo comunicado')),
    corpo);
  await pintar();
}

function editarComunicadoPonto(c, recarregar) {
  const hoje = hojeLocal();
  const emDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const foto = campoFotoComunicado(c, 'ponto');
  return formModal(c ? 'Editar comunicado' : 'Novo comunicado', () => [
    campo('Título', { name: 'titulo', value: c?.titulo ?? '', required: true, maxlength: 80, placeholder: 'Ex.: Assembleia dia 12' }),
    el('label', { class: 'campo' }, 'Texto',
      (() => { const t = el('textarea', { name: 'texto', required: true, maxlength: 400, placeholder: 'Ex.: Às 19h no salão de festas.' }); t.value = c?.texto ?? ''; return t; })()),
    el('div', { class: 'tres' },
      escolha('Tipo', 'tipo', TIPOS_COMUNICADO, c?.tipo ?? 'aviso'),
      campo('No ar de', { name: 'inicio', type: 'date', value: c?.inicio ?? hoje, required: true }),
      campo('até', { name: 'fim', type: 'date', value: c?.fim ?? emDias(7), required: true })),
    el('div', { class: 'duas' },
      campo('Data do evento (opcional)', { name: 'evento_em', type: 'date', value: c?.evento_em ?? '' }),
      campo('Hora', { name: 'evento_hora', type: 'time', value: c?.evento_hora ?? '' })),
    el('p', { class: 'pequeno mudo', style: 'margin:-4px 0 0' },
      'Com a data preenchida, o recado também entra na agenda da tela — o quadro "O que vem por aí" que quem passa acompanha.'),
    foto.campo,
  ], async (d) => {
    const salvo = c ? await api.patch(`/ponto/comunicados/${c.id}`, d) : await api.post('/ponto/comunicados', d);
    await foto.salvar(salvo.id);
    toast(c ? 'Comunicado atualizado.' : 'Comunicado enviado.');
    recarregar();
  });
}

async function conteudoLojista(ctx) {
  const corpo = el('div', {});
  const pintar = async () => {
    const d = await api.get('/ponto/resumo');
    limpar(corpo, d.midias.length
      ? el('div', { class: 'midias' }, d.midias.map((m) => el('div', { class: 'midia-cartao' }, previa(m, { rota: 'ponto' }),
        el('div', { class: 'corpo' },
          el('h3', { title: m.nome }, m.nome),
          el('div', { class: 'linha' }, etiquetaDe(STATUS_MIDIA, m.status)),
          m.motivo ? el('div', { class: 'pequeno', style: 'color:var(--erro)' }, m.motivo) : null,
          el('div', { class: 'acoes' }, el('button', {
            class: 'btn pequeno perigo', onclick: (e) => acao(e.target, async () => {
              if (!await confirmar('Remover conteúdo', `Apagar "${m.nome}"?`, 'Remover')) return;
              await api.del(`/ponto/midias/${m.id}`);
              toast('Conteúdo removido.');
              pintar();
            }),
          }, 'Remover'))))))
      : vazio('Nenhum conteúdo seu ainda. Você pode mandar um cartaz ou vídeo da loja para entrar entre os anúncios.'));
  };
  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'A equipe aprova antes de o conteúdo entrar na TV.'),
      el('button', { class: 'btn primario', onclick: () => enviarCriativoPortal('ponto', pintar) }, icone('enviar'), 'Enviar conteúdo')),
    corpo);
  await pintar();
}

async function repassesLojista(ctx) {
  const d = await api.get('/ponto/resumo');
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    el('div', { class: 'grade' },
      indicador({ rotulo: 'A receber', valor: dinheiro(d.a_receber_centavos), ic: 'dinheiro', cor: 'verde' }),
      indicador({
        rotulo: 'Como foi combinado', ic: 'repasses',
        valor: d.ponto.repasse_tipo === 'fixo' ? 'Valor fixo' : (d.ponto.repasse_tipo === 'nenhum' ? 'Sem repasse' : percentual(d.ponto.comissao_percentual)),
        nota: REPASSES[d.ponto.repasse_tipo ?? 'comissao'],
      }),
      indicador({ rotulo: 'Público estimado da loja', valor: inteiro(d.ponto.publico_dia), ic: 'pessoas', cor: 'ciano', nota: 'pessoas por dia' })),
    el('div', { class: 'cartao' }, tabela([
      [(r) => competenciaTexto(r.competencia), 'Mês'],
      [(r) => dinheiro(r.base_centavos), 'Receita das minhas TVs', 'num dir'],
      [(r) => percentual(r.comissao_percentual), 'Comissão', 'num dir'],
      [(r) => el('strong', {}, dinheiro(r.valor_centavos)), 'Meu repasse', 'num dir'],
      [(r) => etiquetaDe(STATUS_REPASSE, r.status), 'Situação'],
      [(r) => (r.pago_em ? dataBr(r.pago_em) : '—'), 'Pago em'],
    ], d.repasses, { vazioTexto: 'Nenhum repasse ainda. Eles aparecem no fechamento de cada mês.' }))));
}

async function relatoriosLojista(ctx) {
  const estado = { de: diasAtras(29), ate: hojeLocal() };
  const corpo = el('div', { class: 'coluna' });
  const pintar = async () => {
    const d = await api.get(`/ponto/relatorios${qs(estado)}`);
    limpar(corpo,
      el('div', { class: 'cartao' }, el('h2', {}, 'Exibições por dia'),
        d.por_dia.length ? barras(d.por_dia.map((x) => ({ rotulo: x.data, valor: x.insercoes, titulo: `${dataBr(x.data)}: ${inteiro(x.insercoes)}` }))) : vazio('Sem exibições no período.')),
      el('div', { class: 'cartao' }, el('h2', {}, 'Por TV'), tabela([
        [(t) => t.tela, 'TV'],
        [(t) => inteiro(t.insercoes), 'Exibições', 'num dir'],
        [(t) => inteiro(t.insercoes_pagas), 'De publicidade', 'num dir'],
        [(t) => duracao(t.segundos), 'Tempo no ar', 'num dir'],
        [(t) => inteiro(t.dias), 'Dias', 'num dir'],
      ], d.telas, { vazioTexto: 'Sem exibições no período.' })));
  };
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('De', { type: 'date', value: estado.de, onchange: (e) => { estado.de = e.target.value; pintar(); } }),
      campo('Até', { type: 'date', value: estado.ate, onchange: (e) => { estado.ate = e.target.value; pintar(); } })),
    corpo);
  await pintar();
}

/** Envio de arquivo pelos portais (o criativo entra como pendente de aprovação). */
function enviarCriativoPortal(rota, recarregar) {
  return modal(rota === 'anunciante' ? 'Enviar criativo' : 'Enviar conteúdo da loja', (fechar) => {
    const arquivo = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm', required: true });
    const nome = campo('Nome', { name: 'nome', required: true, maxlength: 140 });
    const duracaoCampo = campo('Duração da imagem (segundos, opcional)', { name: 'duracao_s', type: 'number', min: 1, max: 600 });
    arquivo.addEventListener('change', () => {
      const f = arquivo.files?.[0];
      if (f && !nome.querySelector('input').value) nome.querySelector('input').value = f.name.replace(/\.[^.]+$/, '').slice(0, 140);
      duracaoCampo.hidden = Boolean(f && f.type.startsWith('video'));
    });
    const ok = el('button', { class: 'btn primario largo' }, 'Enviar');
    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Arquivo (JPG, PNG, WEBP, MP4, MOV ou WEBM)', arquivo),
      nome, duracaoCampo,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Para TV, o ideal é 1920×1080 (deitado) ou 1080×1920 (em pé).'),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const alvo = arquivo.files?.[0];
        if (!alvo) throw new Error('Escolha o arquivo.');
        await enviarArquivo(`${rota}/midias`, alvo, { nome: d.nome, duracao_s: d.duracao_s });
        toast('Enviado! A equipe vai aprovar antes de ir para as telas.');
        fechar();
        recarregar();
      });
    });
    return f;
  });
}

export const TELAS_ANUNCIANTE = {
  resumo: resumoAnunciante,
  campanhas: campanhasAnunciante,
  criativos: criativosAnunciante,
  prova: provaAnunciante,
  faturas: faturasAnunciante,
  rede: redeAnunciante,
};

export const TELAS_LOJISTA = {
  resumo: resumoLojista,
  comunicados: comunicadosLojista,
  conteudo: conteudoLojista,
  repasses: repassesLojista,
  relatorios: relatoriosLojista,
};
