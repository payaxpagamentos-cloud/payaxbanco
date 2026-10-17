import { api, sessao, usarSessao } from './api.js';
import { el, $, limpar, dinheiro, km, minutos, dataHora, FORMAS, CATEGORIAS, etiquetaStatus, toast, acao, perguntar, confirmar, marca, repetir, modal, lerForm,
  hojeLocal, somarDias } from './ui.js';
import { criarMapa, camada, ICONES, enquadrar } from './mapa.js';
import { telaEntrada } from './entrada.js';

usarSessao('central');
const raiz = $('#app');
let usuario = null, telaAtual = 'painel', pararTela = null, contadores = {};

window.addEventListener('taxi:sair', () => iniciar());

function iniciar() {
  pararTela?.();
  const s = sessao.get();
  if (!s?.token || !['admin', 'operador'].includes(s.usuario?.perfil)) {
    telaEntrada(raiz, { titulo: 'Painel da central', perfis: ['admin', 'operador'], cadastro: null, aoEntrar: iniciar });
    return;
  }
  usuario = s.usuario;
  try { telaAtual = sessionStorage.getItem('taxi.central.tela') || 'painel'; } catch { /* padrão */ }
  ir(telaAtual);
}

const TELAS = {
  painel: ['Painel', telaPainel],
  mapa: ['Mapa ao vivo', telaMapa],
  corridas: ['Corridas', telaCorridas],
  motoristas: ['Motoristas', telaMotoristas],
  passageiros: ['Passageiros', telaPassageiros],
  empresas: ['Empresas', telaEmpresas],
  pagamentos: ['Pagamentos', telaPagamentos],
  repasses: ['Repasses', telaRepasses],
  relatorios: ['Relatórios', telaRelatorios],
  tarifas: ['Tarifas e regras', telaTarifas],
  equipe: ['Equipe', telaEquipe, 'admin'],
};

function ir(tela) {
  pararTela?.();
  pararTela = null;
  if (!TELAS[tela] || (TELAS[tela][2] && usuario.perfil !== TELAS[tela][2])) tela = 'painel';
  telaAtual = tela;
  try { sessionStorage.setItem('taxi.central.tela', tela); } catch { /* ignora */ }
  const conteudo = el('main', { class: 'conteudo' });
  limpar(raiz, el('div', { class: 'central' },
    el('nav', { class: 'menu' }, marca(), Object.entries(TELAS).filter(([, t]) => !t[2] || t[2] === usuario.perfil).map(([k, [rotulo]]) =>
      el('button', { class: k === tela ? 'on' : '', onclick: () => ir(k) }, rotulo, contadores[k] ? el('span', { class: 'contador' }, contadores[k]) : null)),
    el('div', { class: 'rodape' }, usuario.nome, el('br'), el('a', { href: '#', style: 'color:inherit', onclick: (e) => { e.preventDefault(); sessao.limpar(); iniciar(); } }, 'Sair'))),
    conteudo));
  Promise.resolve(TELAS[tela][1](conteudo)).catch((err) => toast(err.message, true));
}

const cabeca = (titulo, ...acoes) => el('div', { class: 'cabeca' }, el('h1', { style: 'margin:0' }, titulo), el('div', { class: 'linha' }, acoes));
const indicador = (rotulo, valor, nota) => el('div', { class: 'cartao indicador' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor num' }, valor), nota ? el('div', { class: 'nota' }, nota) : null);
const tabela = (colunas, linhas, vazio = 'Nada por aqui.') => linhas.length
  ? el('div', { class: 'cartao rolagem', style: 'padding:0' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.startsWith('>') ? 'dir' : '' }, c.replace(/^>/, ''))))),
    el('tbody', {}, linhas)))
  : el('div', { class: 'cartao' }, el('p', { class: 'mudo', style: 'margin:0' }, vazio));
const td = (conteudo, dir = false) => el('td', { class: dir ? 'dir num' : '' }, conteudo);
const botao = (texto, classe, fn) => {
  const b = el('button', { class: `btn pequeno ${classe}` }, texto);
  b.addEventListener('click', () => acao(b, fn));
  return b;
};
const situacaoEtq = (s) => el('span', { class: `etiqueta ${{ aprovado: 'ok', pendente: 'aviso', recusado: 'erro', bloqueado: 'erro', pago: 'ok', paga: 'ok', concluida: 'ok',
  faturado: 'info', aberta: 'aviso', ativa: 'ok', suspensa: 'erro', liberado: 'ok', estornado: 'erro', cancelado: 'erro', cancelada: 'erro' }[s] ?? ''}` }, s);

function filtroPeriodo(estado, aoMudar) {
  const de = el('input', { type: 'date', value: estado.de });
  const ate = el('input', { type: 'date', value: estado.ate });
  const mudar = () => { estado.de = de.value; estado.ate = ate.value; aoMudar(); };
  de.addEventListener('change', mudar);
  ate.addEventListener('change', mudar);
  return [el('label', { class: 'campo' }, 'De', de), el('label', { class: 'campo' }, 'Até', ate)];
}

// ---------- Painel ----------
async function telaPainel(c) {
  const corpo = el('div', { class: 'coluna' });
  limpar(c, cabeca('Painel', el('span', { class: 'pequeno mudo' }, 'Atualiza sozinho')), corpo);
  pararTela = repetir(async () => {
    const p = await api.get('/central/painel');
    const cob = p.cobrancas_pendentes;
    contadores = { motoristas: p.motoristas_pendentes + p.veiculos_pendentes, pagamentos: (cob.estorno ?? 0) + (cob.corrida ?? 0), repasses: p.repasses_pendentes.n };
    const a = p.corridas_ativas;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Motoristas online', p.motoristas_online),
        indicador('Procurando motorista', a.solicitada ?? 0, `${a.aguardando_pagamento ?? 0} aguardando pagamento`),
        indicador('Em atendimento', (a.aceita ?? 0) + (a.chegou ?? 0) + (a.em_andamento ?? 0), `${a.em_andamento ?? 0} em viagem`),
        indicador('Corridas hoje', p.hoje.finalizadas, `${p.hoje.canceladas} cancelada(s)`),
        indicador('Faturamento hoje', dinheiro(p.hoje.bruto_centavos), `taxa da plataforma ${dinheiro(p.hoje.taxa_centavos)}`),
        indicador('A repassar', dinheiro(p.a_repassar_centavos), `${p.repasses_pendentes.n} repasse(s) pendente(s)`),
        indicador('Estornos a devolver', cob.estorno ?? 0, `${cob.complemento ?? 0} complemento(s) a receber`),
        indicador('Faturas em aberto', dinheiro(p.faturas_abertas.total), `${p.faturas_abertas.n} fatura(s) de empresas`)),
      (p.motoristas_pendentes || p.veiculos_pendentes) ? el('div', { class: 'aviso' }, `${p.motoristas_pendentes} motorista(s) e ${p.veiculos_pendentes} veículo(s) aguardando aprovação. `,
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); ir('motoristas'); } }, 'Analisar')) : null);
  }, 5000);
}

