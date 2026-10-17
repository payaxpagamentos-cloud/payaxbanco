import { api, sessao, usarSessao } from './api.js';
import { el, $, limpar, dinheiro, km, minutos, dataHora, hora, iniciais, FORMAS, CATEGORIAS, etiquetaStatus, toast, acao, perguntar, confirmar, marca, repetir, modal,
  lerForm, hojeLocal, somarDias } from './ui.js';
import { criarMapa, camada, ICONES, enquadrar } from './mapa.js';
import { telaEntrada } from './entrada.js';

usarSessao('motorista');
const raiz = $('#app');

const pulados = new Set(); // corridas pagas cuja avaliação o motorista pulou
let mapa, eu, pontos, pararAtualizacao, perfil = null, posicao = null, gpsManual = false, vigia = null, ultimoEnvio = 0, ofertasVistas = new Set();

window.addEventListener('taxi:sair', () => iniciar());

function iniciar() {
  pararAtualizacao?.();
  if (vigia !== null) navigator.geolocation?.clearWatch(vigia);
  vigia = null;
  const s = sessao.get();
  if (!s?.token || s.usuario?.perfil !== 'motorista') {
    telaEntrada(raiz, { titulo: 'Dirija com a gente', perfis: ['motorista'], cadastro: 'motorista', aoEntrar: iniciar });
    return;
  }
  montarApp();
}

async function montarApp() {
  const painel = el('div', { class: 'app-painel' });
  const divMapa = el('div', { class: 'mapa' });
  limpar(raiz, el('div', { class: 'app' },
    el('div', { class: 'app-topo' }, marca('Motorista'), el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', onclick: ganhos }, 'Ganhos'),
      el('button', { class: 'btn pequeno', onclick: conta }, 'Conta'),
      el('button', { class: 'btn pequeno', onclick: sair }, 'Sair'))),
    el('div', { class: 'app-mapa' }, divMapa),
    painel));
  mapa = await criarMapa(divMapa);
  eu = camada(mapa);
  pontos = camada(mapa);
  // Sem GPS (ou no computador), o motorista marca a própria posição tocando no mapa.
  mapa?.on('click', (e) => { if (gpsManual) definirPosicao({ lat: e.latlng.lat, lng: e.latlng.lng }, true); });
  iniciarGps();
  pararAtualizacao = repetir(() => atualizar(painel), 3000);
}

async function sair() {
  if (perfil?.online && !(await confirmar('Sair', 'Você vai ficar offline e parar de receber corridas.', 'Sair'))) return;
  if (perfil?.online) await api.post('/motorista/online', { online: false }).catch(() => {});
  sessao.limpar();
  iniciar();
}

function iniciarGps() {
  if (!navigator.geolocation) { gpsManual = true; return; }
  vigia = navigator.geolocation.watchPosition(
    (p) => { gpsManual = false; definirPosicao({ lat: p.coords.latitude, lng: p.coords.longitude }); },
    () => { gpsManual = true; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20_000 });
}

/** Mostra a posição no mapa e envia ao servidor (no máximo a cada 4 s, ou na hora se marcada à mão). */
async function definirPosicao(p, forcar = false) {
  const primeira = !posicao;
  posicao = p;
  eu.atualizar([{ chave: 'eu', ...p, icone: ICONES.eu() }]);
  if (primeira) mapa?.setView([p.lat, p.lng], 15);
  if (!perfil?.online || (!forcar && Date.now() - ultimoEnvio < 4000)) return;
  ultimoEnvio = Date.now();
  await api.post('/motorista/posicao', p).catch(() => {});
}

async function atualizar(painel) {
  perfil = await api.get('/motorista/perfil');
  // Parado, o GPS não envia nada: renova a posição a cada minuto para continuar visível.
  if (perfil.online && posicao && Date.now() - ultimoEnvio > 60_000) definirPosicao(posicao, true);
  if (perfil.situacao !== 'aprovado') return desenharCadastro(painel);
  const corrida = await api.get('/motorista/corrida-atual');
  if (corrida && !(corrida.status === 'finalizada' && pulados.has(corrida.id))) return desenharCorrida(painel, corrida);
  if (!perfil.online) return desenharOffline(painel);
  const ofertas = await api.get('/motorista/ofertas');
  desenharOfertas(painel, ofertas);
}

