/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/** Segurança da empresa: Modo Roubo (bloqueio inteligente e kit de ocorrência), Estacionados, Bloqueio programado e Liberações. */
import { api, baixar, BASE } from './api.js';
import { el, limpar, dataHora, hora, desde, kmh, placa, inteiro, toast, acao, campo, escolha, marcar, formModal, modal, confirmar, perguntar, repetir,
  etiqueta, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';
import { enderecoDe, linkGoogle } from './mapa.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const pode = (ctx) => !ctx.somenteLeitura;
const link = (ctx, tela) => `#/empresa/${ctx.empresaId}/${tela}`;

export const STATUS_ROUBO = {
  aguardando: ['Aguardando velocidade segura', 'aviso'], bloqueio_enviado: ['Corte enviado, aguardando o aparelho', 'info'],
  bloqueado: ['Veículo bloqueado', 'erro'], encerrada: ['Encerrada', ''],
};
const STATUS_LIBERACAO = {
  aguardando: ['Código aguardando o gestor', 'aviso'], ativa: ['Liberado', 'ok'], expirada: ['Código expirou', ''], encerrada: ['Encerrada', ''], cancelada: ['Cancelada', ''],
};
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const diasTexto = (d) => {
  const s = String(d ?? '');
  if (s === '12345') return 'Segunda a sexta';
  if (s === '0123456') return 'Todos os dias';
  if (s === '06') return 'Fim de semana';
  return [...s].map((x) => DIAS[Number(x)]).join(', ');
};
const comRastreador = (veiculos) => veiculos.filter((x) => x.ativo && x.imei && x.protocolo !== 'api');

// ---------- Ações usadas também no mapa, nos veículos e nos alertas ----------

/** Aciona o Modo Roubo: digita a placa para confirmar; o corte espera a velocidade segura. */
export async function acionarRoubo(ctx, v, { velocidadeSegura = 20, depois } = {}) {
  const r = await formModal(`Modo Roubo · ${placa(v.placa)}`, () => [
    el('div', { class: 'aviso-roubo' }, icone('sos'), el('div', {},
      el('strong', {}, 'Bloqueio inteligente'),
      el('p', {}, `O corte só sai com o veículo abaixo de ${velocidadeSegura} km/h ou com a ignição desligada, para não causar acidente. `
        + 'Enquanto isso, o rastreador passa a mandar a posição a cada 10 segundos e cada passo vai para o WhatsApp dos contatos de segurança.'))),
    v.velocidade_kmh >= velocidadeSegura ? el('p', { class: 'aviso erro pequeno', style: 'margin:0' }, `Agora o veículo está a ${kmh(v.velocidade_kmh)}: o corte vai esperar.`) : null,
    campo('Digite a placa para confirmar', { name: 'confirmacao', required: true, maxlength: 8, placeholder: placa(v.placa), style: 'text-transform:uppercase', autocomplete: 'off' }),
    campo('Observação (opcional): o que aconteceu, boletim de ocorrência…', { name: 'observacao', maxlength: 500 }),
  ], (d) => api.post(`${base(ctx)}/veiculos/${v.id}/roubo`, d), { rotulo: 'Acionar Modo Roubo' });
  if (!r) return;
  toast(r.status === 'aguardando' ? 'Modo Roubo acionado. O corte sai quando a velocidade baixar.' : 'Modo Roubo acionado. Corte enviado ao rastreador.');
  if (depois) depois(); else ctx.ir('roubo', ctx.empresaId);
}

/** Modo Estacionado: guarda o ponto e vigia (ignição ligada ou saída do raio disparam o alerta). */
export async function estacionar(ctx, v, depois) {
  const r = await formModal(`Estacionar ${placa(v.placa)}`, () => [
    el('p', { class: 'mudo', style: 'margin:0' }, 'O sistema guarda o ponto onde o veículo está e avisa (painel e WhatsApp) se a ignição ligar ou se ele sair do raio. '
      + 'O próprio rastreador também passa a vigiar o deslocamento, mesmo dormindo.'),
    escolha('Raio de vigilância', 'raio_m', { '': 'Padrão da plataforma', 50: '50 m', 100: '100 m', 200: '200 m', 500: '500 m' }, ''),
  ], (d) => api.post(`${base(ctx)}/veiculos/${v.id}/estacionar`, { raio_m: d.raio_m ? Number(d.raio_m) : undefined }), { rotulo: 'Estacionar e vigiar' });
  if (!r) return;
  toast(`${placa(v.placa)} estacionado: vigiando.`);
  depois?.();
}

export async function desarmar(ctx, v, depois) {
  if (!await confirmar(`Desarmar ${placa(v.placa)}`, 'O veículo deixa de ser vigiado e pode sair normalmente.', 'Desarmar')) return;
  await api.post(`${base(ctx)}/veiculos/${v.id}/desarmar`, {});
  toast('Estacionado desarmado.');
  depois?.();
}

/** Escolher o veículo e acionar o Modo Roubo (botão do topo da tela Roubo). */
async function escolherEAcionar(ctx, velocidadeSegura, depois) {
  const veiculos = comRastreador(await api.get(`${base(ctx)}/veiculos`));
  if (!veiculos.length) return toast('Nenhum veículo com rastreador instalado.', true);
  const id = await modal('Acionar Modo Roubo', (fechar) => {
    const s = escolha('Veículo', 'veiculo', Object.fromEntries(veiculos.map((x) => [x.id, `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`])), veiculos[0].id);
    return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(Number(s.querySelector('select').value)); } }, s,
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Voltar'), el('button', { class: 'btn perigo' }, 'Continuar')));
  });
  if (!id) return;
  const { veiculos: mapa } = await api.get(`${base(ctx)}/mapa`);
  const v = mapa.find((x) => x.id === id) ?? veiculos.find((x) => x.id === id);
  await acionarRoubo(ctx, v, { velocidadeSegura, depois });
}

