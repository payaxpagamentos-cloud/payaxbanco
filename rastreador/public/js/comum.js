/** Peças usadas tanto no painel do master quanto no das empresas. */
import { api, BASE } from './api.js';
import { el, limpar, dataHora, desde, km, kmh, placa, telefone, toast, acao, campo, escolha, modal, formModal, confirmar, icone, repetir, etiquetaSituacao,
  SITUACOES, TIPOS_VEICULO } from './ui.js';
import { criarMapa, linkGoogle } from './mapa.js';

export const cartao = (titulo, ...conteudo) => el('section', { class: 'cartao' }, titulo ? el('h2', {}, titulo) : null, conteudo);
export const indicador = (rotulo, valor, nota, classe = '') => el('div', { class: `cartao indicador ${classe}` }, el('div', { class: 'rotulo' }, rotulo),
  el('div', { class: 'valor num' }, valor), nota ? el('div', { class: 'nota' }, nota) : null);
export const td = (conteudo, classe = '') => el('td', { class: classe }, conteudo);
export const tabela = (colunas, linhas, vazio = 'Nada por aqui.') => (linhas.length
  ? el('div', { class: 'rolagem' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.startsWith('>') ? 'dir' : c.startsWith('^') ? 'centro' : '' }, c.replace(/^[>^]/, ''))))),
    el('tbody', {}, linhas)))
  : el('p', { class: 'mudo', style: 'margin:0' }, vazio));
export const botao = (texto, classe, fn) => {
  const b = el('button', { class: `btn pequeno ${classe}`, type: 'button' }, texto);
  b.addEventListener('click', (e) => { e.stopPropagation(); acao(b, fn); });
  return b;
};
export const botaoIcone = (nome, titulo, fn, classe = '') => {
  const b = el('button', { class: `icone-btn ${classe}`, type: 'button', title: titulo, 'aria-label': titulo }, icone(nome));
  b.addEventListener('click', (e) => { e.stopPropagation(); acao(b, fn); });
  return b;
};
export const acoesTopo = (...itens) => el('div', { class: 'linha entre', style: 'margin-bottom:16px' }, ...itens);
export const linhaDado = (r, v) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, r), el('strong', { style: 'text-align:right' }, v ?? '—'));
export const situacaoDiag = { ok: ['ok', 'OK'], aviso: ['aviso', 'Atenção'], erro: ['erro', 'Problema'] };

/** Campo de data que chama fn(valor) ao mudar. */
export function campoData(rotulo, valor, fn, attrs = {}) {
  const i = el('input', { type: 'date', value: valor, ...attrs });
  i.addEventListener('change', () => fn(i.value));
  return el('label', { class: 'campo' }, rotulo, i);
}

/**
 * Mapa ao vivo: lista de veículos com busca e filtro de situação ao lado do mapa, atualizando sozinho.
 * `caminho`: '/empresas/ID/mapa' ou '/master/mapa'. `detalhe(v, fechar)` monta o painel do veículo escolhido (só no painel da empresa).
 */
