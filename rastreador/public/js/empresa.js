/** Telas do painel da empresa (administrador e operador; o master entra pela lista de empresas). */
import { api, qs, baixar, BASE } from './api.js';
import { el, limpar, dinheiro, dataHora, hora, data, desde, km, kmh, placa, telefone, inteiro, toast, acao, campo, escolha, marcar, formModal, modal, confirmar,
  perguntar, repetir, etiqueta, etiquetaSituacao, etiquetaComando, etiquetaAlerta, hojeLocal, somarDias, centavos, icone, PERFIS, TIPOS_VEICULO,
  TIPOS_ALERTA, TIPOS_COMANDO, PROTOCOLOS } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, linhaDado, campoData, painelMapa, resumoVeiculo, painelIntegracoes } from './comum.js';
import { criarMapa, configPublica, linkGoogle, COR_SITUACAO } from './mapa.js';
import { pizza, barras } from './graficos.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const pode = (ctx) => !ctx.somenteLeitura;
const duracaoH = (s) => { const t = Math.round(s ?? 0); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
// Veículo escolhido no mapa para abrir no histórico.
let veiculoHistorico = null;

// ---------- Dashboard ----------
async function telaDashboard(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get(`${base(ctx)}/dashboard`);
    const v = d.veiculos;
    const semana = d.alertas_semana.reduce((s, x) => s + x.n, 0);
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      el('div', { class: 'grade' },
        indicador('Veículos', inteiro(v.total), `limite do plano: ${inteiro(d.empresa.limite_veiculos)}`),
        indicador('Em movimento', inteiro(v.movimento), `${inteiro(v.ligado)} parado(s) ligado(s)`, 'ok'),
        indicador('Sem sinal', inteiro(v.sem_sinal), v.sem_sinal ? 'sem comunicação' : v.sem_posicao ? `${inteiro(v.sem_posicao)} aguardando a 1ª posição`
          : 'todos comunicando', v.sem_sinal ? 'erro' : ''),
        indicador('Rodados hoje', km(d.hoje.distancia_m), `${duracaoH(d.hoje.ligado_s)} com motor ligado`),
        indicador('Alertas pendentes', inteiro(d.alertas_pendentes), `${inteiro(semana)} nos últimos 7 dias`, d.alertas_pendentes ? 'aviso' : '')),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c4' }, cartao('Frota agora', pizza([
          { rotulo: 'Em movimento', valor: v.movimento, cor: COR_SITUACAO.movimento }, { rotulo: 'Parado ligado', valor: v.ligado, cor: COR_SITUACAO.ligado },
          { rotulo: 'Parado', valor: v.parado, cor: COR_SITUACAO.parado }, { rotulo: 'Sem sinal', valor: v.sem_sinal, cor: COR_SITUACAO.sem_sinal },
          { rotulo: 'Sem posição/rastreador', valor: v.sem_posicao + v.sem_rastreador, cor: COR_SITUACAO.sem_posicao },
        ], { vazio: 'Nenhum veículo cadastrado' }), v.bloqueados ? el('p', { class: 'aviso erro pequeno', style: 'margin:12px 0 0' }, `${v.bloqueados} veículo(s) bloqueado(s).`) : null,
        el('a', { class: 'btn', href: `#/empresa/${ctx.empresaId}/mapa`, style: 'margin-top:12px;width:100%' }, icone('mapa'), 'Abrir o mapa ao vivo'))),
        el('div', { class: 'c8' }, cartao('Quilômetros por dia (14 dias)', barras(d.km_por_dia.map((x) => ({
          rotulo: x.data.slice(8), valor: x.distancia_m, titulo: `${data(x.data)}: ${km(x.distancia_m)}` })))),
        el('div', { class: 'c7' }, cartao('Últimos alertas', tabela(['Quando', 'Veículo', 'Alerta', 'Situação'], d.ultimos_alertas.map((a) => el('tr', {},
          td(dataHora(a.ocorrido_em)), td(placa(a.placa)), td([etiquetaAlerta(a.tipo), el('div', { class: 'pequeno mudo' }, a.mensagem)]),
          td(a.tratado_em ? etiqueta('tratado', 'ok') : etiqueta('pendente', 'aviso'))))), 'Nenhum alerta.'),
          el('a', { class: 'btn pequeno', href: `#/empresa/${ctx.empresaId}/alertas`, style: 'margin-top:10px' }, 'Ver todos'))),
        el('div', { class: 'c5' }, cartao('Mais rodados na semana', tabela(['Veículo', '>Distância', '>Vel. máx.'], d.ranking.map((x) => el('tr', {},
          td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(km(x.distancia_m), 'dir num'),
          td(kmh(x.velocidade_max_kmh), 'dir num'))), 'Sem deslocamentos na semana.')),
          el('div', { style: 'height:18px' }),
          cartao('Alertas da semana por tipo', tabela(['Tipo', '>Quantidade'], d.alertas_semana.map((x) => el('tr', {}, td(etiquetaAlerta(x.tipo)), td(inteiro(x.n), 'dir num'))),
            'Nenhum alerta na semana.'))),
        el('div', { class: 'c6' }, cartao('Manutenção', tabela(['Veículo', 'Serviço', 'Próxima', 'Situação'], d.manutencoes.map((m) => el('tr', {},
          td(placa(m.placa)), td(m.descricao), td([m.proxima_km !== null ? `${inteiro(m.proxima_km)} km` : null, m.proxima_data ? el('div', { class: 'pequeno mudo' }, data(m.proxima_data)) : null]),
          td(m.situacao === 'vencida' ? etiqueta('vencida', 'erro') : etiqueta('próxima', 'aviso'))))), 'Nenhuma manutenção vencida ou próxima.')),
        el('div', { class: 'c6' }, cartao('CNH vencida ou vencendo em 30 dias', tabela(['Motorista', 'Validade'], d.cnh.map((m) => el('tr', {},
          td(m.nome), td(m.cnh_validade < hojeLocal() ? etiqueta(`vencida em ${data(m.cnh_validade)}`, 'erro') : etiqueta(data(m.cnh_validade), 'aviso')))),
        'Nenhuma CNH vencendo.'))))));
  }, 30_000));
}

// ---------- Mapa ao vivo ----------
async function telaMapa(ctx) {
  await painelMapa(ctx, `${base(ctx)}/mapa`, { detalhe: (v, painel, fechar) => detalheVeiculo(ctx, v, painel, fechar) });
}

function detalheVeiculo(ctx, v, painel, fechar) {
  const comComandos = pode(ctx) && v.imei && v.protocolo !== 'osmand';
  limpar(painel,
    el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, placa(v.placa)), botaoIcone('seta', 'Fechar', fechar)),
    el('div', { class: 'pequeno mudo' }, [v.descricao, TIPOS_VEICULO[v.tipo]].filter(Boolean).join(' · ')),
    el('div', { class: 'linha', style: 'margin-top:8px;gap:6px' }, etiquetaSituacao(v.situacao), v.bloqueado ? etiqueta('bloqueado', 'erro') : null,
      v.alertas_pendentes ? el('a', { class: 'etiqueta aviso', href: `#/empresa/${ctx.empresaId}/alertas`, style: 'text-decoration:none' }, `${v.alertas_pendentes} alerta(s)`) : null),
    resumoVeiculo(v),
    el('div', { class: 'acoes-veiculo' },
      el('button', { class: 'btn pequeno', onclick: () => { veiculoHistorico = v.id; ctx.ir('historico'); } }, icone('historico'), 'Histórico'),
      pode(ctx) ? botao('Compartilhar', '', () => compartilhar(ctx, v)) : null,
      comComandos ? botao('Pedir posição', '', () => enviarComando(ctx, v, 'localizar')) : null,
      comComandos ? botao('Consultar estado', '', () => enviarComando(ctx, v, 'status')) : null,
      comComandos ? (v.bloqueado
        ? botao('Desbloquear', 'primario', () => enviarComando(ctx, v, 'desbloquear'))
        : botao('Bloquear', 'perigo', () => enviarComando(ctx, v, 'bloquear'))) : null),
    v.protocolo === 'osmand' ? el('p', { class: 'pequeno fraco' }, 'Rastreador por celular: não recebe comandos de bloqueio.') : null);
}