// ---------- Kit de ocorrência ----------
async function linkPolicia(ctx, oc) {
  const r = await formModal(`Link ao vivo · ${placa(oc.placa)}`, () => [
    el('p', { class: 'mudo', style: 'margin:0' }, 'Quem tiver o link acompanha o veículo no mapa ao vivo, sem login e sem o histórico. Ideal para passar à polícia ou ao seguro.'),
    escolha('Validade', 'horas', { 24: '24 horas', 72: '3 dias', 168: '7 dias' }, 24),
  ], (d) => api.post(`${base(ctx)}/veiculos/${oc.veiculo_id}/compartilhar`, { horas: Number(d.horas) }), { rotulo: 'Gerar link' });
  if (!r || r === true) return;
  const url = `${location.origin}${BASE}/compartilhar/#${r.codigo}`;
  const texto = `Veículo ${placa(oc.placa)}${oc.descricao ? ` (${oc.descricao})` : ''} roubado. Localização ao vivo: ${url}`;
  modal('Link para a polícia', (fechar) => [
    el('p', { class: 'mudo' }, `Vale até ${dataHora(r.expira_em)}.`),
    el('div', { class: 'segredo' }, url),
    el('div', { class: 'linha entre', style: 'margin-top:14px' },
      el('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(texto)}`, target: '_blank', rel: 'noopener' }, 'Enviar por WhatsApp'),
      el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Copiado.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
      el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
  ]);
}

async function pdfWhatsapp(ctx, oc) {
  const n = await api.get(`${base(ctx)}/notificacoes`);
  if (!n.whatsapp) return toast('O WhatsApp ainda não foi ligado no servidor. Fale com o suporte.', true);
  const ativos = n.contatos.filter((c) => c.ativo);
  if (!ativos.length) return toast('Cadastre um contato em Configurações → Notificações.', true);
  const r = await formModal('Enviar o relatório pelo WhatsApp', () => [
    escolha('Para', 'contato_id', Object.fromEntries(ativos.map((c) => [c.id, `${c.nome} · ${c.numero}`])), ativos[0].id),
  ], (d) => api.post(`${base(ctx)}/roubo/${oc.id}/relatorio/whatsapp`, { contato_id: Number(d.contato_id) }), { rotulo: 'Enviar PDF' });
  if (r) toast('Relatório na fila do WhatsApp.');
}

async function forcar(ctx, oc, depois) {
  const conf = await perguntar(`Forçar o corte de ${placa(oc.placa)}`, `ATENÇÃO: o veículo está a ${kmh(oc.velocidade_kmh)}. Cortar em movimento pode causar acidente. `
    + 'Use só em emergência. Digite a placa para confirmar:');
  if (!conf) return;
  await api.post(`${base(ctx)}/roubo/${oc.id}/forcar`, { confirmacao: conf });
  toast('Corte enviado.');
  depois();
}

async function encerrar(ctx, oc, depois) {
  const r = await modal(`Encerrar a ocorrência · ${placa(oc.placa)}`, (fechar) => {
    const desb = el('input', { type: 'checkbox', checked: oc.bloqueado ? true : null });
    return [
      el('p', { class: 'mudo' }, 'O rastreador volta ao intervalo de envio de antes. O relatório e a linha do tempo continuam guardados.'),
      el('label', { class: 'marcar' }, desb, 'Desbloquear o veículo (recuperado)'),
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => fechar() }, 'Voltar'),
        el('button', { class: 'btn primario', onclick: () => fechar({ desbloquear: desb.checked }) }, 'Encerrar')),
    ];
  });
  if (!r) return;
  await api.post(`${base(ctx)}/roubo/${oc.id}/encerrar`, r);
  toast(r.desbloquear ? 'Ocorrência encerrada. Desbloqueio enviado.' : 'Ocorrência encerrada.');
  depois();
}