function desenharCadastro(painel) {
  pontos.limpar();
  const msg = {
    pendente: ['Cadastro em análise', 'A central está conferindo seus documentos e o veículo. Você recebe corridas assim que for aprovado.'],
    recusado: ['Cadastro recusado', perfil.motivo || 'Fale com a central para saber mais.'],
    bloqueado: ['Cadastro bloqueado', perfil.motivo || 'Fale com a central para saber mais.'],
  }[perfil.situacao];
  if (painel.dataset.chave === `cad:${perfil.situacao}`) return;
  painel.dataset.chave = `cad:${perfil.situacao}`;
  limpar(painel, el('div', { class: 'alca' }), el('h2', {}, msg[0]), el('p', { class: 'mudo' }, msg[1]),
    el('div', { class: 'linha' }, perfil.veiculos.map((v) => el('span', { class: 'etiqueta' }, `${v.placa} · ${v.situacao}`))));
}

function desenharOffline(painel) {
  pontos.limpar();
  const aprovados = perfil.veiculos.filter((v) => v.situacao === 'aprovado');
  const chave = `off:${aprovados.map((v) => v.id).join(',')}:${perfil.veiculo_id}:${Boolean(posicao)}:${gpsManual}`;
  if (painel.dataset.chave === chave) return;
  painel.dataset.chave = chave;
  const veiculo = el('select', { 'aria-label': 'Veículo' }, aprovados.map((v) => el('option', { value: v.id, selected: v.id === perfil.veiculo_id },
    `${v.placa} · ${v.marca_modelo} (${CATEGORIAS[v.categoria]})`)));
  const botao = el('button', { class: 'btn primario grande', disabled: !aprovados.length }, 'Ficar online');
  botao.addEventListener('click', () => acao(botao, async () => {
    if (!posicao) throw new Error(gpsManual ? 'Toque no mapa para marcar onde você está.' : 'Aguardando o GPS…');
    await api.post('/motorista/online', { online: true, veiculo_id: Number(veiculo.value), ...posicao });
    toast('Você está online. Aguarde as corridas.');
    delete painel.dataset.chave;
    await atualizar(painel);
  }));
  limpar(painel, el('div', { class: 'alca' }),
    el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, `Olá, ${perfil.nome.split(' ')[0]}`), el('span', { class: 'etiqueta' }, 'Offline')),
    el('p', { class: 'mudo' }, perfil.nota_media ? `Sua nota: ★ ${perfil.nota_media.toLocaleString('pt-BR')} · saldo ${dinheiro(perfil.saldo_centavos)}` : `Saldo ${dinheiro(perfil.saldo_centavos)}`),
    aprovados.length ? el('label', { class: 'campo' }, 'Veículo', veiculo) : el('div', { class: 'aviso' }, 'Nenhum veículo aprovado. Cadastre um em Conta.'),
    gpsManual ? el('div', { class: 'aviso', style: 'margin-top:10px' }, 'GPS indisponível: toque no mapa para marcar sua posição.') : null,
    el('div', { style: 'margin-top:12px' }, botao));
}

function desenharOfertas(painel, ofertas) {
  pontos.atualizar(ofertas.map((o) => ({ chave: `o${o.id}`, lat: o.origem_lat, lng: o.origem_lng, icone: ICONES.origem() })));
  const novas = ofertas.filter((o) => !ofertasVistas.has(o.id));
  if (novas.length) {
    novas.forEach((o) => ofertasVistas.add(o.id));
    toast(novas.length === 1 ? 'Nova corrida disponível!' : `${novas.length} novas corridas!`);
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* sem vibração */ }
  }
  const chave = `on:${ofertas.map((o) => o.id).join(',')}:${gpsManual}`;
  if (painel.dataset.chave === chave) return;
  painel.dataset.chave = chave;
  const offline = el('button', { class: 'btn pequeno' }, 'Ficar offline');
  offline.addEventListener('click', () => acao(offline, async () => { await api.post('/motorista/online', { online: false }); delete painel.dataset.chave; await atualizar(painel); }));
  limpar(painel, el('div', { class: 'alca' }),
    el('div', { class: 'linha entre' }, el('div', { class: 'linha' }, el('span', { class: 'etiqueta ok' }, 'Online'), el('strong', {}, ofertas.length ? `${ofertas.length} corrida(s) perto` : 'Procurando corridas…')), offline),
    gpsManual ? el('p', { class: 'pequeno mudo' }, 'GPS manual: toque no mapa para atualizar sua posição.') : null,
    el('div', { class: 'coluna', style: 'margin-top:12px' }, ofertas.length ? ofertas.map((o) => cartaoOferta(o, painel))
      : el('p', { class: 'mudo' }, 'Fique por perto de pontos movimentados. As corridas aparecem aqui.')));
}