/** Envia o comando; bloquear pede a placa digitada, porque corta o combustível ou a ignição do veículo. */
async function enviarComando(ctx, v, tipo, texto) {
  let confirmacao;
  if (tipo === 'bloquear') {
    confirmacao = await perguntar(`Bloquear ${placa(v.placa)}`, `Digite a placa para confirmar. ${v.velocidade_kmh >= 20 ? `ATENÇÃO: o veículo está a ${kmh(v.velocidade_kmh)}. ` : ''}`
      + 'A maioria dos rastreadores só corta com o veículo abaixo de 20 km/h.');
    if (!confirmacao) return;
  } else if (tipo === 'desbloquear' && !await confirmar(`Desbloquear ${placa(v.placa)}`, 'O veículo volta a funcionar normalmente.', 'Desbloquear')) {
    return;
  }
  const c = await api.post(`${base(ctx)}/veiculos/${v.id}/comandos`, { tipo, confirmacao, texto });
  const consulta = tipo === 'status' || tipo === 'parametros' ? ' A resposta do equipamento aparece em Comandos.' : '';
  toast(`${c.status === 'pendente' ? `Comando "${TIPOS_COMANDO[tipo]}" na fila: vai assim que o rastreador conectar.` : `Comando "${TIPOS_COMANDO[tipo]}" enviado.`}${consulta}`);
}