function cartaoOcorrencia(ctx, oc, recarregar) {
  const [rotulo, tom] = STATUS_ROUBO[oc.status] ?? [oc.status, ''];
  const endereco = el('span', {}, oc.lat !== null ? 'buscando endereço…' : 'sem posição');
  if (oc.lat !== null) enderecoDe(oc.lat, oc.lng).then((e) => { endereco.textContent = e?.completo || `${oc.lat.toFixed(5)}, ${oc.lng.toFixed(5)}`; });
  return el('article', { class: `ocorrencia status-${oc.status}` },
    el('header', { class: 'ocorrencia-topo' },
      el('div', {}, el('h2', {}, placa(oc.placa), oc.descricao ? el('span', { class: 'mudo' }, ` · ${oc.descricao}`) : null),
        el('div', { class: 'pequeno mudo' }, `Acionado ${dataHora(oc.criada_em)}${oc.criada_por_nome ? ` por ${oc.criada_por_nome}` : ''}`)),
      etiqueta(rotulo, tom)),
    el('div', { class: 'ocorrencia-agora' },
      el('div', { class: 'velocimetro' }, el('strong', {}, Math.round(oc.velocidade_kmh ?? 0)), el('span', {}, 'km/h')),
      el('div', {}, el('div', {}, endereco), el('div', { class: 'pequeno mudo' },
        `Posição ${desde(oc.posicao_em)} · ignição ${oc.ignicao === 1 ? 'ligada' : oc.ignicao === 0 ? 'desligada' : '—'}${oc.perseguicao ? ' · posição a cada 10 s' : ''}`),
      oc.lat !== null ? el('a', { class: 'pequeno', href: linkGoogle(oc.lat, oc.lng), target: '_blank', rel: 'noopener' }, 'Abrir no Google Maps') : null)),
    oc.observacao ? el('p', { class: 'pequeno', style: 'margin:0' }, oc.observacao) : null,
    el('ol', { class: 'linha-tempo' }, oc.eventos.map((e) => el('li', {}, el('time', {}, hora(e.em)), el('span', {}, e.texto)))),
    el('div', { class: 'acoes-ocorrencia' },
      pode(ctx) ? botao([icone('compartilhar'), 'Link para a polícia'], '', () => linkPolicia(ctx, oc)) : null,
      botao([icone('baixar'), 'Relatório PDF'], '', () => baixar(`${base(ctx)}/roubo/${oc.id}/relatorio.pdf`, `ocorrencia-${oc.placa}.pdf`)),
      pode(ctx) ? botao('PDF pelo WhatsApp', '', () => pdfWhatsapp(ctx, oc)) : null,
      el('a', { class: 'btn pequeno', href: link(ctx, 'mapa') }, icone('mapa'), 'Ver no mapa'),
      pode(ctx) && oc.status === 'aguardando' ? botao('Forçar corte agora', 'perigo', () => forcar(ctx, oc, recarregar)) : null,
      pode(ctx) ? botao('Encerrar', 'primario', () => encerrar(ctx, oc, recarregar)) : null));
}