function cartaoOferta(o, painel) {
  const aceitar = el('button', { class: 'btn primario' }, 'Aceitar');
  aceitar.addEventListener('click', () => acao(aceitar, async () => { await api.post(`/motorista/ofertas/${o.id}/aceitar`); toast('Corrida aceita! Vá até o passageiro.'); await atualizar(painel); }));
  const recusar = el('button', { class: 'btn' }, 'Recusar');
  recusar.addEventListener('click', () => acao(recusar, async () => { await api.post(`/motorista/ofertas/${o.id}/recusar`); delete painel.dataset.chave; await atualizar(painel); }));
  return el('div', { class: 'cartao plano' },
    el('div', { class: 'linha entre' }, el('div', {}, el('div', { class: 'grande-valor num', style: 'font-size:24px' }, dinheiro(o.ganho_estimado_centavos)),
      el('div', { class: 'pequeno mudo' }, `para você · corrida ~${dinheiro(o.valor_estimado_centavos)} · ${FORMAS[o.forma_pagamento]}`)),
    el('div', { style: 'text-align:right' }, el('strong', {}, `${km(o.distancia_ate_origem_m)} até o passageiro`), el('div', { class: 'pequeno mudo' }, `~${minutos(o.chegada_s)}`))),
    el('div', { class: 'coluna pequeno', style: 'margin:10px 0' },
      el('div', { class: 'ponto' }, el('span', { class: 'bola origem', style: 'margin-top:4px' }), el('span', {}, o.origem_endereco)),
      el('div', { class: 'ponto' }, el('span', { class: 'bola destino', style: 'margin-top:4px' }), el('span', {}, `${o.destino_endereco} · ${km(o.distancia_estimada_m)}`))),
    el('div', { class: 'linha' }, o.categoria === 'executivo' ? el('span', { class: 'etiqueta info' }, 'Executivo') : null, o.bandeira === 2 ? el('span', { class: 'etiqueta aviso' }, 'Bandeira 2') : null),
    el('div', { class: 'linha', style: 'margin-top:10px' }, recusar, el('div', { style: 'flex:1' }), aceitar));
}