async function compartilhar(ctx, v) {
  const r = await formModal(`Compartilhar a localização de ${placa(v.placa)}`, () => [
    el('p', { class: 'mudo', style: 'margin:0' }, 'Quem tiver o link vê a posição do veículo no mapa (sem histórico e sem login) até o link expirar.'),
    escolha('Validade', 'horas', { 1: '1 hora', 4: '4 horas', 12: '12 horas', 24: '24 horas', 72: '3 dias', 168: '7 dias' }, 24),
  ], (d) => api.post(`${base(ctx)}/veiculos/${v.id}/compartilhar`, { horas: Number(d.horas) }), { rotulo: 'Gerar link' });
  if (!r || r === true) return;
  const link = `${location.origin}${BASE}/compartilhar/#${r.codigo}`;
  modal('Link gerado', (fechar) => [
    el('p', { class: 'mudo' }, `Vale até ${dataHora(r.expira_em)}. Para cancelar antes, use Veículos → editar → links ativos.`),
    el('div', { class: 'segredo' }, link),
    el('div', { class: 'linha entre', style: 'margin-top:14px' },
      el('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`Localização do veículo ${placa(v.placa)}: ${link}`)}`, target: '_blank', rel: 'noopener' }, 'Enviar por WhatsApp'),
      el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Copiado.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
      el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
  ]);
}

// ---------- Histórico (trajeto e reprodução) ----------
async function telaHistorico(ctx) {
  ctx.telaCheia();
  // O mais recente primeiro: a escolha inicial é o veículo que andou por último.
  const veiculos = (await api.get(`${base(ctx)}/veiculos`)).filter((x) => x.rastreador_id || x.posicao_em)
    .sort((a, b) => String(b.posicao_em ?? '').localeCompare(String(a.posicao_em ?? '')));
  const hoje = hojeLocal();
  const estado = { veiculo: veiculoHistorico ?? veiculos[0]?.id ?? '', de: hoje, ate: hoje };
  veiculoHistorico = null;
  const divMapa = el('div', { class: 'mapa' });
  const filtros = el('div', { class: 'coluna', style: 'gap:8px' });
  const resultado = el('div', { class: 'coluna', style: 'gap:10px' });
  const player = el('div', { class: 'player oculto' });
  limpar(ctx.conteudo, el('div', { class: 'tela-mapa' }, el('aside', { class: 'lado' }, filtros, resultado), el('div', { class: 'area-mapa' }, divMapa, player)));
  const mapa = await criarMapa(divMapa);
  let camadas = [];
  let animacao = null;
  const limparMapa = () => { for (const c of camadas) c.remover(); camadas = []; if (animacao) clearInterval(animacao); animacao = null; };

  const desenharFiltros = () => {
    const sel = escolha('Veículo', 'veiculo', Object.fromEntries(veiculos.map((x) => [x.id, `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`])), estado.veiculo);
    sel.querySelector('select').addEventListener('change', (e) => { estado.veiculo = e.target.value; carregar(); });
    const atalho = (rotulo, dias) => el('button', { class: 'btn pequeno', type: 'button', onclick: () => { estado.de = somarDias(hoje, -dias); estado.ate = dias === 1 ? estado.de : hoje; desenharFiltros(); carregar(); } }, rotulo);
    limpar(filtros, sel, el('div', { class: 'duas-col' },
      campoData('De', estado.de, (x) => { estado.de = x; carregar(); }, { max: hoje }), campoData('Até', estado.ate, (x) => { estado.ate = x; carregar(); }, { max: hoje })),
    el('div', { class: 'linha', style: 'gap:6px' }, atalho('Hoje', 0), atalho('Ontem', 1), atalho('3 dias', 2), atalho('7 dias', 6)));
  };

  async function carregar() {
    limparMapa();
    player.classList.add('oculto');
    if (!estado.veiculo) return limpar(resultado, el('p', { class: 'mudo' }, 'Nenhum veículo com rastreador.'));
    limpar(resultado, el('p', { class: 'mudo pequeno' }, 'Carregando…'));
    let p;
    try {
      p = await api.get(`${base(ctx)}/veiculos/${estado.veiculo}/percurso${qs({ de: estado.de, ate: estado.ate })}`);
    } catch (err) {
      return limpar(resultado, el('p', { class: 'aviso erro' }, err.message));
    }
    const pts = p.pontos.map((x) => [x.lat, x.lng]);
    if (mapa && pts.length) {
      camadas.push(mapa.linha(pts, { cor: '#2563EB', peso: 5 }));
      camadas.push(mapa.ponto(...pts[0], { classe: 'inicio', texto: 'A', titulo: `Início ${dataHora(p.pontos[0].gps_em)}` }));
      camadas.push(mapa.ponto(...pts.at(-1), { classe: 'fim', texto: 'B', titulo: `Fim ${dataHora(p.pontos.at(-1).gps_em)}` }));
      p.paradas.forEach((s, i) => camadas.push(mapa.ponto(s.lat, s.lng, { classe: 'parada', texto: String(i + 1), titulo: `Parada ${i + 1}: ${duracaoH(s.duracao_s)} (${hora(s.inicio)}–${hora(s.fim)})` })));
      for (const a of p.alertas.filter((x) => x.lat !== null)) {
        camadas.push(mapa.ponto(a.lat, a.lng, { classe: 'alerta', texto: '!', titulo: `${TIPOS_ALERTA[a.tipo]} · ${dataHora(a.ocorrido_em)}`,
          popup: () => el('div', {}, el('strong', {}, TIPOS_ALERTA[a.tipo]), el('div', {}, a.mensagem), el('div', { class: 'pequeno' }, dataHora(a.ocorrido_em))) }));
      }
      mapa.enquadrar(pts);
    }
    const trecho = (vg) => {
      if (!mapa) return;
      const ini = Date.parse(vg.inicio);
      const fim = Date.parse(vg.fim);
      const sub = p.pontos.filter((x) => Date.parse(x.gps_em) >= ini && Date.parse(x.gps_em) <= fim).map((x) => [x.lat, x.lng]);
      camadas.push(mapa.linha(sub, { cor: '#F59E0B', peso: 7 }));
      mapa.enquadrar(sub);
    };
    limpar(resultado,
      p.limitado ? el('p', { class: 'aviso pequeno' }, 'Período com posições demais: mostrando só o começo. Escolha menos dias.') : null,
      el('div', { class: 'grade mini' },
        indicador('Distância', km(p.distancia_m)), indicador('Vel. máxima', kmh(p.velocidade_max_kmh)),
        indicador('Viagens', inteiro(p.viagens.length)), indicador('Alertas', inteiro(p.alertas.length))),
      pts.length ? null : el('p', { class: 'mudo' }, 'Nenhuma posição no período.'),
      p.viagens.length ? el('h3', { style: 'margin:6px 0 0' }, 'Viagens') : null,
      p.viagens.map((vg, i) => el('button', { class: 'item-veiculo', onclick: () => trecho(vg) },
        el('div', { class: 'linha entre' }, el('strong', {}, `${i + 1}. ${hora(vg.inicio)} – ${vg.em_andamento ? 'agora' : hora(vg.fim)}`), el('span', { class: 'num' }, km(vg.distancia_m))),
        el('div', { class: 'pequeno mudo' }, `${estado.de !== estado.ate ? `${data(vg.inicio.slice(0, 10))} · ` : ''}${duracaoH(vg.duracao_s)} · média ${kmh(vg.velocidade_media_kmh)} · máx. ${kmh(vg.velocidade_max_kmh)}`))),
      p.paradas.length ? el('h3', { style: 'margin:6px 0 0' }, 'Paradas') : null,
      p.paradas.map((s, i) => el('button', { class: 'item-veiculo', onclick: () => mapa?.ir(s.lat, s.lng, 17) },
        el('div', { class: 'linha entre' }, el('strong', {}, `Parada ${i + 1}`), el('span', {}, duracaoH(s.duracao_s))),
        el('div', { class: 'pequeno mudo' }, `${dataHora(s.inicio)} até ${hora(s.fim)}`))));
    if (mapa && pts.length > 1) montarPlayer(p);
  }

  /** Reprodução do trajeto: o veículo anda pelas posições, com a hora e a velocidade de cada uma. */
  function montarPlayer(p) {
    const v = veiculos.find((x) => String(x.id) === String(estado.veiculo));
    let i = 0;
    const mk = mapa.veiculo({ ...v, ...p.pontos[0], situacao: 'movimento', bloqueado: 0 });
    camadas.push(mk);
    const faixa = el('input', { type: 'range', min: 0, max: p.pontos.length - 1, value: 0, 'aria-label': 'Posição no trajeto' });
    const info = el('span', { class: 'pequeno num' });
    const velocidade = escolha(null, 'vel', { 1: '1×', 4: '4×', 16: '16×', 64: '64×' }, 4);
    const play = el('button', { class: 'icone-btn', title: 'Reproduzir', 'aria-label': 'Reproduzir' }, icone('play'));
    const mostrar = () => {
      const x = p.pontos[i];
      mk.atualizar({ ...v, ...x, situacao: x.velocidade_kmh >= 3 ? 'movimento' : x.ignicao === 1 ? 'ligado' : 'parado', bloqueado: 0 });
      faixa.value = i;
      info.textContent = `${dataHora(x.gps_em)} · ${kmh(x.velocidade_kmh)}${x.ignicao === 0 ? ' · desligado' : ''}`;
    };
    faixa.addEventListener('input', () => { i = Number(faixa.value); mostrar(); });
    play.addEventListener('click', () => {
      if (animacao) { clearInterval(animacao); animacao = null; limpar(play, icone('play')); return; }
      if (i >= p.pontos.length - 1) i = 0;
      limpar(play, icone('pausa'));
      animacao = setInterval(() => {
        i = Math.min(p.pontos.length - 1, i + Number(velocidade.value));
        mostrar();
        if (i >= p.pontos.length - 1) { clearInterval(animacao); animacao = null; limpar(play, icone('play')); }
      }, 120);
    });
    limpar(player, play, faixa, velocidade, info);
    player.classList.remove('oculto');
    mostrar();
  }
  ctx.parar(() => limparMapa());
  desenharFiltros();
  await carregar();
}

// ---------- Alertas ----------
async function telaAlertas(ctx) {
  const veiculos = await api.get(`${base(ctx)}/veiculos`);
  const estado = { status: 'pendentes', tipo: '', veiculo_id: '', de: '', ate: '' };
  const lista = el('div');
  const seletor = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const tratarTodos = el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, async () => {
    const obs = await perguntar('Tratar todos os pendentes', `Observação (opcional)${estado.tipo ? ` · só ${TIPOS_ALERTA[estado.tipo]}` : ''}${estado.veiculo_id ? ' · só do veículo filtrado' : ''}`, { obrigatorio: false });
    if (obs === null) return;
    const r = await api.post(`${base(ctx)}/alertas/tratar-todos`, { observacao: obs, tipo: estado.tipo || undefined, veiculo_id: estado.veiculo_id || undefined });
    toast(`${r.tratados} alerta(s) tratado(s).`);
    carregar();
  }) }, icone('check'), 'Tratar todos');
  const filtros = el('div', { class: 'filtros livre' },
    seletor('Situação', 'status', { pendentes: 'Pendentes', tratados: 'Tratados', todos: 'Todos' }),
    seletor('Tipo', 'tipo', { '': 'Todos', ...TIPOS_ALERTA }),
    seletor('Veículo', 'veiculo_id', { '': 'Todos', ...Object.fromEntries(veiculos.map((x) => [x.id, placa(x.placa)])) }),
    campoData('De', '', (x) => { estado.de = x; carregar(); }), campoData('Até', '', (x) => { estado.ate = x; carregar(); }),
    tratarTodos,
    el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, () => baixar(`${base(ctx)}/alertas${qs({ ...estado, csv: 1 })}`, 'alertas.csv')) }, icone('baixar'), 'CSV'));

  async function carregar() {
    const l = await api.get(`${base(ctx)}/alertas${qs(estado)}`);
    tratarTodos.disabled = estado.status === 'tratados' || !l.some((a) => !a.tratado_em);
    limpar(lista, tabela(['Quando', 'Veículo', 'Alerta', '>Velocidade', 'Local', 'Situação', '^Ações'], l.map((a) => el('tr', {},
      td(dataHora(a.ocorrido_em)), td([el('strong', {}, placa(a.placa)), a.veiculo ? el('div', { class: 'pequeno mudo' }, a.veiculo) : null]),
      td([etiquetaAlerta(a.tipo), el('div', { class: 'pequeno mudo' }, a.mensagem)]), td(a.velocidade_kmh !== null ? kmh(a.velocidade_kmh) : '—', 'dir num'),
      td(a.lat !== null ? el('a', { href: linkGoogle(a.lat, a.lng), target: '_blank', rel: 'noopener' }, 'ver no mapa') : '—'),
      td(a.tratado_em ? [etiqueta('tratado', 'ok'), el('div', { class: 'pequeno mudo' }, `${a.tratado_por_nome ?? ''} · ${dataHora(a.tratado_em)}`),
        a.observacao ? el('div', { class: 'pequeno' }, a.observacao) : null] : etiqueta('pendente', 'aviso')),
      el('td', { class: 'acoes' }, a.tratado_em ? null : botao('Tratar', 'primario', async () => {
        const obs = await perguntar('Tratar alerta', 'O que foi feito? (opcional)', { obrigatorio: false });
        if (obs === null) return;
        await api.post(`${base(ctx)}/alertas/${a.id}/tratar`, { observacao: obs });
        carregar();
      })))), estado.status === 'pendentes' ? 'Nenhum alerta pendente.' : 'Nenhum alerta com esses filtros.'));
  }
  limpar(ctx.conteudo, filtros, cartao(null, lista));
  ctx.parar(repetir(carregar, 20_000));
}