/** Números do topo das telas de Segurança. */
function contagens(ctx, s, ocorrencias) {
  const armados = s.estacionados.filter((e) => !e.desarmado_em);
  return el('div', { class: 'grade' },
    indicador('Em roubo agora', inteiro(ocorrencias), ocorrencias ? 'acompanhe abaixo' : 'nenhuma ocorrência aberta', ocorrencias ? 'erro' : '', 'seguranca'),
    indicador('Estacionados', inteiro(armados.length), armados.some((e) => e.violado_em) ? 'há violação!' : 'vigiando', armados.some((e) => e.violado_em) ? 'erro' : '', 'alvo'),
    indicador('Bloqueio programado', inteiro(s.agendas.filter((a) => a.ativo).length), `${inteiro(s.agendas.filter((a) => a.em_horario && a.ativo).length)} no horário agora`, '', 'cadeado'),
    indicador('Liberações ativas', inteiro(s.liberacoes.filter((l) => l.status === 'ativa').length), 'pelo código do motorista', '', 'aberto'));
}

// ---------- Roubo ----------
async function telaRoubo(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  let velocidadeSegura = 20;
  const acionar = pode(ctx) ? el('button', { class: 'btn perigo roubo', onclick: () => escolherEAcionar(ctx, velocidadeSegura, () => carregar()) }, icone('sos'), 'Acionar Modo Roubo') : null;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'Com o Modo Roubo, o corte de combustível espera o veículo ficar abaixo da velocidade segura. Cada passo fica na linha do tempo e vai para o WhatsApp.'), acionar), corpo);
  async function carregar() {
    const [r, s] = await Promise.all([api.get(`${base(ctx)}/roubo`), api.get(`${base(ctx)}/seguranca`)]);
    velocidadeSegura = r.velocidade_segura_kmh;
    const abertas = r.ocorrencias.filter((o) => o.status !== 'encerrada');
    const encerradas = r.ocorrencias.filter((o) => o.status === 'encerrada');
    limpar(corpo,
      contagens(ctx, s, abertas.length),
      abertas.length ? el('div', { class: 'ocorrencias' }, abertas.map((o) => cartaoOcorrencia(ctx, o, carregar)))
        : cartao(null, el('div', { class: 'vazio-seguranca' }, icone('sos'), el('strong', {}, 'Nenhum veículo em Modo Roubo.'),
          el('span', { class: 'mudo' }, `Em caso de roubo, acione aqui, no mapa ou na lista de veículos. O corte espera o veículo ficar abaixo de ${velocidadeSegura} km/h.`))),
      cartao('Ocorrências encerradas (90 dias)', tabela(['Veículo', 'Acionada', 'Encerrada', 'Por', '^Relatório'], encerradas.map((o) => el('tr', {},
        td([el('strong', {}, placa(o.placa)), o.descricao ? el('div', { class: 'pequeno mudo' }, o.descricao) : null]), td(dataHora(o.criada_em)), td(dataHora(o.encerrada_em)),
        td(o.encerrada_por_nome ?? '—'),
        el('td', { class: 'acoes' }, botaoIcone('baixar', 'Relatório PDF', () => baixar(`${base(ctx)}/roubo/${o.id}/relatorio.pdf`, `ocorrencia-${o.placa}.pdf`))))),
      'Nenhuma ocorrência encerrada.')));
  }
  ctx.parar(repetir(carregar, 10_000));
}