// ---------- Mapa ----------
async function telaMapa(c) {
  const div = el('div', { class: 'mapa-central' });
  const lista = el('div', { class: 'coluna', style: 'max-height:calc(100vh - 140px);overflow:auto' });
  limpar(c, cabeca('Mapa ao vivo'), el('div', { style: 'display:grid;grid-template-columns:1fr 320px;gap:16px' }, div, lista));
  const mapa = await criarMapa(div, { zoom: 13 });
  const carros = camada(mapa);
  const pedidos = camada(mapa);
  let enquadrado = false;
  pararTela = repetir(async () => {
    const m = await api.get('/central/mapa');
    carros.atualizar(m.motoristas.map((x) => ({ chave: x.id, lat: x.lat, lng: x.lng, icone: x.em_corrida ? ICONES.ocupado() : ICONES.carro(), titulo: `${x.nome} · ${x.placa}`,
      popup: () => el('div', {}, el('strong', {}, x.nome), el('br'), `${x.placa} · ${CATEGORIAS[x.categoria] ?? ''}`, el('br'), x.em_corrida ? 'Em corrida' : 'Livre') })));
    pedidos.atualizar(m.corridas.filter((x) => x.status === 'solicitada').map((x) => ({ chave: x.id, lat: x.origem_lat, lng: x.origem_lng, icone: ICONES.origem(),
      popup: () => el('div', {}, el('strong', {}, `#${x.id} ${x.passageiro_nome}`), el('br'), x.origem_endereco) })));
    if (!enquadrado && (m.motoristas.length || m.corridas.length)) {
      enquadrado = true;
      enquadrar(mapa, [...carros.pontos(), ...pedidos.pontos()], 15);
    }
    limpar(lista,
      el('div', { class: 'cartao plano' }, el('strong', {}, `${m.motoristas.length} motorista(s) online`), el('div', { class: 'pequeno mudo' },
        `${m.motoristas.filter((x) => !x.em_corrida).length} livres · ${m.motoristas.filter((x) => x.em_corrida).length} em corrida`)),
      m.corridas.length ? m.corridas.map((x) => el('div', { class: 'cartao plano' },
        el('div', { class: 'linha entre' }, el('strong', {}, `#${x.id}`), etiquetaStatus(x.status)),
        el('div', { class: 'pequeno' }, `${x.passageiro_nome}${x.motorista_nome ? ` · 🚕 ${x.motorista_nome}` : ''}`),
        el('div', { class: 'pequeno mudo' }, `${x.origem_endereco} → ${x.destino_endereco}`),
        el('div', { class: 'linha', style: 'margin-top:6px' }, botao('Detalhes', '', () => detalheCorrida(x.id))))) : el('p', { class: 'mudo' }, 'Nenhuma corrida em curso.'));
  }, 4000);
}