// ---------- Veículos ----------
async function telaVeiculos(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
  const novo = pode(ctx) ? el('button', { class: 'btn primario', onclick: () => formVeiculo(null) }, 'Novo veículo') : null;
  let rastreadores = [];
  let motoristas = [];

  async function formVeiculo(x) {
    const det = x ? await api.get(`${base(ctx)}/veiculos/${x.id}`) : null;
    const livres = rastreadores.filter((r) => !r.veiculo_id || r.veiculo_id === x?.id);
    const r = await formModal(x ? `Editar ${placa(x.placa)}` : 'Novo veículo', () => [
      el('div', { class: 'duas' }, campo('Placa', { name: 'placa', required: true, maxlength: 8, value: x ? placa(x.placa) : '', placeholder: 'ABC1D23', style: 'text-transform:uppercase' }),
        escolha('Tipo', 'tipo', TIPOS_VEICULO, x?.tipo ?? 'carro')),
      campo('Descrição (como aparece no mapa)', { name: 'descricao', maxlength: 120, value: x?.descricao ?? '', placeholder: 'Ex.: Caminhão 03 · Entregas' }),
      el('div', { class: 'tres' }, campo('Marca', { name: 'marca', maxlength: 60, value: x?.marca ?? '' }), campo('Modelo', { name: 'modelo', maxlength: 60, value: x?.modelo ?? '' }),
        campo('Ano', { name: 'ano', type: 'number', min: 1950, max: new Date().getFullYear() + 1, value: x?.ano ?? '' })),
      el('div', { class: 'duas' }, campo('Cor', { name: 'cor', maxlength: 30, value: x?.cor ?? '' }),
        campo('Limite de velocidade (km/h, 0 = sem alerta)', { name: 'limite_velocidade_kmh', type: 'number', min: 0, max: 300, value: x?.limite_velocidade_kmh ?? 0 })),
      escolha('Rastreador', 'rastreador_id', { '': 'Sem rastreador', ...Object.fromEntries(livres.map((r) => [r.id, `${r.imei} · ${r.modelo ?? PROTOCOLOS[r.protocolo]}`])) }, x?.rastreador_id ?? ''),
      escolha('Motorista', 'motorista_id', { '': 'Sem motorista fixo', ...Object.fromEntries(motoristas.filter((m) => m.ativo).map((m) => [m.id, m.nome])) }, x?.motorista_id ?? ''),
      x ? null : campo('Hodômetro atual (km)', { name: 'hodometro_km', type: 'number', min: 0, step: '0.1', value: 0 }),
      x ? marcar('Veículo ativo (inativo não conta no limite do plano e libera o rastreador)', { name: 'ativo', checked: Boolean(x.ativo) }) : null,
      det?.compartilhamentos.length ? el('fieldset', {}, el('legend', {}, 'Links de localização ativos'), det.compartilhamentos.map((c) => {
        const linha = el('div', { class: 'linha entre' }, el('span', { class: 'pequeno' }, `Criado ${dataHora(c.criado_em)} · vale até ${dataHora(c.expira_em)}`));
        linha.append(botao('Cancelar link', 'perigo', async () => { await api.del(`${base(ctx)}/compartilhamentos/${c.id}`); toast('Link cancelado.'); linha.remove(); }));
        return linha;
      })) : null,
    ], (d) => (x ? api.put(`${base(ctx)}/veiculos/${x.id}`, d) : api.post(`${base(ctx)}/veiculos`, d)), { largo: true });
    if (r) { toast('Veículo salvo.'); carregar(); }
  }

  async function carregar() {
    const [veiculos, rs, ms] = await Promise.all([api.get(`${base(ctx)}/veiculos`), api.get(`${base(ctx)}/rastreadores`), api.get(`${base(ctx)}/motoristas`)]);
    rastreadores = rs;
    motoristas = ms;
    limpar(corpo,
      cartao(null, tabela(['Placa', 'Veículo', 'Rastreador', 'Motorista', '>Limite', '>Hodômetro', 'Situação', '^Ações'], veiculos.map((x) => el('tr', { class: x.ativo ? '' : 'inativo' },
        td(el('strong', {}, placa(x.placa))), td([x.descricao ?? TIPOS_VEICULO[x.tipo], el('div', { class: 'pequeno mudo' }, [x.marca, x.modelo, x.ano, x.cor].filter(Boolean).join(' · '))]),
        td(x.imei ? [el('span', { class: 'mono pequeno' }, x.imei), el('div', { class: 'pequeno mudo' }, x.rastreador_modelo ?? PROTOCOLOS[x.protocolo])] : '—'),
        td(x.motorista ?? '—'), td(x.limite_velocidade_kmh ? kmh(x.limite_velocidade_kmh) : '—', 'dir num'), td(km(x.hodometro_m), 'dir num'),
        td([etiquetaSituacao(x.situacao), x.bloqueado ? etiqueta('bloqueado', 'erro') : null]),
        el('td', { class: 'acoes' },
          botaoIcone('historico', 'Histórico', () => { veiculoHistorico = x.id; ctx.ir('historico'); }),
          pode(ctx) ? botaoIcone('editar', 'Editar', () => formVeiculo(x)) : null,
          pode(ctx) ? botaoIcone('relatorios', 'Ajustar hodômetro', async () => {
            const v = await perguntar(`Hodômetro de ${placa(x.placa)}`, 'Quilometragem atual do painel do veículo (km)', { valor: String(Math.floor(x.hodometro_m / 1000)) });
            if (v === null) return;
            await api.post(`${base(ctx)}/veiculos/${x.id}/hodometro`, { km: v.replace(',', '.') });
            toast('Hodômetro ajustado.');
            carregar();
          }) : null,
          pode(ctx) ? botaoIcone('lixo', 'Excluir', async () => {
            const conf = await perguntar(`Excluir ${placa(x.placa)}`, 'Apaga o veículo e TODO o histórico dele (posições, alertas, comandos). Para só parar de rastrear, edite e desmarque "ativo". Digite a placa para confirmar:');
            if (!conf) return;
            await api.del(`${base(ctx)}/veiculos/${x.id}`, { confirmacao: conf });
            toast('Veículo excluído.');
            carregar();
          }, 'perigo') : null))), 'Nenhum veículo cadastrado.')),
      cartao('Rastreadores da empresa', el('p', { class: 'mudo', style: 'margin-top:0' },
        'Os equipamentos GT06 são entregues pela central (estoque do master). Um celular pode virar rastreador com o app gratuito Traccar Client.'),
      tabela(['Identificador (IMEI)', 'Modelo', 'Tipo', 'Chip', 'Veículo', 'Última comunicação'], rastreadores.map((r) => el('tr', {},
        td(el('span', { class: 'mono' }, r.imei)), td(r.modelo ?? '—'), td(PROTOCOLOS[r.protocolo]), td(r.chip_numero ? `${telefone(r.chip_numero)}${r.chip_operadora ? ` · ${r.chip_operadora}` : ''}` : '—'),
        td(r.placa ? placa(r.placa) : etiqueta('livre', 'info')), td(r.ultima_comunicacao ? `${dataHora(r.ultima_comunicacao)} (${desde(r.ultima_comunicacao)})` : 'nunca'))),
      'Nenhum rastreador nesta empresa.'),
      pode(ctx) ? el('div', { style: 'margin-top:12px' }, botao('Cadastrar celular como rastreador', '', async () => {
        const r = await api.post(`${base(ctx)}/rastreadores`, {});
        await carregar();
        modal('Celular cadastrado', (fechar) => [
          el('p', { class: 'mudo' }, 'Instale o app Traccar Client no celular (Android ou iPhone) e configure:'),
          el('pre', { class: 'codigo' }, `Identificador do dispositivo: ${r.imei}\nEndereço do servidor: ${location.origin}${BASE}/api/osmand\nFrequência: 30 segundos\nPrecisão: alta`),
          el('p', { class: 'mudo' }, 'Depois, edite o veículo e escolha este rastreador. O identificador funciona como senha: não divulgue.'),
          el('div', { class: 'linha', style: 'justify-content:flex-end' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
        ]);
      })) : null));
  }
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Veículos rastreados, com o rastreador instalado, motorista e limite de velocidade.'), novo), corpo);
  await carregar();
}

// ---------- Motoristas ----------
async function telaMotoristas(ctx) {
  const corpo = el('div');
  const form = async (m) => {
    const r = await formModal(m ? `Editar ${m.nome}` : 'Novo motorista', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: m?.nome ?? '' }),
      el('div', { class: 'duas' }, campo('CPF', { name: 'cpf', inputmode: 'numeric', value: m?.cpf ?? '' }), campo('Telefone', { name: 'telefone', inputmode: 'tel', value: m?.telefone ?? '' })),
      el('div', { class: 'tres' }, campo('CNH', { name: 'cnh', inputmode: 'numeric', value: m?.cnh ?? '' }), campo('Categoria', { name: 'cnh_categoria', maxlength: 3, value: m?.cnh_categoria ?? '' }),
        campo('Validade da CNH', { name: 'cnh_validade', type: 'date', value: m?.cnh_validade ?? '' })),
      m ? marcar('Ativo', { name: 'ativo', checked: Boolean(m.ativo) }) : null,
    ], (d) => (m ? api.put(`${base(ctx)}/motoristas/${m.id}`, d) : api.post(`${base(ctx)}/motoristas`, d)));
    if (r) { toast('Motorista salvo.'); carregar(); }
  };
  async function carregar() {
    const l = await api.get(`${base(ctx)}/motoristas`);
    const hoje = hojeLocal();
    limpar(corpo, cartao(null, tabela(['Nome', 'CPF', 'Telefone', 'CNH', 'Validade', 'Veículos', '^Ações'], l.map((m) => el('tr', { class: m.ativo ? '' : 'inativo' },
      td([el('strong', {}, m.nome), m.ativo ? null : el('div', { class: 'pequeno mudo' }, 'inativo')]), td(m.cpf ? m.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : '—'),
      td(m.telefone ? el('a', { href: `https://wa.me/55${m.telefone}`, target: '_blank', rel: 'noopener' }, telefone(m.telefone)) : '—'),
      td(m.cnh ? `${m.cnh}${m.cnh_categoria ? ` (${m.cnh_categoria})` : ''}` : '—'),
      td(!m.cnh_validade ? '—' : m.cnh_validade < hoje ? etiqueta(`vencida ${data(m.cnh_validade)}`, 'erro') : m.cnh_validade <= somarDias(hoje, 30) ? etiqueta(data(m.cnh_validade), 'aviso') : data(m.cnh_validade)),
      td(m.veiculos ?? '—'),
      el('td', { class: 'acoes' }, pode(ctx) ? [botaoIcone('editar', 'Editar', () => form(m)), botaoIcone('lixo', 'Excluir', async () => {
        if (!await confirmar('Excluir motorista', `Excluir ${m.nome}? Os veículos dele ficam sem motorista.`, 'Excluir')) return;
        await api.del(`${base(ctx)}/motoristas/${m.id}`);
        carregar();
      }, 'perigo')] : null))), 'Nenhum motorista cadastrado.')));
  }
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Motoristas, contato e validade da CNH (avisada no dashboard 30 dias antes).'),
    pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, 'Novo motorista') : null), corpo);
  await carregar();
}