// ---------- Estacionados ----------
async function telaEstacionados(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  const novo = pode(ctx) ? el('button', { class: 'btn primario', onclick: async () => {
    const [veiculos, { veiculos: mapa }, s] = await Promise.all([api.get(`${base(ctx)}/veiculos`), api.get(`${base(ctx)}/mapa`), api.get(`${base(ctx)}/seguranca`)]);
    const armados = new Set(s.estacionados.filter((e) => !e.desarmado_em).map((e) => e.veiculo_id));
    const livres = comRastreador(veiculos).filter((x) => !armados.has(x.id));
    if (!livres.length) return toast('Todos os veículos com rastreador já estão estacionados.', true);
    const id = await modal('Estacionar veículo', (fechar) => {
      const sel = escolha('Veículo', 'veiculo', Object.fromEntries(livres.map((x) => [x.id, `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`])), livres[0].id);
      return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(Number(sel.querySelector('select').value)); } }, sel,
        el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Voltar'), el('button', { class: 'btn primario' }, 'Continuar')));
    });
    if (id) await estacionar(ctx, mapa.find((x) => x.id === id), carregar);
  } }, icone('alvo'), 'Estacionar veículo') : null;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'Veículo estacionado fica vigiado: ignição ligada ou saída do raio viram alerta no painel e no WhatsApp, com o atalho para o Modo Roubo.'), novo), corpo);
  async function carregar() {
    const s = await api.get(`${base(ctx)}/seguranca`);
    const armados = s.estacionados.filter((e) => !e.desarmado_em);
    const antigos = s.estacionados.filter((e) => e.desarmado_em);
    limpar(corpo,
      cartao('Vigiando agora', tabela(['Veículo', 'Ponto', '>Raio', 'Desde', 'Situação', '^Ações'], armados.map((e) => el('tr', {},
        td([el('strong', {}, placa(e.placa)), e.descricao ? el('div', { class: 'pequeno mudo' }, e.descricao) : null]),
        td(el('a', { href: linkGoogle(e.lat, e.lng), target: '_blank', rel: 'noopener' }, 'ver no mapa')), td(`${inteiro(e.raio_m)} m`, 'dir num'),
        td([dataHora(e.armado_em), el('div', { class: 'pequeno mudo' }, e.automatico ? 'automático (noite)' : e.armado_por_nome ?? '')]),
        td(e.violado_em ? [etiqueta('violado', 'erro'), el('div', { class: 'pequeno mudo' }, `${e.motivo_violacao ?? ''} · ${dataHora(e.violado_em)}`)] : etiqueta('vigiando', 'ok')),
        el('td', { class: 'acoes' },
          pode(ctx) && e.violado_em ? botao([icone('sos'), 'Modo Roubo'], 'perigo roubo', async () => {
            const v = (await api.get(`${base(ctx)}/mapa`)).veiculos.find((x) => x.id === e.veiculo_id);
            if (v) acionarRoubo(ctx, v, { velocidadeSegura: s.velocidade_segura_kmh });
          }) : null,
          pode(ctx) ? botao('Desarmar', '', () => desarmar(ctx, { id: e.veiculo_id, placa: e.placa }, carregar)) : null))),
      'Nenhum veículo estacionado agora.')),
      cartao('Últimos 7 dias', tabela(['Veículo', 'Armado', 'Desarmado', 'Ocorrência'], antigos.map((e) => el('tr', {},
        td(el('strong', {}, placa(e.placa))), td(dataHora(e.armado_em)), td(dataHora(e.desarmado_em)),
        td(e.violado_em ? etiqueta(`violado ${hora(e.violado_em)}`, 'erro') : etiqueta('sem ocorrência', 'ok')))), 'Nada nos últimos 7 dias.'),
      el('p', { class: 'pequeno mudo', style: 'margin:12px 0 0' }, 'Para estacionar sozinho à noite (22h às 6h) ao desligar a ignição, marque "Estacionar automático à noite" no cadastro do veículo.')));
  }
  ctx.parar(repetir(carregar, 20_000));
}