// ---------- Corridas ----------
async function detalheCorrida(id) {
  const c = await api.get(`/central/corridas/${id}`);
  const linha = (r, v) => el('div', { class: 'chave pequeno' }, el('span', { class: 'mudo' }, r), el('strong', { style: 'text-align:right' }, v ?? '—'));
  await modal(`Corrida #${c.id}`, (fechar) => [
    el('div', { class: 'linha' }, etiquetaStatus(c.status), el('span', { class: 'etiqueta' }, CATEGORIAS[c.categoria]), el('span', { class: 'etiqueta' }, FORMAS[c.forma_pagamento]),
      situacaoEtq(c.pagamento_status)),
    linha('Passageiro', `${c.passageiro.nome} · ${c.passageiro.telefone ?? ''}`),
    linha('Motorista', c.motorista ? `${c.motorista.nome} · ${c.motorista.placa ?? ''}` : null),
    linha('Origem', c.origem_endereco), linha('Destino', c.destino_endereco),
    linha('Solicitada', dataHora(c.solicitada_em)), linha('Aceita', dataHora(c.aceita_em)), linha('Início', dataHora(c.iniciada_em)), linha('Fim', dataHora(c.finalizada_em)),
    linha('Estimativa', `${dinheiro(c.valor_estimado_centavos)} · ${km(c.distancia_estimada_m)} · ${minutos(c.duracao_estimada_s)} · bandeira ${c.bandeira}`),
    c.empresa ? linha('Empresa', c.empresa) : null,
    linha('Cobrança', c.modelo_cobranca === 'taximetro' ? 'pelo taxímetro (diferença devolvida ou cobrada)' : 'preço fechado (vale o valor pago)'),
    c.valor_final_centavos !== null ? linha('Valor final', `${dinheiro(c.valor_final_centavos)} · ${km(c.distancia_percorrida_m)} · ${minutos(c.duracao_real_s)}`) : null,
    c.valor_taximetro_centavos !== null ? linha('Taxímetro', dinheiro(c.valor_taximetro_centavos)) : null,
    c.forma_pagamento !== 'empresa' ? linha('Pago pelo passageiro', dinheiro(c.valor_pago_centavos)) : null,
    c.cobrancas.length ? el('div', { style: 'margin-top:8px' }, el('h3', {}, 'Pagamentos e estornos'), c.cobrancas.map((b) => el('div', { class: 'chave pequeno' },
      el('span', {}, `${{ corrida: 'Pagamento', complemento: 'Complemento', estorno: 'Estorno' }[b.tipo]} · ${FORMAS[b.forma]} · ${dataHora(b.criada_em)}`),
      el('span', { class: 'linha' }, el('strong', { class: 'num' }, dinheiro(b.valor_centavos)), situacaoEtq(b.status))))) : null,
    c.valor_final_centavos !== null ? linha('Plataforma / motorista', `${dinheiro(c.taxa_plataforma_centavos)} / ${dinheiro(c.valor_motorista_centavos)}`) : null,
    c.status === 'cancelada' ? linha('Cancelada por', `${c.cancelada_por}${c.motivo_cancelamento ? `: ${c.motivo_cancelamento}` : ''}`) : null,
    c.nota_do_passageiro ? linha('Avaliação do passageiro', `${'★'.repeat(c.nota_do_passageiro)} ${c.comentario_do_passageiro ?? ''}`) : null,
    el('div', { class: 'linha', style: 'margin-top:14px' },
      ['aguardando_pagamento', 'solicitada', 'aceita', 'chegou', 'em_andamento'].includes(c.status) ? botao('Cancelar corrida', 'perigo', async () => {
        const motivo = await perguntar('Cancelar corrida', 'Motivo');
        if (!motivo) return;
        await api.post(`/central/corridas/${c.id}/cancelar`, { motivo });
        toast('Corrida cancelada.');
        fechar();
      }) : null,
      el('div', { style: 'flex:1' }), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ]);
}

async function telaCorridas(c) {
  const estado = { de: somarDias(hojeLocal(), -6), ate: hojeLocal(), status: '', pagamento: '' };
  const corpo = el('div');
  const carregar = async () => {
    const q = new URLSearchParams({ de: estado.de, ate: estado.ate, ...(estado.status && { status: estado.status }), ...(estado.pagamento && { pagamento: estado.pagamento }) });
    const lista = await api.get(`/central/corridas?${q}`);
    limpar(corpo, tabela(['#', 'Status', 'Passageiro', 'Motorista', 'Trajeto', 'Quando', 'Pagamento', '>Valor', ''], lista.map((x) => el('tr', {},
      td(x.id), td(etiquetaStatus(x.status)), td(x.passageiro_nome), td(x.motorista_nome ?? '—'),
      td(el('span', { class: 'pequeno' }, `${x.origem_endereco} → ${x.destino_endereco}`)), td(dataHora(x.solicitada_em)),
      td(el('span', {}, `${FORMAS[x.forma_pagamento]} `, situacaoEtq(x.pagamento_status))),
      td(dinheiro(x.valor_final_centavos ?? x.valor_estimado_centavos), true),
      td(botao('Ver', '', async () => { await detalheCorrida(x.id); await carregar(); })))), 'Nenhuma corrida no período.'));
  };
  const status = el('select', { onchange: (e) => { estado.status = e.target.value; carregar(); } }, el('option', { value: '' }, 'Todos'),
    ['aguardando_pagamento', 'solicitada', 'aceita', 'chegou', 'em_andamento', 'finalizada', 'cancelada'].map((s) => el('option', { value: s }, s.replace('_', ' '))));
  const pag = el('select', { onchange: (e) => { estado.pagamento = e.target.value; carregar(); } }, el('option', { value: '' }, 'Todos'), el('option', { value: 'pendente' }, 'Pagamento ou complemento pendente'));
  limpar(c, cabeca('Corridas'), el('div', { class: 'filtros' }, filtroPeriodo(estado, carregar), el('label', { class: 'campo' }, 'Status', status), el('label', { class: 'campo' }, 'Pagamento', pag)), corpo);
  await carregar();
}

// ---------- Motoristas ----------
async function telaMotoristas(c) {
  let filtro = 'pendente';
  const corpo = el('div', { class: 'coluna' });
  const carregar = async () => {
    const lista = await api.get(`/central/motoristas${filtro ? `?situacao=${filtro}` : ''}`);
    limpar(corpo, lista.length ? lista.map((m) => el('div', { class: 'cartao' },
      el('div', { class: 'linha entre' }, el('div', {}, el('strong', {}, m.nome), ' ', situacaoEtq(m.situacao), m.online ? el('span', { class: 'etiqueta ok', style: 'margin-left:6px' }, 'online') : null,
        !m.ativo ? el('span', { class: 'etiqueta erro', style: 'margin-left:6px' }, 'conta desativada') : null),
      el('span', { class: 'pequeno mudo' }, m.nota_media ? `★ ${m.nota_media.toLocaleString('pt-BR')} (${m.avaliacoes})` : 'sem avaliações')),
      el('div', { class: 'pequeno mudo', style: 'margin:6px 0' }, `${m.email} · ${m.telefone} · CPF ${m.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')} · CNH ${m.cnh} (validade ${m.cnh_validade.split('-').reverse().join('/')})`
        + ` · PIX ${m.chave_pix ?? 'não informado'} · saldo ${dinheiro(m.saldo_centavos)}`),
      m.motivo ? el('div', { class: 'aviso pequeno' }, `Motivo: ${m.motivo}`) : null,
      el('div', { class: 'coluna', style: 'margin:8px 0' }, m.veiculos.map((v) => el('div', { class: 'linha' }, el('span', { class: 'placa' }, v.placa),
        el('span', { class: 'pequeno' }, `${v.marca_modelo} · ${v.cor} · ${v.ano} · ${CATEGORIAS[v.categoria]}`), situacaoEtq(v.situacao),
        v.situacao === 'pendente' && m.situacao === 'aprovado' ? [botao('Aprovar veículo', 'primario', async () => { await api.post(`/central/veiculos/${v.id}/situacao`, { situacao: 'aprovado' }); await carregar(); }),
          botao('Recusar', 'perigo', async () => { await api.post(`/central/veiculos/${v.id}/situacao`, { situacao: 'recusado' }); await carregar(); })] : null))),
      el('div', { class: 'linha' },
        m.situacao !== 'aprovado' ? botao(m.situacao === 'pendente' ? 'Aprovar cadastro' : 'Liberar', 'primario', async () => {
          await api.post(`/central/motoristas/${m.id}/situacao`, { situacao: 'aprovado' });
          toast('Motorista aprovado.');
          await carregar();
        }) : null,
        m.situacao === 'pendente' ? botao('Recusar', 'perigo', async () => {
          const motivo = await perguntar('Recusar cadastro', 'Motivo (o motorista vê esta mensagem)');
          if (!motivo) return;
          await api.post(`/central/motoristas/${m.id}/situacao`, { situacao: 'recusado', motivo });
          await carregar();
        }) : null,
        m.situacao === 'aprovado' ? botao('Bloquear', 'perigo', async () => {
          const motivo = await perguntar('Bloquear motorista', 'Motivo');
          if (!motivo) return;
          await api.post(`/central/motoristas/${m.id}/situacao`, { situacao: 'bloqueado', motivo });
          await carregar();
        }) : null,
        botao('Extrato', '', () => extratoMotorista(m)),
        botao(m.ativo ? 'Desativar conta' : 'Reativar conta', '', async () => { await api.post(`/central/contas/${m.id}/ativo`, { ativo: !m.ativo }); await carregar(); }))))
      : el('div', { class: 'cartao' }, el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhum motorista nesta situação.')));
  };
  const pilulas = el('div', { class: 'pilulas' });
  const desenharPilulas = () => limpar(pilulas, [['pendente', 'Aguardando análise'], ['aprovado', 'Aprovados'], ['bloqueado', 'Bloqueados'], ['recusado', 'Recusados'], ['', 'Todos']]
    .map(([k, r]) => el('button', { class: filtro === k ? 'on' : '', onclick: () => { filtro = k; desenharPilulas(); carregar(); } }, r)));
  desenharPilulas();
  limpar(c, cabeca('Motoristas'), el('div', { class: 'filtros' }, pilulas), corpo);
  await carregar();
}

async function extratoMotorista(m) {
  const e = await api.get(`/central/motoristas/${m.id}/extrato`);
  await modal(`Extrato · ${m.nome}`, (fechar) => [
    el('div', { class: `aviso ${e.saldo_centavos < 0 ? 'erro' : 'ok'}` }, e.saldo_centavos >= 0 ? `A repassar: ${dinheiro(e.saldo_centavos)}` : `Deve à plataforma: ${dinheiro(-e.saldo_centavos)}`),
    e.lancamentos.map((l) => el('div', { class: 'chave pequeno' }, el('span', {}, l.descricao, el('br'), el('span', { class: 'mudo' }, dataHora(l.criado_em))), el('strong', { class: 'num' }, dinheiro(l.valor_centavos)))),
    usuario.perfil === 'admin' ? el('div', { class: 'linha', style: 'margin-top:12px' }, botao('Lançar ajuste', '', async () => {
      const valor = await perguntar('Ajuste na conta', 'Valor em reais (negativo para debitar), ex.: -15,50');
      if (!valor) return;
      const centavos = Math.round(Number(valor.replace(/\./g, '').replace(',', '.')) * 100);
      if (!Number.isFinite(centavos) || !centavos) throw new Error('Valor inválido.');
      const motivo = await perguntar('Ajuste na conta', 'Motivo');
      if (!motivo) return;
      await api.post(`/central/motoristas/${m.id}/ajuste`, { valor_centavos: centavos, motivo });
      toast('Ajuste lançado.');
      fechar();
    })) : null,
    el('button', { class: 'btn grande', style: 'margin-top:12px', onclick: () => fechar() }, 'Fechar'),
  ]);
}

// ---------- Passageiros ----------
async function telaPassageiros(c) {
  const corpo = el('div');
  const busca = el('input', { placeholder: 'Nome, e-mail ou telefone', type: 'search' });
  const carregar = async () => {
    const lista = await api.get(`/central/passageiros?busca=${encodeURIComponent(busca.value)}`);
    limpar(corpo, tabela(['Nome', 'E-mail', 'Telefone', '>Corridas', '>Nota', 'Desde', ''], lista.map((p) => el('tr', {},
      td(el('span', {}, p.nome, !p.ativo ? el('span', { class: 'etiqueta erro', style: 'margin-left:6px' }, 'desativada') : null)), td(p.email), td(p.telefone),
      td(p.corridas, true), td(p.nota_media ? `★ ${p.nota_media.toLocaleString('pt-BR')}` : '—', true), td(dataHora(p.criado_em)),
      td(botao(p.ativo ? 'Desativar' : 'Reativar', p.ativo ? 'perigo' : '', async () => { await api.post(`/central/contas/${p.id}/ativo`, { ativo: !p.ativo }); await carregar(); }))))));
  };
  let t;
  busca.addEventListener('input', () => { clearTimeout(t); t = setTimeout(carregar, 300); });
  limpar(c, cabeca('Passageiros'), el('div', { class: 'filtros' }, el('label', { class: 'campo', style: 'min-width:280px' }, 'Buscar', busca)), corpo);
  await carregar();
}

// ---------- Pagamentos (cobranças e estornos) ----------
async function telaPagamentos(c) {
  let filtro = 'pendente';
  const corpo = el('div');
  const carregar = async () => {
    const lista = await api.get(`/central/cobrancas${filtro ? `?status=${filtro}` : ''}`);
    const rotulo = { corrida: 'Pagamento da corrida', complemento: 'Complemento (taxímetro)', estorno: 'Estorno ao passageiro' };
    limpar(corpo, tabela(['#', 'Tipo', 'Corrida', 'Passageiro', 'Forma', 'Criada', 'Situação', '>Valor', ''], lista.map((b) => el('tr', {},
      td(b.id), td(rotulo[b.tipo]), td(botao(`#${b.corrida_id}`, '', () => detalheCorrida(b.corrida_id))), td(el('span', {}, b.passageiro_nome, el('br'), el('span', { class: 'pequeno mudo' }, b.passageiro_email))),
      td(FORMAS[b.forma]), td(dataHora(b.criada_em)), td(el('span', {}, situacaoEtq(b.status), b.identificador ? el('div', { class: 'pequeno mudo' }, b.identificador) : null)),
      td(dinheiro(b.valor_centavos), true),
      td(b.status === 'pendente' ? botao(b.tipo === 'estorno' ? 'Marcar devolvido' : 'Confirmar recebido', 'primario', async () => {
        const id = await perguntar(b.tipo === 'estorno' ? `Devolver ${dinheiro(b.valor_centavos)}` : `Confirmar ${dinheiro(b.valor_centavos)}`,
          b.tipo === 'estorno' ? 'Faça a devolução pelo banco e informe o identificador (E2E do PIX ou nº do estorno)' : 'Confira o PIX no extrato da conta e informe o identificador (E2E)');
        if (!id) return;
        await api.post(`/central/cobrancas/${b.id}/concluir`, { identificador: id });
        toast('Registrado.');
        await carregar();
      }) : null))), 'Nenhuma cobrança nesta situação.'));
  };
  const pilulas = el('div', { class: 'pilulas' });
  const desenhar = () => limpar(pilulas, [['pendente', 'Pendentes'], ['concluida', 'Concluídas'], ['cancelada', 'Canceladas'], ['', 'Todas']]
    .map(([k, r]) => el('button', { class: filtro === k ? 'on' : '', onclick: () => { filtro = k; desenhar(); carregar(); } }, r)));
  desenhar();
  limpar(c, cabeca('Pagamentos e estornos'), el('p', { class: 'pequeno mudo' },
    'Tudo é pago antes da viagem. Com o intermediador de pagamentos ligado, PIX, cartão e estornos são confirmados sozinhos; até lá, a central confirma os PIX recebidos na chave da plataforma e registra as devoluções aqui.'),
  el('div', { class: 'filtros' }, pilulas), corpo);
  await carregar();
}

// ---------- Empresas (faturado) ----------
const reaisParaCentavos = (txt) => (String(txt ?? '').trim() ? Math.round(Number(String(txt).replace(/\./g, '').replace(',', '.')) * 100) : null);

async function telaEmpresas(c) {
  const corpo = el('div', { class: 'coluna' });
  const carregar = async () => {
    const lista = await api.get('/central/empresas');
    limpar(corpo, tabela(['Empresa', 'CNPJ', 'Autorizados', '>Gasto no mês', '>Limite mensal', 'Situação', ''], lista.map((e) => el('tr', {},
      td(el('strong', {}, e.razao_social)), td(e.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')), td(e.usuarios_autorizados),
      td(dinheiro(e.gasto_mes_centavos), true), td(e.limite_mensal_centavos ? dinheiro(e.limite_mensal_centavos) : 'sem limite', true),
      td(situacaoEtq(e.ativa ? 'ativa' : 'suspensa')), td(botao('Abrir', 'primario', () => detalheEmpresa(e, carregar))))), 'Nenhuma empresa cadastrada.'));
  };
  const nova = el('button', { class: 'btn primario' }, 'Nova empresa');
  nova.addEventListener('click', () => modal('Nova empresa', (fechar) => {
    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Razão social', el('input', { name: 'razao_social', required: true })),
      el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'CNPJ', el('input', { name: 'cnpj', required: true })), el('label', { class: 'campo' }, 'Telefone', el('input', { name: 'telefone' }))),
      el('label', { class: 'campo' }, 'E-mail do financeiro (recebe a fatura)', el('input', { name: 'email_financeiro', type: 'email', required: true })),
      el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Limite mensal da empresa (R$, opcional)', el('input', { name: 'limite' })),
        el('label', { class: 'campo' }, 'Dia de vencimento da fatura', el('input', { name: 'dia_vencimento', type: 'number', min: 1, max: 28, value: 10 }))),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), el('button', { class: 'btn primario' }, 'Cadastrar')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('.primario'), async () => {
        await api.post('/central/empresas', { razao_social: d.razao_social, cnpj: d.cnpj, telefone: d.telefone || undefined, email_financeiro: d.email_financeiro,
          limite_mensal_centavos: reaisParaCentavos(d.limite), dia_vencimento: Number(d.dia_vencimento) });
        toast('Empresa cadastrada.');
        fechar();
        await carregar();
      });
    });
    return f;
  }));
  limpar(c, cabeca('Empresas (corridas faturadas)', nova),
    el('p', { class: 'pequeno mudo' }, 'Só pede corrida pela empresa o passageiro que você autorizar aqui (pelo e-mail da conta dele no app). As corridas entram na fatura do mês.'), corpo);
  await carregar();
}