const navegar = (lat, lng) => el('a', { class: 'btn pequeno', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving&dir_action=navigate` }, 'Navegar');

function desenharCorrida(painel, c) {
  const alvo = ['aceita', 'chegou'].includes(c.status) ? { lat: c.origem_lat, lng: c.origem_lng } : { lat: c.destino_lat, lng: c.destino_lng };
  pontos.atualizar([{ chave: 'origem', lat: c.origem_lat, lng: c.origem_lng, icone: ICONES.origem() }, { chave: 'destino', lat: c.destino_lat, lng: c.destino_lng, icone: ICONES.destino() }]);
  const chave = `c:${c.id}:${c.status}:${c.nota_do_motorista}`;
  // Em viagem, só a distância muda: atualiza o texto sem redesenhar os botões.
  if (painel.dataset.chave === chave) {
    const d = painel.querySelector('[data-percorrido]');
    if (d) d.textContent = `Percorrido: ${km(c.distancia_percorrida_m)}`;
    return;
  }
  if (!painel.dataset.chave?.startsWith(`c:${c.id}:${c.status}`)) enquadrar(mapa, [[alvo.lat, alvo.lng], ...(posicao ? [[posicao.lat, posicao.lng]] : [])]);
  painel.dataset.chave = chave;
  const p = c.passageiro;
  const botao = (texto, classe, fn) => {
    const b = el('button', { class: `btn ${classe}` }, texto);
    b.addEventListener('click', () => acao(b, async () => { await fn(); await atualizar(painel); }));
    return b;
  };
  const passageiro = el('div', { class: 'motorista-cartao', style: 'margin:10px 0' }, el('div', { class: 'avatar' }, iniciais(p.nome)),
    el('div', { style: 'flex:1' }, el('strong', {}, p.nome), el('div', { class: 'pequeno mudo' }, p.nota_media ? `★ ${p.nota_media.toLocaleString('pt-BR')}` : 'Passageiro novo')),
    p.telefone ? el('a', { class: 'btn pequeno', href: `tel:${p.telefone}` }, 'Ligar') : null);
  const trajeto = el('div', { class: 'coluna pequeno' },
    el('div', { class: 'ponto' }, el('span', { class: 'bola origem', style: 'margin-top:4px' }), el('span', {}, c.origem_endereco)),
    el('div', { class: 'ponto' }, el('span', { class: 'bola destino', style: 'margin-top:4px' }), el('span', {}, c.destino_endereco)));
  const partes = [el('div', { class: 'alca' }), el('div', { class: 'linha entre' }, etiquetaStatus(c.status), el('span', { class: 'pequeno mudo' }, `#${c.id} · ${FORMAS[c.forma_pagamento]} (já pago)`))];
  // O passageiro já pagou (ou a empresa é faturada): o motorista só vê quanto recebe, sem a taxa da plataforma.
  const ganho = el('div', { class: 'cartao plano', style: 'margin:10px 0;text-align:center' }, el('div', { class: 'mudo pequeno' }, 'Você recebe (estimado)'),
    el('div', { class: 'grande-valor num', style: 'font-size:24px' }, dinheiro(c.ganho_estimado_centavos)));

  if (c.status === 'aceita' || c.status === 'chegou') {
    const desistir = el('button', { class: 'btn perigo' }, 'Desistir');
    desistir.addEventListener('click', async () => {
      const motivo = await perguntar('Desistir da corrida', 'Motivo');
      if (motivo === null) return;
      await acao(desistir, () => api.post(`/motorista/corridas/${c.id}/cancelar`, { motivo }));
      await atualizar(painel);
    });
    partes.push(passageiro, ganho, trajeto,
      el('div', { class: 'linha', style: 'margin-top:12px' }, navegar(c.origem_lat, c.origem_lng), desistir, el('div', { style: 'flex:1' }),
        c.status === 'aceita' ? botao('Cheguei', '', () => api.post(`/motorista/corridas/${c.id}/chegou`)) : null),
      el('div', { style: 'margin-top:10px' }, botao('Iniciar corrida', 'primario grande', () => api.post(`/motorista/corridas/${c.id}/iniciar`))));
  } else if (c.status === 'em_andamento') {
    partes.push(passageiro, ganho, trajeto, el('p', { class: 'mudo', 'data-percorrido': '' }, `Percorrido: ${km(c.distancia_percorrida_m)}`),
      el('div', { class: 'linha' }, navegar(c.destino_lat, c.destino_lng), el('span', { class: 'pequeno mudo' }, `Início ${hora(c.iniciada_em)}`)),
      el('div', { style: 'margin-top:10px' }, botao('Finalizar corrida', 'escuro grande', async () => {
        if (posicao) await api.post('/motorista/posicao', posicao).catch(() => {});
        const f = await api.post(`/motorista/corridas/${c.id}/finalizar`);
        toast(`Corrida finalizada: você recebe ${dinheiro(f.valor_motorista_centavos)}`);
      })));
  } else {
    partes.push(el('div', { style: 'text-align:center;margin:10px 0' }, el('div', { class: 'mudo' }, 'Você recebe'),
      el('div', { class: 'grande-valor num' }, dinheiro(c.valor_motorista_centavos)),
      el('div', { class: 'pequeno mudo' }, `Já descontada a taxa da plataforma · ${km(c.distancia_percorrida_m)} · ${minutos(c.duracao_real_s)}`)),
    el('div', { class: 'aviso ok' }, 'O valor já entrou no seu saldo. Peça o PIX para a sua conta em Ganhos (um por dia).'),
    el('p', { style: 'text-align:center;margin:14px 0 6px' }, `Como foi a corrida com ${p.nome.split(' ')[0]}?`),
    el('div', { class: 'linha', style: 'justify-content:center' }, [1, 2, 3, 4, 5].map((n) => botao(`${n}★`, 'pequeno', () => api.post(`/motorista/corridas/${c.id}/avaliar`, { nota: n })))),
    el('div', { style: 'text-align:center;margin-top:10px' }, el('button', { class: 'btn pequeno', onclick: () => { pulados.add(c.id); delete painel.dataset.chave; atualizar(painel); } }, 'Pular')));
  }
  limpar(painel, partes);
}

/** Saldo disponível e pedido de PIX para a conta do motorista (um por dia). */
function blocoPix(g, recarregar) {
  const { pix } = g;
  const caixa = el('div', { class: 'cartao plano' }, el('div', { class: 'mudo pequeno' }, 'Disponível para PIX'),
    el('div', { class: 'grande-valor num' }, dinheiro(g.saldo_centavos)));
  if (!perfil?.chave_pix) return limpar(caixa, caixa.firstChild, caixa.lastChild, el('div', { class: 'aviso' }, 'Cadastre sua chave PIX em Conta para pedir a transferência.'));
  if (pix.ja_pediu_hoje) caixa.append(el('div', { class: 'aviso' }, 'Você já pediu o PIX de hoje. Amanhã pode pedir de novo.'));
  else if (!pix.pode_pedir) caixa.append(el('p', { class: 'pequeno mudo' }, pix.minimo_centavos ? `Valor mínimo para pedir: ${dinheiro(pix.minimo_centavos)}.` : 'Sem saldo disponível no momento.'));
  else {
    const valor = el('input', { inputmode: 'decimal', value: (g.saldo_centavos / 100).toFixed(2).replace('.', ','), 'aria-label': 'Valor do PIX' });
    const pedir = el('button', { class: 'btn primario' }, 'Pedir PIX');
    pedir.addEventListener('click', () => acao(pedir, async () => {
      const centavos = Math.round(Number(valor.value.replace(/\./g, '').replace(',', '.')) * 100);
      if (!Number.isFinite(centavos) || centavos <= 0) throw new Error('Informe um valor válido.');
      if (!(await confirmar('Pedir PIX', `Pedir ${dinheiro(centavos)} para a chave ${perfil.chave_pix}? A gestão libera o PIX. Você pode pedir um por dia.`, 'Pedir'))) return;
      await api.post('/motorista/pix', { valor_centavos: centavos });
      toast('PIX pedido. Ele cai na sua conta assim que a gestão liberar.');
      await recarregar();
    }));
    caixa.append(el('p', { class: 'pequeno mudo', style: 'margin:8px 0' }, `Para a chave ${perfil.chave_pix} · um pedido por dia${pix.minimo_centavos ? ` · mínimo ${dinheiro(pix.minimo_centavos)}` : ''}`),
      el('div', { class: 'linha' }, el('div', { style: 'flex:1' }, valor), pedir));
  }
  return caixa;
}

async function ganhos() {
  let periodo = 0;
  const corpo = el('div', { class: 'coluna' });
  const carregar = async () => {
    const ate = hojeLocal();
    const g = await api.get(`/motorista/ganhos?de=${somarDias(ate, -periodo)}&ate=${ate}`);
    limpar(corpo,
      el('div', { class: 'pilulas' }, [[0, 'Hoje'], [6, '7 dias'], [29, '30 dias']].map(([d, r]) => el('button', { class: periodo === d ? 'on' : '', onclick: () => { periodo = d; carregar(); } }, r))),
      el('div', { class: 'cartao plano' },
        el('div', { class: 'mudo pequeno' }, 'Você recebe no período (já sem a taxa)'), el('div', { class: 'grande-valor num' }, dinheiro(g.liquido_centavos)),
        el('div', { class: 'chave' }, el('span', {}, 'Corridas'), el('strong', {}, g.total_corridas)),
        el('div', { class: 'chave' }, el('span', {}, 'Valor das corridas'), el('strong', { class: 'num' }, dinheiro(g.bruto_centavos))),
        el('div', { class: 'chave' }, el('span', {}, 'Taxa da plataforma'), el('strong', { class: 'num' }, `− ${dinheiro(g.taxa_centavos)}`)),
        el('div', { class: 'chave' }, el('span', {}, 'Rodado'), el('strong', {}, `${km(g.distancia_m)} · ${minutos(g.tempo_s)}`))),
      blocoPix(g, carregar),
      el('h3', { style: 'margin-top:6px' }, 'Extrato'),
      g.extrato.length ? g.extrato.map((l) => el('div', { class: 'chave pequeno' }, el('span', {}, l.descricao, el('br'), el('span', { class: 'mudo' }, dataHora(l.criado_em))),
        el('strong', { class: 'num', style: `color:var(--${l.valor_centavos < 0 ? 'erro' : 'ok'})` }, dinheiro(l.valor_centavos)))) : el('p', { class: 'mudo pequeno' }, 'Sem lançamentos.'),
      g.repasses.length ? [el('h3', { style: 'margin-top:6px' }, 'Meus pedidos de PIX'), g.repasses.map((r) => el('div', { class: 'chave pequeno' },
        el('span', {}, `#${r.id} · ${dataHora(r.criado_em)}`, el('br'), el('span', { class: 'mudo' }, r.status === 'pendente' ? `aguardando a liberação da gestão · ${r.chave_pix}` : r.status === 'cancelado' ? (r.motivo ?? 'recusado') : r.identificador)),
        el('span', { class: 'linha' }, el('strong', { class: 'num' }, dinheiro(r.valor_centavos)), el('span', { class: `etiqueta ${r.status === 'pago' ? 'ok' : r.status === 'cancelado' ? 'erro' : 'aviso'}` }, { pendente: 'aguardando', pago: 'liberado', cancelado: 'recusado' }[r.status]))))] : null);
  };
  await carregar().catch((err) => toast(err.message, true));
  modal('Meus ganhos', (fechar) => [corpo, el('button', { class: 'btn grande', style: 'margin-top:12px', onclick: () => fechar() }, 'Fechar')]);
}

async function conta() {
  const p = perfil ?? await api.get('/motorista/perfil');
  modal('Minha conta', (fechar) => {
    const pix = el('form', { class: 'form' }, el('label', { class: 'campo' }, 'Chave PIX para repasses', el('input', { name: 'chave_pix', value: p.chave_pix ?? '' })),
      el('button', { class: 'btn primario' }, 'Salvar chave PIX'));
    pix.addEventListener('submit', (e) => { e.preventDefault(); acao(pix.querySelector('button'), async () => { await api.patch('/motorista/perfil', lerForm(pix)); toast('Chave PIX salva.'); fechar(); }); });
    const novo = el('form', { class: 'form' },
      el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Placa', el('input', { name: 'placa', required: true })), el('label', { class: 'campo' }, 'Ano', el('input', { name: 'ano', type: 'number', required: true }))),
      el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Marca e modelo', el('input', { name: 'marca_modelo', required: true })), el('label', { class: 'campo' }, 'Cor', el('input', { name: 'cor', required: true }))),
      el('label', { class: 'campo' }, 'Categoria', el('select', { name: 'categoria' }, el('option', { value: 'comum' }, 'Táxi comum'), el('option', { value: 'executivo' }, 'Executivo'))),
      el('button', { class: 'btn' }, 'Cadastrar veículo'));
    novo.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(novo.querySelector('button'), async () => { const d = lerForm(novo); await api.post('/motorista/veiculos', { ...d, ano: Number(d.ano) }); toast('Veículo enviado para aprovação da central.'); fechar(); });
    });
    return [
      el('p', { class: 'mudo' }, `${p.nome} · ${p.email}`, el('br'), `CNH válida até ${p.cnh_validade.split('-').reverse().join('/')}`),
      pix,
      el('h3', { style: 'margin-top:16px' }, 'Veículos'),
      p.veiculos.map((v) => el('div', { class: 'chave' }, el('span', {}, el('span', { class: 'placa' }, v.placa), ` ${v.marca_modelo} · ${v.cor} · ${CATEGORIAS[v.categoria]}`),
        el('span', { class: `etiqueta ${v.situacao === 'aprovado' ? 'ok' : v.situacao === 'recusado' ? 'erro' : 'aviso'}` }, v.situacao))),
      el('h3', { style: 'margin-top:16px' }, 'Novo veículo'), novo,
      el('button', { class: 'btn grande', style: 'margin-top:12px', onclick: () => fechar() }, 'Fechar'),
    ];
  });
}

iniciar();