export async function painelMapa(ctx, caminho, { detalhe, mostrarEmpresa = false } = {}) {
  ctx.telaCheia();
  const divMapa = el('div', { class: 'mapa' });
  const lista = el('div', { class: 'lista-veiculos' });
  const painel = el('div', { class: 'painel-veiculo oculto' });
  const contagem = el('div', { class: 'contagem' });
  const estado = { busca: '', situacao: '', selecionado: null, enquadrado: false };
  const busca = el('input', { type: 'search', placeholder: 'Placa, descrição ou motorista', 'aria-label': 'Buscar veículo' });
  busca.addEventListener('input', () => { estado.busca = busca.value.trim().toLowerCase(); desenharLista(); });
  limpar(ctx.conteudo, el('div', { class: 'tela-mapa' },
    el('aside', { class: 'lado' }, busca, contagem, lista),
    el('div', { class: 'area-mapa' }, divMapa, painel)));
  const mapa = await criarMapa(divMapa);
  const marcadores = new Map();
  const camadasCercas = [];
  let veiculos = [];
  let ultimoDetalhe = null;

  const visivel = (v) => (!estado.situacao || v.situacao === estado.situacao)
    && (!estado.busca || [v.placa, placa(v.placa), v.descricao, v.motorista, v.empresa].some((x) => String(x ?? '').toLowerCase().includes(estado.busca)));

  function desenharLista() {
    const cont = {};
    for (const v of veiculos) cont[v.situacao] = (cont[v.situacao] ?? 0) + 1;
    limpar(contagem, el('button', { class: `filtro-sit${estado.situacao ? '' : ' on'}`, onclick: () => { estado.situacao = ''; desenharLista(); } }, `Todos ${veiculos.length}`),
      Object.entries(cont).map(([s, n]) => el('button', { class: `filtro-sit${estado.situacao === s ? ' on' : ''}`, onclick: () => { estado.situacao = estado.situacao === s ? '' : s; desenharLista(); } },
        el('i', { class: `bolinha s-${s}` }), `${SITUACOES[s]?.[0] ?? s} ${n}`)));
    const vis = veiculos.filter(visivel);
    limpar(lista, vis.length ? vis.map((v) => el('button', { class: `item-veiculo${estado.selecionado === v.id ? ' on' : ''}`, onclick: () => escolher(v, true) },
      el('div', { class: 'linha entre' }, el('strong', {}, placa(v.placa)), etiquetaSituacao(v.situacao)),
      el('div', { class: 'pequeno mudo' }, [v.descricao, mostrarEmpresa ? v.empresa : v.motorista].filter(Boolean).join(' · ') || TIPOS_VEICULO[v.tipo]),
      el('div', { class: 'pequeno fraco linha entre' }, el('span', {}, v.posicao_em ? `${kmh(v.velocidade_kmh)} · ${v.ignicao === 1 ? 'ligado' : v.ignicao === 0 ? 'desligado' : 'ignição ?'}` : 'sem posição'),
        el('span', {}, desde(v.comunicacao_em))),
      v.alertas_pendentes || v.bloqueado ? el('div', { class: 'linha', style: 'gap:6px;margin-top:4px' },
        v.bloqueado ? el('span', { class: 'etiqueta erro' }, 'bloqueado') : null,
        v.alertas_pendentes ? el('span', { class: 'etiqueta aviso' }, `${v.alertas_pendentes} alerta(s)`) : null) : null))
      : el('p', { class: 'mudo pequeno', style: 'padding:8px' }, veiculos.length ? 'Nenhum veículo com esse filtro.' : 'Nenhum veículo cadastrado.'));
    for (const [id, mk] of marcadores) mk.selecionar(id === estado.selecionado);
  }

  function escolher(v, centralizar) {
    estado.selecionado = v.id;
    desenharLista();
    if (centralizar && mapa && v.lat !== null) mapa.ir(v.lat, v.lng);
    if (!detalhe) {
      limpar(painel, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, placa(v.placa)), botaoIcone('seta', 'Fechar', () => fecharPainel())),
        el('div', { class: 'pequeno mudo' }, v.empresa), etiquetaSituacao(v.situacao), resumoVeiculo(v),
        mostrarEmpresa ? el('a', { class: 'btn pequeno', href: `#/empresa/${v.empresa_id}/mapa`, style: 'margin-top:10px' }, 'Abrir no painel da empresa') : null);
      painel.classList.remove('oculto');
      return;
    }
    ultimoDetalhe = v.id;
    painel.classList.remove('oculto');
    detalhe(v, painel, fecharPainel);
  }
  function fecharPainel() {
    estado.selecionado = null;
    ultimoDetalhe = null;
    painel.classList.add('oculto');
    desenharLista();
  }

  async function carregar() {
    const r = await api.get(caminho);
    veiculos = r.veiculos;
    if (mapa && r.cercas && !camadasCercas.length) for (const c of r.cercas) camadasCercas.push(mapa.cerca(c));
    if (mapa) {
      const vistos = new Set();
      for (const v of veiculos.filter((x) => x.lat !== null)) {
        vistos.add(v.id);
        const mk = marcadores.get(v.id);
        if (mk) mk.atualizar(v);
        else marcadores.set(v.id, mapa.veiculo(v, { aoClicar: (x) => escolher(x, false) }));
      }
      for (const [id, mk] of marcadores) if (!vistos.has(id)) { mk.remover(); marcadores.delete(id); }
      if (!estado.enquadrado && vistos.size) {
        mapa.enquadrar(veiculos.filter((x) => x.lat !== null).map((x) => [x.lat, x.lng]), 15);
        estado.enquadrado = true;
      }
    }
    desenharLista();
    // O painel aberto acompanha a atualização (velocidade, situação, comandos).
    const sel = veiculos.find((x) => x.id === ultimoDetalhe);
    if (sel && detalhe) detalhe(sel, painel, fecharPainel, { atualizacao: true });
  }
  ctx.parar(repetir(carregar, 10_000));
}

/** Dados de leitura do veículo (posição, velocidade, ignição, comunicação, hodômetro). */
export function resumoVeiculo(v) {
  return el('div', { class: 'coluna', style: 'gap:0;margin-top:10px' },
    linhaDado('Velocidade', v.posicao_em ? kmh(v.velocidade_kmh) : null),
    linhaDado('Ignição', v.ignicao === 1 ? 'ligada' : v.ignicao === 0 ? 'desligada' : 'não informada'),
    linhaDado('Última posição', v.posicao_em ? `${dataHora(v.posicao_em)} (${desde(v.posicao_em)})` : null),
    linhaDado('Última comunicação', v.comunicacao_em ? desde(v.comunicacao_em) : 'nunca'),
    v.motorista ? linhaDado('Motorista', v.motorista_telefone ? `${v.motorista} · ${telefone(v.motorista_telefone)}` : v.motorista) : null,
    linhaDado('Hodômetro', km(v.hodometro_m)),
    v.tensao !== null && v.tensao !== undefined ? linhaDado('Bateria', `${Number(v.tensao).toFixed(1)} V`) : null,
    v.lat !== null ? linhaDado('Coordenadas', el('a', { href: linkGoogle(v.lat, v.lng), target: '_blank', rel: 'noopener' }, `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`)) : null);
}