async function detalheEmpresa(e, aoFechar) {
  const usuarios = el('div');
  const faturas = el('div');
  const competencia = el('input', { type: 'month', value: hojeLocal().slice(0, 7) });
  const carregar = async () => {
    const [us, fs] = await Promise.all([api.get(`/central/empresas/${e.id}/usuarios`), api.get(`/central/empresas/${e.id}/faturas`)]);
    limpar(usuarios, us.length ? us.map((u) => el('div', { class: 'chave pequeno' },
      el('span', {}, el('strong', {}, u.nome), ` · ${u.email}`, el('br'), el('span', { class: 'mudo' },
        `${u.centro_custo ? `${u.centro_custo} · ` : ''}gasto no mês ${dinheiro(u.gasto_mes_centavos)} · ${u.limite_mensal_centavos ? `limite ${dinheiro(u.limite_mensal_centavos)}` : 'sem limite'}`)),
      el('span', { class: 'linha' }, situacaoEtq(u.ativo ? 'liberado' : 'bloqueado'),
        botao('Limite', '', async () => {
          const v = await perguntar('Limite mensal do usuário', 'Valor em reais (vazio = sem limite)', { obrigatorio: false, valor: u.limite_mensal_centavos ? (u.limite_mensal_centavos / 100).toFixed(2).replace('.', ',') : '' });
          if (v === null) return;
          await api.patch(`/central/empresas/${e.id}/usuarios/${u.usuario_id}`, { limite_mensal_centavos: reaisParaCentavos(v) });
          await carregar();
        }),
        botao(u.ativo ? 'Bloquear' : 'Liberar', u.ativo ? 'perigo' : '', async () => {
          await api.patch(`/central/empresas/${e.id}/usuarios/${u.usuario_id}`, { ativo: !u.ativo });
          await carregar();
        })))) : el('p', { class: 'mudo pequeno' }, 'Ninguém autorizado ainda.'));
    limpar(faturas, fs.length ? fs.map((f) => el('div', { class: 'chave pequeno' },
      el('span', {}, el('strong', {}, f.competencia.split('-').reverse().join('/')), ` · ${f.corridas} corrida(s) · vence ${f.vencimento.split('-').reverse().join('/')}`,
        f.identificador ? el('div', { class: 'mudo' }, f.identificador) : null),
      el('span', { class: 'linha' }, el('strong', { class: 'num' }, dinheiro(f.valor_centavos)), situacaoEtq(f.status),
        botao('CSV', '', async () => {
          const resp = await api.get(`/central/faturas/${f.id}/csv`, { bruto: true });
          const url = URL.createObjectURL(await resp.blob());
          el('a', { href: url, download: `fatura-${e.cnpj}-${f.competencia}.csv` }).click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }),
        f.status === 'aberta' ? botao('Marcar paga', 'primario', async () => {
          const id = await perguntar('Fatura paga', 'Identificador do pagamento (PIX, TED ou boleto)');
          if (!id) return;
          await api.post(`/central/faturas/${f.id}/pagar`, { identificador: id });
          await carregar();
        }) : null,
        f.status === 'aberta' ? botao('Cancelar', 'perigo', async () => {
          const motivo = await perguntar('Cancelar fatura', 'Motivo (as corridas voltam para uma nova fatura)');
          if (!motivo) return;
          await api.post(`/central/faturas/${f.id}/cancelar`, { motivo });
          await carregar();
        }) : null))) : el('p', { class: 'mudo pequeno' }, 'Nenhuma fatura gerada.'));
  };
  const autorizar = el('form', { class: 'form' },
    el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'E-mail do passageiro', el('input', { name: 'email', type: 'email', required: true })),
      el('label', { class: 'campo' }, 'Centro de custo (opcional)', el('input', { name: 'centro_custo' }))),
    el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Limite mensal (R$, opcional)', el('input', { name: 'limite' })), el('div', { style: 'align-self:end' }, el('button', { class: 'btn primario' }, 'Autorizar'))));
  autorizar.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const d = lerForm(autorizar);
    acao(autorizar.querySelector('button'), async () => {
      await api.post(`/central/empresas/${e.id}/usuarios`, { email: d.email, centro_custo: d.centro_custo, limite_mensal_centavos: reaisParaCentavos(d.limite) });
      toast('Passageiro autorizado.');
      autorizar.reset();
      await carregar();
    });
  });
  const gerar = el('button', { class: 'btn' }, 'Gerar fatura');
  gerar.addEventListener('click', () => acao(gerar, async () => {
    const f = await api.post(`/central/empresas/${e.id}/faturas`, { competencia: competencia.value });
    toast(`Fatura gerada: ${f.corridas} corrida(s), ${dinheiro(f.valor_centavos)}.`);
    await carregar();
  }));
  await carregar();
  await modal(e.razao_social, (fechar) => [
    el('p', { class: 'pequeno mudo' }, `Financeiro: ${e.email_financeiro} · vencimento dia ${e.dia_vencimento} · ${e.limite_mensal_centavos ? `limite da empresa ${dinheiro(e.limite_mensal_centavos)}` : 'sem limite mensal'}`),
    el('h3', {}, 'Quem pode pedir pela empresa'), autorizar, usuarios,
    el('h3', { style: 'margin-top:14px' }, 'Faturas'), el('div', { class: 'linha' }, competencia, gerar), faturas,
    el('div', { class: 'linha entre', style: 'margin-top:14px' },
      botao(e.ativa ? 'Suspender empresa' : 'Reativar empresa', e.ativa ? 'perigo' : '', async () => { await api.patch(`/central/empresas/${e.id}`, { ativa: !e.ativa }); fechar(); }),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ]);
  await aoFechar();
}