// ---------- Cercas ----------
async function telaCercas(ctx) {
  ctx.telaCheia();
  const divMapa = el('div', { class: 'mapa' });
  const lado = el('aside', { class: 'lado' });
  const dica = el('div', { class: 'dica-mapa oculto' });
  limpar(ctx.conteudo, el('div', { class: 'tela-mapa' }, lado, el('div', { class: 'area-mapa' }, divMapa, dica)));
  const mapa = await criarMapa(divMapa);
  const veiculos = (await api.get(`${base(ctx)}/veiculos`)).filter((x) => x.ativo);
  let cercas = [];
  let camadas = [];
  let edicao = null; // { tipo, lat, lng, raio_m, pontos, desenho }

  const desenharCercas = () => {
    for (const c of camadas) c.remover();
    camadas = mapa ? cercas.filter((c) => !edicao || c.id !== edicao.id).map((c) => mapa.cerca(c, { aoClicar: () => pode(ctx) && editar(c) })) : [];
  };
  const redesenharEdicao = () => {
    edicao.desenho?.forEach((d) => d.remover());
    edicao.desenho = [];
    if (!mapa) return;
    if (edicao.tipo === 'circulo' && edicao.lat !== null) edicao.desenho.push(mapa.cerca({ ...edicao, cor: edicao.cor, nome: 'nova' }));
    if (edicao.tipo === 'poligono') {
      if (edicao.pontos.length >= 3) edicao.desenho.push(mapa.cerca({ tipo: 'poligono', pontos: edicao.pontos, cor: edicao.cor, nome: 'nova' }));
      else if (edicao.pontos.length === 2) edicao.desenho.push(mapa.linha(edicao.pontos, { cor: edicao.cor, peso: 3 }));
      edicao.pontos.forEach((p, i) => edicao.desenho.push(mapa.ponto(p[0], p[1], { classe: 'vertice', texto: String(i + 1) })));
    }
  };
  mapa?.aoClicar((p) => {
    if (!edicao) return;
    if (edicao.tipo === 'circulo') Object.assign(edicao, { lat: p.lat, lng: p.lng });
    else edicao.pontos.push([Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
    redesenharEdicao();
  });

  function editar(c) {
    edicao = c
      ? { ...c, pontos: c.pontos ? [...c.pontos] : [], desenho: [] }
      : { tipo: 'circulo', nome: '', lat: null, lng: null, raio_m: 300, pontos: [], cor: '#2563EB', alertar_entrada: 1, alertar_saida: 1, ativa: 1, veiculos: [], desenho: [] };
    desenharCercas();
    redesenharEdicao();
    if (c && mapa) mapa.enquadrar(c.tipo === 'circulo' ? [[c.lat, c.lng]] : c.pontos, 16);
    formulario();
  }

  function formulario() {
    const f = el('form', { class: 'form' });
    const tipo = escolha('Formato', 'tipo', { circulo: 'Círculo (centro e raio)', poligono: 'Polígono (desenhe os pontos)' }, edicao.tipo);
    tipo.querySelector('select').addEventListener('change', (e) => { edicao.tipo = e.target.value; redesenharEdicao(); formulario(); });
    const raio = campo('Raio (metros)', { name: 'raio_m', type: 'number', min: 20, max: 200000, value: edicao.raio_m ?? 300 });
    raio.querySelector('input').addEventListener('input', (e) => { edicao.raio_m = Number(e.target.value) || 0; redesenharEdicao(); });
    const cor = campo('Cor', { name: 'cor', type: 'color', value: edicao.cor });
    cor.querySelector('input').addEventListener('input', (e) => { edicao.cor = e.target.value; redesenharEdicao(); });
    dica.textContent = edicao.tipo === 'circulo' ? 'Clique no mapa para marcar o centro da cerca.' : 'Clique no mapa para marcar cada ponto da cerca (mínimo 3).';
    dica.classList.remove('oculto');
    f.append(
      el('h2', { style: 'margin:0' }, edicao.id ? `Editar ${edicao.nome}` : 'Nova cerca'),
      campo('Nome', { name: 'nome', required: true, maxlength: 80, value: edicao.nome, placeholder: 'Ex.: Garagem, Cliente X, Área de entrega' }),
      tipo, edicao.tipo === 'circulo' ? raio : el('div', { class: 'linha', style: 'gap:6px' }, el('span', { class: 'pequeno mudo' }, `${edicao.pontos.length} ponto(s)`),
        el('button', { type: 'button', class: 'btn pequeno', onclick: () => { edicao.pontos.pop(); redesenharEdicao(); formulario(); } }, 'Desfazer ponto'),
        el('button', { type: 'button', class: 'btn pequeno', onclick: () => { edicao.pontos = []; redesenharEdicao(); formulario(); } }, 'Limpar')),
      cor,
      marcar('Alertar na entrada', { name: 'alertar_entrada', checked: Boolean(edicao.alertar_entrada) }),
      marcar('Alertar na saída', { name: 'alertar_saida', checked: Boolean(edicao.alertar_saida) }),
      marcar('Cerca ativa', { name: 'ativa', checked: Boolean(edicao.ativa) }),
      el('fieldset', {}, el('legend', {}, 'Veículos (nenhum marcado = todos)'), el('div', { class: 'lista-marcar' },
        veiculos.map((x) => marcar(placa(x.placa), { name: `v_${x.id}`, checked: edicao.veiculos.includes(x.id) })))),
      el('div', { class: 'linha entre' },
        el('button', { type: 'button', class: 'btn', onclick: () => { edicao.desenho?.forEach((d) => d.remover()); edicao = null; dica.classList.add('oculto'); desenharCercas(); lista(); } }, 'Cancelar'),
        edicao.id ? el('button', { type: 'button', class: 'btn perigo', onclick: (e) => acao(e.currentTarget, async () => {
          if (!await confirmar('Excluir cerca', `Excluir a cerca ${edicao.nome}?`, 'Excluir')) return;
          await api.del(`${base(ctx)}/cercas/${edicao.id}`);
          edicao.desenho?.forEach((d) => d.remover());
          edicao = null;
          dica.classList.add('oculto');
          carregar();
        }) }, 'Excluir') : null,
        el('button', { class: 'btn primario' }, 'Salvar')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(f.querySelector('button.primario'), async () => {
        const d = Object.fromEntries(new FormData(f));
        const corpo = {
          nome: d.nome, tipo: edicao.tipo, cor: edicao.cor, alertar_entrada: f.alertar_entrada.checked, alertar_saida: f.alertar_saida.checked, ativa: f.ativa.checked,
          veiculos: veiculos.filter((x) => f[`v_${x.id}`].checked).map((x) => x.id),
          ...(edicao.tipo === 'circulo' ? { lat: edicao.lat, lng: edicao.lng, raio_m: Number(d.raio_m) } : { pontos: edicao.pontos }),
        };
        if (edicao.tipo === 'circulo' && edicao.lat === null) throw new Error('Clique no mapa para marcar o centro da cerca.');
        if (edicao.id) await api.put(`${base(ctx)}/cercas/${edicao.id}`, corpo);
        else await api.post(`${base(ctx)}/cercas`, corpo);
        toast('Cerca salva.');
        edicao.desenho?.forEach((x) => x.remover());
        edicao = null;
        dica.classList.add('oculto');
        carregar();
      });
    });
    limpar(lado, f);
  }

  function lista() {
    limpar(lado,
      pode(ctx) ? el('button', { class: 'btn primario', onclick: () => editar(null) }, 'Nova cerca') : null,
      el('p', { class: 'pequeno mudo' }, 'Avisa quando um veículo entra ou sai da área. Clique numa cerca para editar.'),
      cercas.length ? cercas.map((c) => el('button', { class: 'item-veiculo', onclick: () => (pode(ctx) ? editar(c) : mapa?.enquadrar(c.tipo === 'circulo' ? [[c.lat, c.lng]] : c.pontos, 16)) },
        el('div', { class: 'linha entre' }, el('strong', {}, el('i', { class: 'bolinha', style: `background:${c.cor}` }), c.nome), c.ativa ? null : etiqueta('inativa')),
        el('div', { class: 'pequeno mudo' }, [c.tipo === 'circulo' ? `círculo de ${inteiro(c.raio_m)} m` : `polígono de ${c.pontos.length} pontos`,
          [c.alertar_entrada ? 'entrada' : null, c.alertar_saida ? 'saída' : null].filter(Boolean).join(' e ') || 'sem alerta',
          c.veiculos.length ? `${c.veiculos.length} veículo(s)` : 'todos os veículos'].join(' · '))))
        : el('p', { class: 'mudo' }, 'Nenhuma cerca criada.'));
  }

  async function carregar() {
    cercas = await api.get(`${base(ctx)}/cercas`);
    desenharCercas();
    if (mapa && cercas.length) mapa.enquadrar(cercas.flatMap((c) => (c.tipo === 'circulo' ? [[c.lat, c.lng]] : c.pontos)), 15);
    lista();
  }
  await carregar();
}

// ---------- Manutenção ----------
async function telaManutencao(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
  const veiculos = (await api.get(`${base(ctx)}/veiculos`)).filter((x) => x.ativo);
  const SIT = { vencida: ['vencida', 'erro'], proxima: ['próxima', 'aviso'], em_dia: ['em dia', 'ok'] };
  const form = async (m) => {
    const r = await formModal(m ? `Editar ${m.descricao}` : 'Novo plano de manutenção', () => [
      escolha('Veículo', 'veiculo_id', Object.fromEntries(veiculos.map((x) => [x.id, `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`])), m?.veiculo_id ?? veiculos[0]?.id),
      campo('Serviço', { name: 'descricao', required: true, maxlength: 120, value: m?.descricao ?? '', placeholder: 'Ex.: Troca de óleo, Revisão, Pneus' }),
      el('div', { class: 'duas' }, campo('A cada (km)', { name: 'intervalo_km', type: 'number', min: 1, value: m?.intervalo_km ?? '' }),
        campo('A cada (dias)', { name: 'intervalo_dias', type: 'number', min: 1, value: m?.intervalo_dias ?? '' })),
      el('div', { class: 'duas' }, campo('Km da última vez (vazio = hodômetro atual)', { name: 'ultima_km', type: 'number', min: 0, value: m?.ultima_km ?? '' }),
        campo('Data da última vez', { name: 'ultima_data', type: 'date', value: m?.ultima_data ?? hojeLocal() })),
    ], (d) => (m ? api.put(`${base(ctx)}/manutencoes/${m.id}`, d) : api.post(`${base(ctx)}/manutencoes`, d)));
    if (r) { toast('Plano salvo.'); carregar(); }
  };
  const realizar = async (m) => {
    const r = await formModal(`${m.descricao} · ${placa(m.placa)}`, () => [
      el('div', { class: 'duas' }, campo('Data', { name: 'data', type: 'date', value: hojeLocal(), required: true }), campo('Km', { name: 'km', type: 'number', min: 0, value: m.km_atual })),
      campo('Custo (R$)', { name: 'custo', inputmode: 'decimal', placeholder: '0,00' }),
      campo('Observação', { name: 'observacao', maxlength: 300, placeholder: 'Oficina, peças, nota…' }),
    ], (d) => api.post(`${base(ctx)}/manutencoes/${m.id}/realizar`, { data: d.data, km: d.km, custo_centavos: centavos(d.custo) ?? 0, observacao: d.observacao }), { rotulo: 'Registrar' });
    if (r) { toast('Manutenção registrada.'); carregar(); }
  };
  async function carregar() {
    const { planos, registros } = await api.get(`${base(ctx)}/manutencoes`);
    limpar(corpo,
      cartao('Planos', tabela(['Veículo', 'Serviço', 'Intervalo', 'Última', 'Próxima', 'Situação', '^Ações'], planos.map((m) => el('tr', {},
        td([el('strong', {}, placa(m.placa)), el('div', { class: 'pequeno mudo' }, `hodômetro ${inteiro(m.km_atual)} km`)]), td(m.descricao),
        td([m.intervalo_km ? `${inteiro(m.intervalo_km)} km` : null, m.intervalo_dias ? `${inteiro(m.intervalo_dias)} dias` : null].filter(Boolean).join(' ou ')),
        td(`${inteiro(m.ultima_km)} km · ${data(m.ultima_data)}`),
        td([m.proxima_km !== null ? `${inteiro(m.proxima_km)} km${m.faltam_km > 0 ? ` (faltam ${inteiro(m.faltam_km)})` : ''}` : null, m.proxima_data ? data(m.proxima_data) : null].filter(Boolean).join(' · ')),
        td(etiqueta(...SIT[m.situacao])),
        el('td', { class: 'acoes' }, pode(ctx) ? [botao('Feita', 'primario', () => realizar(m)), botaoIcone('editar', 'Editar', () => form(m)), botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar('Excluir plano', `Excluir "${m.descricao}" de ${placa(m.placa)}? O histórico fica guardado.`, 'Excluir')) return;
          await api.del(`${base(ctx)}/manutencoes/${m.id}`);
          carregar();
        }, 'perigo')] : null))), 'Nenhum plano de manutenção. Cadastre as revisões por km ou por tempo e o sistema avisa quando vencerem.')),
      cartao('Histórico', tabela(['Data', 'Veículo', 'Serviço', '>Km', '>Custo', 'Observação', 'Registrado por'], registros.map((x) => el('tr', {},
        td(data(x.data)), td(placa(x.placa)), td(x.descricao), td(inteiro(x.km), 'dir num'), td(dinheiro(x.custo_centavos), 'dir num'), td(x.observacao ?? '—'), td(x.usuario ?? '—'))),
      'Nenhuma manutenção registrada.')));
  }
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Revisões por quilometragem (pelo hodômetro do rastreador) ou por tempo.'),
    pode(ctx) ? el('button', { class: 'btn primario', onclick: () => (veiculos.length ? form(null) : toast('Cadastre um veículo antes.', true)) }, 'Novo plano') : null), corpo);
  await carregar();
}