// ---------- Bloqueio programado ----------
async function telaBloqueioProgramado(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  let veiculos = [];
  const form = async (a) => {
    const opcoes = comRastreador(veiculos);
    if (!a && !opcoes.length) return toast(veiculos.length ? 'Nenhum veículo com rastreador instalado.' : 'Aguarde o carregamento dos veículos.', true);
    const dias = String(a?.dias ?? '12345');
    const r = await formModal(a ? `Bloqueio programado · ${placa(a.placa)}` : 'Novo bloqueio programado', () => [
      a ? el('input', { type: 'hidden', name: 'veiculo', value: a.veiculo_id })
        : escolha('Veículo', 'veiculo', Object.fromEntries(opcoes.map((x) => [x.id, `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`])), opcoes[0]?.id),
      el('fieldset', { class: 'dias-semana' }, el('legend', {}, 'Dias'), DIAS.map((d, i) => el('label', { class: 'dia' },
        el('input', { type: 'checkbox', name: `dia${i}`, checked: dias.includes(String(i)) || null }), el('span', {}, d)))),
      el('div', { class: 'duas' }, campo('Bloqueia às', { name: 'inicio', type: 'time', required: true, value: a?.inicio ?? '23:00' }),
        campo('Libera às', { name: 'fim', type: 'time', required: true, value: a?.fim ?? '06:00' })),
      marcar('Ligado', { name: 'ativo', checked: a ? Boolean(a.ativo) : true }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'No início do horário o corte sai pelo bloqueio inteligente (só abaixo da velocidade segura). No fim, o veículo é desbloqueado sozinho. '
        + 'Fora disso, o motorista pede a liberação pelo app e você aplica o código em Liberações.'),
    ], (d) => {
      const escolhidos = DIAS.map((_, i) => (d[`dia${i}`] ? String(i) : '')).join('');
      return api.put(`${base(ctx)}/veiculos/${d.veiculo}/agenda`, { dias: escolhidos, inicio: d.inicio, fim: d.fim, ativo: d.ativo });
    });
    if (r) { toast('Bloqueio programado salvo.'); carregar(); }
  };
  const novo = pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, icone('cadeado'), 'Novo bloqueio programado') : null;
  const appMotorista = `${location.origin}${BASE}/motorista/`;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'O veículo fica bloqueado num horário fixo (por exemplo, à noite). Para usar fora do horário, o motorista gera um código no app e o gestor libera por algumas horas.'), novo), corpo);
  async function carregar() {
    const [s, vs] = await Promise.all([api.get(`${base(ctx)}/seguranca`), api.get(`${base(ctx)}/veiculos`)]);
    veiculos = vs;
    limpar(corpo,
      cartao(null, tabela(['Veículo', 'Motorista', 'Dias', 'Horário', 'Agora', '^Ações'], s.agendas.map((a) => el('tr', { class: a.ativo ? '' : 'inativo' },
        td([el('strong', {}, placa(a.placa)), a.descricao ? el('div', { class: 'pequeno mudo' }, a.descricao) : null]), td(a.motorista ?? '—'),
        td(diasTexto(a.dias)), td(`${a.inicio} às ${a.fim}`),
        td(!a.ativo ? etiqueta('desligado', '') : a.liberacao ? etiqueta(`liberado até ${hora(a.liberacao)}`, 'ok')
          : a.em_horario ? etiqueta(a.ocorrencia === 'aguardando' ? 'aguardando velocidade segura' : a.bloqueado ? 'bloqueado' : 'bloqueando', a.bloqueado ? 'erro' : 'aviso')
            : etiqueta('fora do horário', 'info')),
        el('td', { class: 'acoes' }, pode(ctx) ? [botaoIcone('editar', 'Editar', () => form(a)), botaoIcone('lixo', 'Remover', async () => {
          if (!await confirmar('Remover o bloqueio programado', `${placa(a.placa)} deixa de ser bloqueado no horário${a.em_horario ? ' e é desbloqueado agora' : ''}.`, 'Remover')) return;
          await api.del(`${base(ctx)}/veiculos/${a.veiculo_id}/agenda`);
          toast('Bloqueio programado removido.');
          carregar();
        }, 'perigo')] : null))), 'Nenhum veículo com bloqueio programado.')),
      cartao('App do motorista', el('div', { class: 'app-motorista' },
        el('div', {}, el('p', { class: 'mudo', style: 'margin-top:0' }, 'O motorista entra com o CPF e uma senha de 4 a 6 números, cadastrada em Frota → Motoristas (botão "Acesso ao app"). '
          + 'No app ele vê se o veículo está liberado e gera o código de liberação.'),
        el('div', { class: 'segredo' }, appMotorista)),
        el('div', { class: 'linha' },
          el('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`App do motorista: ${appMotorista}`)}`, target: '_blank', rel: 'noopener' }, 'Enviar por WhatsApp'),
          el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(appMotorista).then(() => toast('Copiado.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar link')))));
  }
  ctx.parar(repetir(carregar, 30_000));
}

// ---------- Liberações (código do motorista) ----------
async function telaLiberacoes(ctx) {
  const lista = el('div');
  const resultado = el('div', { class: 'resultado-codigo' });
  const entrada = el('input', { class: 'codigo-grande', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '000 000', 'aria-label': 'Código do motorista' });
  entrada.addEventListener('input', () => {
    const d = entrada.value.replace(/\D/g, '').slice(0, 6);
    entrada.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
  });
  const conferir = el('button', { class: 'btn primario' }, 'Conferir código');
  const form = el('form', { class: 'entrada-codigo', onsubmit: (e) => {
    e.preventDefault();
    acao(conferir, async () => {
      const codigo = entrada.value.replace(/\D/g, '');
      if (codigo.length !== 6) throw new Error('O código tem 6 números.');
      mostrar(codigo, await api.post(`${base(ctx)}/liberacoes/consultar`, { codigo }));
    });
  } }, entrada, conferir);

  function mostrar(codigo, p) {
    let horas = p.horas_pedidas ?? 2;
    const liberar = el('button', { class: 'btn primario largo' });
    const chips = el('div', { class: 'chips' });
    const desenhar = () => {
      liberar.textContent = `Liberar o veículo por ${horas} h`;
      limpar(chips, [1, 2, 4, 8, 12].map((h) => el('button', { type: 'button', class: `chip${h === horas ? ' on' : ''}`, onclick: () => { horas = h; desenhar(); } }, `${h} h`)));
    };
    desenhar();
    liberar.addEventListener('click', () => acao(liberar, async () => {
      const r = await api.post(`${base(ctx)}/liberacoes/aplicar`, { codigo, horas });
      toast(`${placa(r.veiculo)} liberado até ${hora(r.libera_ate)}. O desbloqueio já foi enviado.`);
      entrada.value = '';
      limpar(resultado);
      carregar();
    }));
    limpar(resultado, el('div', { class: 'pedido' },
      el('div', { class: 'pedido-quem' }, icone('motoristas'), el('div', {},
        el('strong', {}, `${p.motorista ?? 'Motorista'} pediu o ${placa(p.veiculo)}`),
        el('div', { class: 'pequeno mudo' }, `${p.descricao ? `${p.descricao} · ` : ''}pedido de ${p.horas_pedidas} h · o código vale até ${hora(p.expira_em)}`))),
      chips, liberar));
  }

  async function carregar() {
    const s = await api.get(`${base(ctx)}/seguranca`);
    limpar(lista, tabela(['Pedido', 'Veículo', 'Motorista', 'Situação', 'Liberado até', 'Por', '^Ações'], s.liberacoes.map((l) => {
      const [rot, tom] = STATUS_LIBERACAO[l.status] ?? [l.status, ''];
      return el('tr', {},
        td(dataHora(l.criado_em)), td(el('strong', {}, placa(l.placa))), td(l.motorista ?? '—'),
        td([etiqueta(rot, tom), el('div', { class: 'pequeno mudo' }, l.horas ? `${l.horas} h` : `pediu ${l.horas_pedidas} h`)]),
        td(l.libera_ate ? dataHora(l.libera_ate) : '—'), td(l.aplicada_por_nome ?? '—'),
        el('td', { class: 'acoes' }, pode(ctx) && l.status === 'ativa' ? botao('Encerrar agora', '', async () => {
          if (!await confirmar('Encerrar a liberação', `Se estiver no horário do bloqueio, o corte do ${placa(l.placa)} volta pelo bloqueio inteligente.`, 'Encerrar')) return;
          await api.post(`${base(ctx)}/liberacoes/${l.id}/encerrar`, {});
          toast('Liberação encerrada.');
          carregar();
        }) : null));
    }), 'Nenhum pedido nos últimos 30 dias.'));
  }
  limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:16px' },
    pode(ctx) ? cartao('Código do motorista', el('p', { class: 'mudo', style: 'margin-top:0' },
      'O motorista gera o código de 6 números no app e passa para você. Confira quem pediu e escolha por quantas horas liberar: o desbloqueio sai na hora '
      + 'e, no fim, o veículo volta a ser bloqueado sozinho. Um aviso chega no WhatsApp 15 minutos antes de acabar.'), form, resultado) : null,
    cartao('Pedidos e liberações (30 dias)', lista)));
  if (pode(ctx)) entrada.focus();
  ctx.parar(repetir(carregar, 20_000));
}

export const TELAS_SEGURANCA = { roubo: telaRoubo, estacionados: telaEstacionados, 'bloqueio-programado': telaBloqueioProgramado, liberacoes: telaLiberacoes };