// ---------- Repasses ----------
async function telaRepasses(c) {
  const corpo = el('div', { class: 'coluna' });
  const carregar = async () => {
    const [saldos, repasses] = await Promise.all([api.get('/central/saldos'), api.get('/central/repasses')]);
    const aReceber = saldos.filter((s) => s.saldo_centavos > 0);
    limpar(corpo,
      el('div', { class: 'grade' }, indicador('A repassar', dinheiro(aReceber.reduce((a, s) => a + s.saldo_centavos, 0)), `${aReceber.length} motorista(s)`),
        indicador('Repasses pendentes', dinheiro(repasses.filter((r) => r.status === 'pendente').reduce((a, r) => a + r.valor_centavos, 0)), 'gerados e ainda não transferidos')),
      el('h2', { style: 'margin-top:8px' }, 'Saldos dos motoristas'),
      tabela(['Motorista', 'Chave PIX', '>Saldo'], saldos.map((s) => el('tr', {}, td(s.nome), td(s.chave_pix ?? el('span', { class: 'etiqueta erro' }, 'sem chave')), td(dinheiro(s.saldo_centavos), true))), 'Nenhum saldo em aberto.'),
      el('h2', { style: 'margin-top:8px' }, 'Repasses'),
      tabela(['#', 'Motorista', 'Chave PIX', 'Gerado', 'Situação', 'Identificador', '>Valor', ''], repasses.map((r) => el('tr', {},
        td(r.id), td(r.nome), td(r.chave_pix), td(dataHora(r.criado_em)), td(situacaoEtq(r.status)), td(r.identificador ?? r.motivo ?? '—'), td(dinheiro(r.valor_centavos), true),
        td(r.status === 'pendente' ? el('div', { class: 'linha' },
          botao('Marcar pago', 'primario', async () => {
            const id = await perguntar(`Repasse #${r.id} · ${dinheiro(r.valor_centavos)}`, `Faça o PIX para ${r.chave_pix} e informe o identificador (E2E) ou o nº do comprovante`);
            if (!id) return;
            await api.post(`/central/repasses/${r.id}/pagar`, { identificador: id });
            toast('Repasse registrado como pago.');
            await carregar();
          }),
          botao('Cancelar', 'perigo', async () => {
            const motivo = await perguntar('Cancelar repasse', 'Motivo (o valor volta ao saldo do motorista)');
            if (!motivo) return;
            await api.post(`/central/repasses/${r.id}/cancelar`, { motivo });
            await carregar();
          })) : null))), 'Nenhum repasse gerado ainda.'));
  };
  const gerar = el('button', { class: 'btn primario' }, 'Gerar repasses');
  gerar.addEventListener('click', () => acao(gerar, async () => {
    if (!(await confirmar('Gerar repasses', 'Cria um repasse pendente para cada motorista com saldo acima do mínimo e chave PIX cadastrada.', 'Gerar'))) return;
    const r = await api.post('/central/repasses');
    toast(`${r.gerados.length} repasse(s) gerado(s)${r.ignorados.length ? `; ${r.ignorados.length} ignorado(s) (${[...new Set(r.ignorados.map((i) => i.motivo))].join(', ')})` : ''}.`);
    await carregar();
  }));
  limpar(c, cabeca('Repasses aos motoristas', gerar), corpo);
  await carregar();
}