// ---------- Relatórios ----------
async function telaRelatorios(ctx) {
  const veiculos = await api.get(`${base(ctx)}/veiculos`);
  const hoje = hojeLocal();
  const estado = { de: somarDias(hoje, -6), ate: hoje, veiculo_id: veiculos[0]?.id ?? '' };
  const filtros = el('div', { class: 'filtros livre' });
  const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
  const viagensDiv = el('div');
  const atalho = (rotulo, dias) => el('button', { class: 'btn', type: 'button', onclick: () => { estado.de = somarDias(hoje, -dias); estado.ate = hoje; desenharFiltros(); carregar(); } }, rotulo);
  const desenharFiltros = () => limpar(filtros, campoData('De', estado.de, (x) => { estado.de = x; carregar(); }), campoData('Até', estado.ate, (x) => { estado.ate = x; carregar(); }),
    atalho('Hoje', 0), atalho('7 dias', 6), atalho('30 dias', 29),
    el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, () => baixar(`${base(ctx)}/relatorios/resumo${qs({ de: estado.de, ate: estado.ate, csv: 1 })}`,
      `resumo-${estado.de}-a-${estado.ate}.csv`)) }, icone('baixar'), 'CSV'),
    el('button', { class: 'btn', type: 'button', onclick: () => print() }, 'Imprimir'));

  async function carregarViagens() {
    if (!estado.veiculo_id) return limpar(viagensDiv, el('p', { class: 'mudo' }, 'Nenhum veículo.'));
    try {
      const r = await api.get(`${base(ctx)}/relatorios/viagens${qs({ veiculo_id: estado.veiculo_id, de: estado.de, ate: estado.ate })}`);
      limpar(viagensDiv, el('p', { class: 'pequeno mudo' }, `${inteiro(r.viagens.length)} viagem(ns) · ${km(r.distancia_m)} · máxima ${kmh(r.velocidade_max_kmh)} · ${inteiro(r.paradas.length)} parada(s)`),
        tabela(['Início', 'Fim', '>Duração', '>Distância', '>Média', '>Máxima', 'Saída', 'Chegada'], r.viagens.map((x) => el('tr', {},
          td(dataHora(x.inicio)), td(x.em_andamento ? etiqueta('em andamento', 'info') : dataHora(x.fim)), td(duracaoH(x.duracao_s), 'dir'), td(km(x.distancia_m), 'dir num'),
          td(kmh(x.velocidade_media_kmh), 'dir num'), td(kmh(x.velocidade_max_kmh), 'dir num'),
          td(el('a', { href: linkGoogle(x.origem.lat, x.origem.lng), target: '_blank', rel: 'noopener' }, 'mapa')),
          td(el('a', { href: linkGoogle(x.destino.lat, x.destino.lng), target: '_blank', rel: 'noopener' }, 'mapa')))), 'Nenhuma viagem no período.'));
    } catch (err) {
      limpar(viagensDiv, el('p', { class: 'aviso erro' }, err.message));
    }
  }

  async function carregar() {
    const r = await api.get(`${base(ctx)}/relatorios/resumo${qs({ de: estado.de, ate: estado.ate })}`);
    const t = r.linhas.reduce((s, x) => ({ d: s.d + x.distancia_m, l: s.l + x.ligado_s, e: s.e + x.excessos, a: s.a + x.alertas, m: Math.max(s.m, x.velocidade_max_kmh) }), { d: 0, l: 0, e: 0, a: 0, m: 0 });
    const selV = escolha(null, 'veiculo_id', Object.fromEntries(veiculos.map((x) => [x.id, placa(x.placa)])), estado.veiculo_id);
    selV.addEventListener('change', () => { estado.veiculo_id = selV.value; carregarViagens(); });
    limpar(corpo,
      el('div', { class: 'grade' }, indicador('Distância total', km(t.d)), indicador('Motor ligado', duracaoH(t.l)), indicador('Velocidade máxima', kmh(t.m)),
        indicador('Excessos de velocidade', inteiro(t.e), `${inteiro(t.a)} alerta(s) no total`)),
      cartao(`Resumo por veículo · ${data(r.de)} a ${data(r.ate)}`, tabela(['Veículo', 'Motorista', '>Distância', '>Motor ligado', '>Vel. máx.', '>Dias com uso', '>Excessos', '>Alertas'],
        r.linhas.map((x) => el('tr', {}, td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(x.motorista ?? '—'),
          td(km(x.distancia_m), 'dir num'), td(duracaoH(x.ligado_s), 'dir'), td(kmh(x.velocidade_max_kmh), 'dir num'), td(inteiro(x.dias_uso), 'dir num'),
          td(x.excessos ? etiqueta(inteiro(x.excessos), 'aviso') : '0', 'dir'), td(inteiro(x.alertas), 'dir num'))), 'Nenhum veículo.')),
      cartao('Viagens do veículo', el('div', { class: 'linha', style: 'margin-bottom:10px' }, el('label', { class: 'campo', style: 'min-width:200px' }, 'Veículo', selV),
        el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, () => baixar(`${base(ctx)}/relatorios/viagens${qs({ veiculo_id: estado.veiculo_id, de: estado.de, ate: estado.ate, csv: 1 })}`,
          'viagens.csv')) }, icone('baixar'), 'CSV das viagens')), el('p', { class: 'pequeno fraco', style: 'margin:0 0 8px' }, 'Até 31 dias por consulta.'), viagensDiv));
    await carregarViagens();
  }
  desenharFiltros();
  limpar(ctx.conteudo, filtros, corpo);
  await carregar();
}