// ---------- Integrações ----------
/** Chaves da API e o guia de como ligar os rastreadores (GT06, celular) e outros sistemas. */
export function painelIntegracoes(alvo, { listar, criar, revogar, empresas = null, podeCriar = true, portaGt06 = 5023 }) {
  const lista = el('div');
  const carregar = async () => {
    const chaves = await listar();
    limpar(lista, tabela([empresas ? 'Empresa' : null, 'Nome', 'Chave', 'Criada', 'Último uso', 'Situação', '^Ações'].filter(Boolean), chaves.map((k) => el('tr', {},
      empresas ? td(k.empresa) : null, td(k.nome), td(el('span', { class: 'mono' }, `rst_${k.prefixo}_…`)), td(dataHora(k.criada_em)), td(dataHora(k.ultimo_uso)),
      td(k.revogada_em ? el('span', { class: 'etiqueta erro' }, 'revogada') : el('span', { class: 'etiqueta ok' }, 'ativa')),
      el('td', { class: 'acoes' }, !k.revogada_em && podeCriar ? botao('Revogar', 'perigo', async () => {
        if (!await confirmar('Revogar chave', `O sistema que usa "${k.nome}" perde o acesso na hora. Continuar?`, 'Revogar')) return;
        await revogar(k.id);
        toast('Chave revogada.');
        carregar();
      }) : null))), 'Nenhuma chave criada.'));
  };
  const nova = podeCriar ? el('button', { class: 'btn primario', onclick: async () => {
    const r = await formModal('Nova chave de API', () => [
      empresas ? escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), empresas[0]?.id, { required: true }) : null,
      campo('Nome (onde será usada)', { name: 'nome', required: true, maxlength: 80, placeholder: 'Ex.: ERP da transportadora' }),
    ], (d) => criar(d));
    if (!r || r === true) return;
    carregar();
    modal('Chave criada', (fechar) => [
      el('p', { class: 'mudo' }, 'Copie agora: por segurança, a chave completa não aparece de novo.'),
      el('div', { class: 'segredo' }, r.chave),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(r.chave).then(() => toast('Copiada.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
    ]);
  } }, 'Nova chave') : null;

  const base = `${location.origin}${BASE}/api`;
  const doc = cartao('Como ligar os rastreadores',
    el('h3', {}, '1. Rastreador GT06 (e compatíveis: GT06N, J16, ST-901, Concox…)'),
    el('p', { class: 'mudo' }, 'Configure o equipamento por SMS (o comando exato varia por fabricante; a senha padrão costuma ser 123456 ou 666666) e cadastre o IMEI em Rastreadores.'),
    el('pre', { class: 'codigo' }, [
      `SERVER,1,${location.hostname},${portaGt06},0#      (ou: adminip123456 ${location.hostname} ${portaGt06})`,
      'APN,zap.vivo.com.br#                  (APN da operadora do chip)',
      'TIMER,30#                             (envia a posição a cada 30 s andando)',
    ].join('\n')),
    el('h3', {}, '2. Celular como rastreador (app Traccar Client, Android e iPhone)'),
    el('pre', { class: 'codigo' }, [`Endereço do servidor: ${base}/osmand`, 'Identificador do dispositivo: o mesmo cadastrado no rastreador (ex.: app-1234567890)',
      'Frequência: 30 s · Precisão: alta'].join('\n')),
    el('h3', {}, '3. Outros sistemas (chave da empresa no cabeçalho X-Api-Key)'),
    el('pre', { class: 'codigo' }, [
      `GET  ${base}/integracao/veiculos                      frota com a última posição`,
      `GET  ${base}/integracao/veiculos/ABC1D23/posicoes?de=2026-10-24T00:00:00Z&ate=2026-10-24T23:59:59Z`,
      `GET  ${base}/integracao/alertas?desde=2026-10-24T00:00:00Z`,
      `POST ${base}/integracao/posicoes                      [{ "imei": "...", "lat": -23.55, "lng": -46.63, "velocidade_kmh": 42, "ignicao": true, "gps_em": "2026-10-24T12:00:00Z" }]`,
      `GET  ${base}/integracao/comandos                      comandos dos rastreadores do tipo "API" a entregar`,
      `POST ${base}/integracao/comandos/15                   { "sucesso": true, "resposta": "OK" }`,
    ].join('\n')));
  limpar(alvo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Chaves que outros sistemas usam para consultar a frota e enviar posições.'), nova), cartao(null, lista),
    el('div', { style: 'height:18px' }), doc);
  return carregar().catch((err) => toast(err.message, true));
}