// ---------- Relatórios ----------
async function telaRelatorios(c) {
  const estado = { de: somarDias(hojeLocal(), -29), ate: hojeLocal() };
  const corpo = el('div', { class: 'coluna' });
  const carregar = async () => {
    const r = await api.get(`/central/relatorio?de=${estado.de}&ate=${estado.ate}`);
    const maior = Math.max(1, ...r.por_dia.map((d) => d.bruto_centavos));
    limpar(corpo,
      el('div', { class: 'grade' }, indicador('Corridas finalizadas', r.finalizadas, `${r.canceladas} cancelada(s)`), indicador('Faturamento bruto', dinheiro(r.bruto_centavos), `ticket médio ${dinheiro(r.ticket_medio_centavos)}`),
        indicador('Receita da plataforma', dinheiro(r.taxa_centavos)), indicador('Parte dos motoristas', dinheiro(r.motoristas_centavos)),
        indicador('Faturado a empresas', dinheiro(r.faturado_empresas_centavos)),
        indicador('Estornos devolvidos', dinheiro(r.estornos_centavos), r.estornos_pendentes_centavos ? `${dinheiro(r.estornos_pendentes_centavos)} a devolver` : null),
        indicador('Complementos a receber', dinheiro(r.complementos_pendentes_centavos), 'taxímetro acima do valor pago')),
      el('div', { class: 'cartao' }, el('h2', {}, 'Faturamento por dia'), r.por_dia.length
        ? el('div', { class: 'barras', role: 'img', 'aria-label': 'Faturamento por dia' }, r.por_dia.map((d) => el('div', { class: 'barra', style: `height:${Math.max(2, (d.bruto_centavos / maior) * 100)}%`,
          title: `${d.data.split('-').reverse().join('/')}: ${dinheiro(d.bruto_centavos)} · ${d.finalizadas} corrida(s)` })))
        : el('p', { class: 'mudo' }, 'Sem corridas no período.')),
      el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' },
        el('div', { class: 'cartao' }, el('h2', {}, 'Por forma de pagamento'), Object.entries(r.por_forma_centavos).map(([k, val]) => el('div', { class: 'chave' }, el('span', {}, FORMAS[k]), el('strong', { class: 'num' }, dinheiro(val))))),
        el('div', { class: 'cartao' }, el('h2', {}, 'Motoristas que mais faturaram'), r.ranking_motoristas.length ? r.ranking_motoristas.map((m, i) => el('div', { class: 'chave' },
          el('span', {}, `${i + 1}. ${m.nome}`), el('span', { class: 'num' }, `${m.corridas} · `, el('strong', {}, dinheiro(m.bruto_centavos))))) : el('p', { class: 'mudo' }, '—'))),
      tabela(['Dia', '>Finalizadas', '>Canceladas', '>Bruto', '>Plataforma'], r.por_dia.map((d) => el('tr', {}, td(d.data.split('-').reverse().join('/')), td(d.finalizadas, true), td(d.canceladas, true),
        td(dinheiro(d.bruto_centavos), true), td(dinheiro(d.taxa_centavos), true)))));
  };
  const exportar = el('button', { class: 'btn' }, 'Exportar para o BPO (CSV)');
  exportar.addEventListener('click', () => acao(exportar, async () => {
    const resp = await api.get(`/central/exportar-bpo?de=${estado.de}&ate=${estado.ate}`, { bruto: true });
    const url = URL.createObjectURL(await resp.blob());
    el('a', { href: url, download: `taxi-bpo-${estado.de}-a-${estado.ate}.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }));
  limpar(c, cabeca('Relatórios', el('button', { class: 'btn', onclick: () => print() }, 'Imprimir'), exportar),
    el('div', { class: 'filtros' }, filtroPeriodo(estado, carregar)),
    el('p', { class: 'pequeno mudo' }, 'A exportação gera o CSV de lançamentos do Ativa BPO Financeiro (Integrações → Importar lançamentos): taxas da plataforma como contas a receber e repasses pagos como contas a pagar.'),
    corpo);
  await carregar();
}

// ---------- Tarifas e regras ----------
async function telaTarifas(c) {
  const admin = usuario.perfil === 'admin';
  const [tarifas, cfg] = await Promise.all([api.get('/central/tarifas'), api.get('/central/config')]);
  const reais = (cent) => (cent / 100).toFixed(2).replace('.', ',');
  const centavos = (txt) => Math.round(Number(String(txt).replace(/\./g, '').replace(',', '.')) * 100);
  const campo = (rotulo, nome, valor, attrs = {}) => el('label', { class: 'campo' }, rotulo, el('input', { name: nome, value: valor, disabled: !admin, ...attrs }));

  const formTarifa = (t) => {
    const f = el('form', { class: 'form' },
      el('div', { class: 'duas' }, campo('Bandeirada (R$)', 'bandeirada', reais(t.bandeirada_centavos)), campo('Tarifa mínima (R$)', 'minima', reais(t.minima_centavos))),
      el('div', { class: 'duas' }, campo('Km bandeira 1 (R$)', 'km', reais(t.km_centavos)), campo('Km bandeira 2 (R$)', 'km2', reais(t.km_bandeira2_centavos))),
      campo('Minuto de viagem (R$)', 'minuto', reais(t.minuto_centavos)),
      admin ? el('button', { class: 'btn primario' }, 'Salvar tarifa') : null);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('button'), async () => {
        await api.put(`/central/tarifas/${t.categoria}`, { bandeirada_centavos: centavos(d.bandeirada), km_centavos: centavos(d.km), km_bandeira2_centavos: centavos(d.km2),
          minuto_centavos: centavos(d.minuto), minima_centavos: centavos(d.minima) });
        toast('Tarifa salva.');
      });
    });
    return el('div', { class: 'cartao' }, el('h2', {}, CATEGORIAS[t.categoria]), f);
  };

  const regras = el('form', { class: 'form' },
    el('div', { class: 'duas' }, campo('Taxa da plataforma (%)', 'taxa', (cfg.taxa_plataforma_bp / 100).toString().replace('.', ',')), campo('Raio de busca de motoristas (km)', 'raio', cfg.raio_busca_km)),
    el('div', { class: 'duas' }, campo('Espera máxima por motorista (min)', 'expirar', cfg.expirar_solicitacao_min), campo('Prazo para pagar o pedido (min)', 'expirarPag', cfg.expirar_pagamento_min)),
    campo('Repasse mínimo (R$)', 'minimo', reais(cfg.repasse_minimo_centavos)),
    el('label', { class: 'campo' }, 'Valor cobrado do passageiro', el('select', { name: 'modelo', disabled: !admin },
      el('option', { value: 'estimativa', selected: cfg.modelo_cobranca === 'estimativa' }, 'Preço fechado: vale o valor pago antes'),
      el('option', { value: 'taximetro', selected: cfg.modelo_cobranca === 'taximetro' }, 'Taxímetro: devolve ou cobra a diferença no fim'))),
    el('div', { class: 'duas' }, campo('Bandeira 2: início (hora)', 'b2ini', cfg.bandeira2_inicio_hora, { type: 'number', min: 0, max: 23 }), campo('Bandeira 2: fim (hora)', 'b2fim', cfg.bandeira2_fim_hora, { type: 'number', min: 0, max: 23 })),
    el('label', { class: 'linha pequeno' }, el('input', { type: 'checkbox', name: 'b2dom', checked: cfg.bandeira2_domingo, disabled: !admin, style: 'width:auto;min-height:0' }), 'Bandeira 2 o dia todo aos domingos'),
    el('label', { class: 'linha pequeno' }, el('input', { type: 'checkbox', name: 'b2fer', checked: cfg.bandeira2_feriados, disabled: !admin, style: 'width:auto;min-height:0' }), 'Bandeira 2 nos feriados nacionais'),
    el('div', { class: 'duas' }, campo('Fator de rota (ruas ÷ linha reta)', 'fator', cfg.fator_rota), campo('Velocidade média urbana (km/h)', 'vel', cfg.velocidade_media_kmh)),
    el('h3', { style: 'margin-top:8px' }, 'PIX da plataforma (recebe os pagamentos por PIX)'),
    campo('Chave PIX', 'pix', cfg.pix_chave, { placeholder: 'CNPJ, e-mail, telefone ou chave aleatória' }),
    el('div', { class: 'duas' }, campo('Nome do recebedor', 'recebedor', cfg.pix_recebedor, { maxlength: 25 }), campo('Cidade', 'cidade', cfg.pix_cidade, { maxlength: 15 })),
    admin ? el('button', { class: 'btn primario' }, 'Salvar regras') : el('p', { class: 'pequeno mudo' }, 'Só o administrador altera tarifas e regras.'));
  regras.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = lerForm(regras);
    acao(regras.querySelector('button'), async () => {
      await api.patch('/central/config', {
        taxa_plataforma_bp: Math.round(Number(d.taxa.replace(',', '.')) * 100), raio_busca_km: d.raio, expirar_solicitacao_min: Number(d.expirar), expirar_pagamento_min: Number(d.expirarPag), modelo_cobranca: d.modelo, repasse_minimo_centavos: centavos(d.minimo),
        bandeira2_inicio_hora: Number(d.b2ini), bandeira2_fim_hora: Number(d.b2fim), bandeira2_domingo: d.b2dom === 'on', bandeira2_feriados: d.b2fer === 'on',
        fator_rota: d.fator, velocidade_media_kmh: d.vel, pix_chave: d.pix, pix_recebedor: d.recebedor, pix_cidade: d.cidade,
      });
      toast('Regras salvas.');
    });
  });
  limpar(c, cabeca('Tarifas e regras'),
    el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px' }, tarifas.map(formTarifa), el('div', { class: 'cartao', style: 'grid-row:span 2' }, el('h2', {}, 'Regras'), regras)),
    el('p', { class: 'pequeno mudo' }, 'Taxímetro = bandeirada + km × distância percorrida + minuto × tempo de viagem, nunca abaixo da mínima. A estimativa (paga antes da viagem) usa a distância em linha reta × fator de rota. Confira a regra da prefeitura antes de usar o preço fechado.'));
}

// ---------- Equipe ----------
async function telaEquipe(c) {
  const corpo = el('div');
  const carregar = async () => {
    const lista = await api.get('/central/equipe');
    limpar(corpo, tabela(['Nome', 'E-mail', 'Perfil', 'Último acesso', ''], lista.map((u) => el('tr', {}, td(u.nome), td(u.email), td(u.perfil === 'admin' ? 'Administrador' : 'Operador'),
      td(dataHora(u.ultimo_acesso)), td(u.id === usuario.id ? el('span', { class: 'mudo pequeno' }, 'você') : botao(u.ativo ? 'Desativar' : 'Reativar', u.ativo ? 'perigo' : '', async () => {
        await api.post(`/central/equipe/${u.id}/ativo`, { ativo: !u.ativo });
        await carregar();
      }))))));
  };
  const novo = el('button', { class: 'btn primario' }, 'Novo usuário');
  novo.addEventListener('click', () => modal('Novo usuário da central', (fechar) => {
    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true })),
      el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', type: 'email', required: true })),
      el('label', { class: 'campo' }, 'Senha provisória (mínimo 8)', el('input', { name: 'senha', type: 'text', required: true, minlength: 8 })),
      el('label', { class: 'campo' }, 'Perfil', el('select', { name: 'perfil' }, el('option', { value: 'operador' }, 'Operador (atendimento, aprovações e repasses)'), el('option', { value: 'admin' }, 'Administrador (tudo)'))),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), el('button', { class: 'btn primario' }, 'Criar')));
    f.addEventListener('submit', (e) => { e.preventDefault(); acao(f.querySelector('.primario'), async () => { await api.post('/central/equipe', lerForm(f)); toast('Usuário criado.'); fechar(); await carregar(); }); });
    return f;
  }));
  const auditoria = el('button', { class: 'btn' }, 'Auditoria');
  auditoria.addEventListener('click', () => acao(auditoria, async () => {
    const lista = await api.get('/central/auditoria');
    modal('Auditoria (últimas 300 ações)', (fechar) => [lista.map((a) => el('div', { class: 'chave pequeno' }, el('span', {}, el('strong', {}, a.acao), ` · ${a.nome ?? 'sistema'}`, el('br'),
      el('span', { class: 'mudo', style: 'word-break:break-all' }, a.detalhes ?? '')), el('span', { class: 'mudo' }, dataHora(a.criado_em)))),
    el('button', { class: 'btn grande', style: 'margin-top:12px', onclick: () => fechar() }, 'Fechar')]);
  }));
  limpar(c, cabeca('Equipe da central', auditoria, novo), corpo);
  await carregar();
}

iniciar();