// ---------- Comandos ----------
async function telaComandos(ctx) {
  const lista = el('div');
  async function carregar() {
    const l = await api.get(`${base(ctx)}/comandos`);
    limpar(lista, tabela(['Criado', 'Veículo', 'Comando', 'Situação', 'Resposta', 'Por', '^Ações'], l.map((c) => el('tr', {},
      td(dataHora(c.criado_em)), td(placa(c.placa)), td([TIPOS_COMANDO[c.tipo], el('div', { class: 'pequeno mono mudo' }, c.texto)]),
      td([etiquetaComando(c.status), c.respondido_em ? el('div', { class: 'pequeno mudo' }, dataHora(c.respondido_em)) : null]),
      td(c.resposta ?? '—'), td(c.usuario ?? '—'),
      el('td', { class: 'acoes' }, c.status === 'pendente' && pode(ctx) ? botao('Cancelar', 'perigo', async () => {
        await api.post(`${base(ctx)}/comandos/${c.id}/cancelar`);
        carregar();
      }) : null))), 'Nenhum comando enviado. Os comandos (bloquear, desbloquear, pedir posição) são enviados pelo mapa ao vivo.'));
  }
  const veiculos = (await api.get(`${base(ctx)}/veiculos`)).filter((x) => x.ativo && x.imei && x.protocolo !== 'osmand');
  const novo = pode(ctx) && veiculos.length ? el('button', { class: 'btn primario', onclick: async () => {
    const r = await formModal('Enviar comando', (f) => {
      const tipo = escolha('Comando', 'tipo', Object.fromEntries(Object.entries(TIPOS_COMANDO).filter(([k]) => k !== 'bloquear')), 'status');
      const texto = campo('Texto do comando (exatamente como no manual, ex.: SZCS#SOURCE_OFF_TYPE=0)', { name: 'texto', maxlength: 120, class: 'mono' });
      const ajustar = () => texto.classList.toggle('oculto', f.querySelector('[name=tipo]').value !== 'personalizado');
      tipo.querySelector('select').addEventListener('change', ajustar);
      queueMicrotask(ajustar);
      return [escolha('Veículo', 'veiculo_id', Object.fromEntries(veiculos.map((x) => [x.id, `${placa(x.placa)} · ${x.rastreador_modelo ?? x.imei}`])), veiculos[0].id), tipo, texto,
        el('p', { class: 'pequeno fraco', style: 'margin:0' }, 'Para bloquear, use o botão Bloquear no mapa ao vivo (pede a placa para confirmar).')];
    }, (d) => api.post(`${base(ctx)}/veiculos/${d.veiculo_id}/comandos`, { tipo: d.tipo, texto: d.texto }), { rotulo: 'Enviar' });
    if (r) { toast('Comando criado.'); carregar(); }
  } }, 'Enviar comando') : null;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Comandos enviados aos rastreadores e as respostas. Sem conexão, o comando espera o equipamento conectar (expira em 24 h).'), novo),
    cartao(null, lista));
  ctx.parar(repetir(carregar, 10_000));
}

// ---------- Configurações ----------
async function telaConfiguracoes(ctx) {
  const c = await api.get(`${base(ctx)}/configuracoes`);
  const e = c.empresa;
  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const f = el('form', { class: 'form' },
    marcar('Alertar quando a ignição ligar ou desligar', { name: 'alertar_ignicao', checked: e.alertar_ignicao, disabled: !pode(ctx) }),
    el('fieldset', {}, el('legend', {}, 'Horário de uso permitido (fora dele, gera alerta ao ligar o veículo)'),
      el('div', { class: 'duas' }, campo('Início', { name: 'horario_inicio', type: 'time', value: e.horario_inicio ?? '', disabled: !pode(ctx) }),
        campo('Fim', { name: 'horario_fim', type: 'time', value: e.horario_fim ?? '', disabled: !pode(ctx) })),
      el('div', { class: 'linha' }, DIAS.map((d, i) => marcar(d, { name: `dia_${i}`, checked: e.dias_uso.includes(String(i)), disabled: !pode(ctx) }))),
      el('p', { class: 'pequeno fraco', style: 'margin:0' }, 'Deixe o horário vazio para não usar este alerta. Pode virar a noite (ex.: 22:00 às 06:00).')),
    campo('Alertar veículo sem comunicação depois de (minutos, 0 = não alertar)', { name: 'sem_comunicacao_min', type: 'number', min: 0, value: e.sem_comunicacao_min, disabled: !pode(ctx) }),
    el('div', { class: 'duas' }, campo('E-mail de contato', { name: 'email', type: 'email', value: e.email ?? '', disabled: !pode(ctx) }),
      campo('Telefone', { name: 'telefone', value: e.telefone ?? '', disabled: !pode(ctx) })),
    pode(ctx) ? el('div', {}, el('button', { class: 'btn primario' }, 'Salvar')) : null);
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    acao(f.querySelector('button'), async () => {
      const d = Object.fromEntries(new FormData(f));
      await api.put(`${base(ctx)}/configuracoes`, {
        alertar_ignicao: f.alertar_ignicao.checked, horario_inicio: d.horario_inicio, horario_fim: d.horario_fim,
        dias_uso: DIAS.map((_, i) => (f[`dia_${i}`].checked ? i : '')).join(''), sem_comunicacao_min: d.sem_comunicacao_min, email: d.email, telefone: d.telefone,
      });
      toast('Configurações salvas.');
    });
  });

  const usuarios = el('div');
  const formUsuario = async (u) => {
    const r = await formModal(u ? `Editar ${u.nome}` : 'Novo usuário', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: u?.nome ?? '' }),
      u ? null : campo('E-mail', { name: 'email', type: 'email', required: true }),
      escolha('Perfil', 'perfil', { cliente: PERFIS.cliente, operador: PERFIS.operador }, u?.perfil ?? 'operador'),
      campo(u ? 'Nova senha (vazio = manter)' : 'Senha (mínimo 8 caracteres)', { name: 'senha', type: 'password', minlength: 8, required: !u, autocomplete: 'new-password' }),
      u ? marcar('Ativo', { name: 'ativo', checked: Boolean(u.ativo) }) : null,
    ], (d) => (u ? api.put(`${base(ctx)}/usuarios/${u.id}`, d) : api.post(`${base(ctx)}/usuarios`, d)));
    if (r) { toast('Usuário salvo.'); recarregarUsuarios(); }
  };
  const desenharUsuarios = (lista) => limpar(usuarios, tabela(['Nome', 'E-mail', 'Perfil', 'Situação', 'Último acesso', '^Ações'], lista.map((u) => el('tr', {},
    td(u.nome), td(u.email), td(PERFIS[u.perfil]), td(u.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo')), td(dataHora(u.ultimo_acesso)),
    el('td', { class: 'acoes' }, pode(ctx) ? botaoIcone('editar', 'Editar', () => formUsuario(u)) : null))), 'Nenhum usuário.'));
  const recarregarUsuarios = async () => desenharUsuarios((await api.get(`${base(ctx)}/configuracoes`)).usuarios);
  desenharUsuarios(c.usuarios);

  limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
    el('div', { class: 'c7' }, cartao('Alertas e contato', f)),
    el('div', { class: 'c5' }, cartao('Plano contratado',
      linhaDado('Veículos ativos', `${inteiro(c.veiculos_ativos)} de ${inteiro(e.limite_veiculos)}`),
      linhaDado('Mensalidade por veículo', dinheiro(e.mensalidade_centavos)),
      linhaDado('Total do mês', dinheiro(e.mensalidade_centavos * c.veiculos_ativos)),
      el('p', { class: 'pequeno fraco' }, 'Para mudar o plano, fale com o suporte.'))),
    el('div', { class: 'c12' }, cartao('Usuários da empresa',
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Administrador: tudo da empresa. Operador: acompanha o mapa, o histórico e os relatórios e trata os alertas, sem alterar cadastros nem enviar comandos.'),
      usuarios, pode(ctx) ? el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn primario', onclick: () => formUsuario(null) }, 'Novo usuário')) : null))));
}

async function telaIntegracoes(ctx) {
  const cfg = await configPublica();
  await painelIntegracoes(ctx.conteudo, {
    listar: () => api.get(`${base(ctx)}/chaves`),
    criar: (d) => api.post(`${base(ctx)}/chaves`, d),
    revogar: (id) => api.del(`${base(ctx)}/chaves/${id}`),
    portaGt06: cfg.gt06_porta,
  });
}

export const TELAS_EMPRESA = {
  dashboard: telaDashboard, mapa: telaMapa, historico: telaHistorico, alertas: telaAlertas, veiculos: telaVeiculos, motoristas: telaMotoristas, cercas: telaCercas,
  manutencao: telaManutencao, relatorios: telaRelatorios, comandos: telaComandos, configuracoes: telaConfiguracoes, integracoes: telaIntegracoes,
};
