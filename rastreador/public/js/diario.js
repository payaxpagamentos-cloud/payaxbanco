/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/** O que chega do app do motorista: checklists, abastecimentos e avarias (com fotos), e o QR code de cada veículo. */
import { api, qs } from './api.js';
import { el, limpar, dinheiro, dataHora, placa, inteiro, toast, escolha, modal, confirmar, perguntar, etiqueta, icone, hojeLocal, somarDias } from './ui.js';
import { cartao, indicador, tabela, td, botao, campoData } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const pode = (ctx) => !ctx.somenteLeitura;

// ---------- Fotos (pedidas com a sessão; o navegador não manda o login numa <img> comum) ----------
const cacheFotos = new Map();
async function srcFoto(ctx, id) {
  const chave = `${ctx.empresaId}:${id}`;
  if (!cacheFotos.has(chave)) {
    cacheFotos.set(chave, api.get(`${base(ctx)}/fotos/${id}`, { bruto: true }).then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch(() => {
      cacheFotos.delete(chave);
      return null;
    }));
  }
  return cacheFotos.get(chave);
}
function miniaturas(ctx, ids, titulo) {
  if (!ids?.length) return null;
  const caixa = el('div', { class: 'fotos-painel' });
  for (const id of ids) {
    const img = el('img', { alt: 'Foto', loading: 'lazy' });
    srcFoto(ctx, id).then((src) => { if (src) img.src = src; });
    caixa.append(el('button', { type: 'button', class: 'foto-painel', title: 'Ampliar', onclick: async () => {
      const src = await srcFoto(ctx, id);
      if (src) modal(titulo, (fechar) => [el('img', { src, class: 'foto-grande', alt: titulo }), el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' },
        el('a', { class: 'btn', href: src, download: `foto-${id}.jpg` }, icone('baixar'), 'Baixar'), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar'))], { largo: true });
    } }, img));
  }
  return caixa;
}

// ---------- QR code do veículo ----------
export async function qrVeiculo(ctx, v, depois) {
  const q = await api.get(`${base(ctx)}/veiculos/${v.id}/qr`);
  const area = el('div', { class: 'qr-area' });
  area.innerHTML = q.svg; // SVG gerado pelo servidor a partir do link (sem texto de terceiros)
  const imprimir = () => {
    const w = window.open('', '_blank', 'width=520,height=720');
    if (!w) return toast('Libere as janelas para imprimir.', true);
    w.document.write(`<!doctype html><meta charset="utf-8"><title>QR ${placa(q.placa)}</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}
      .q{width:320px;margin:12px auto}h1{font-size:40px;margin:8px 0}p{color:#334;font-size:16px;margin:6px 0}small{color:#667}</style>
      <h1>${placa(q.placa)}</h1><p>${(q.descricao ?? '').replace(/[<>&]/g, '')}</p><div class="q">${q.svg}</div>
      <p><b>Motorista:</b> aponte a câmera do celular para o código e toque no link.</p><small>App do motorista · Rastreador</small>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };
  modal(`QR code · ${placa(q.placa)}`, (fechar) => [
    el('p', { class: 'mudo', style: 'margin-top:0' }, 'Imprima e cole no veículo (no painel ou no para-sol). O motorista aponta a câmera do celular, toca no link e assume o veículo: a nota e o custo passam a contar para ele.'),
    area,
    q.condutor ? el('p', { class: 'pequeno' }, 'Hoje com: ', el('strong', {}, q.condutor)) : null,
    el('div', { class: 'linha entre', style: 'margin-top:12px' },
      pode(ctx) ? el('button', { class: 'btn pequeno', onclick: async () => {
        if (!await confirmar('Trocar o QR code', 'O QR impresso deixa de valer (use se a etiqueta foi perdida ou copiada). Você precisa imprimir o novo.', 'Trocar')) return;
        await api.post(`${base(ctx)}/veiculos/${v.id}/qr/novo`, {});
        fechar();
        qrVeiculo(ctx, v, depois);
      } }, 'Trocar o código') : el('span'),
      el('div', { class: 'linha' }, el('button', { class: 'btn', onclick: imprimir }, icone('baixar'), 'Imprimir'), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto'))),
  ]);
}

// ---------- Checklists (Frota → Checklists) ----------
async function telaChecklists(ctx) {
  const veiculos = await api.get(`${base(ctx)}/veiculos`);
  const estado = { de: somarDias(hojeLocal(), -29), ate: hojeLocal(), veiculo_id: '', reprovados: '' };
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  const sel = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  limpar(ctx.conteudo, el('div', { class: 'filtros livre' },
    sel('Veículo', 'veiculo_id', { '': 'Todos', ...Object.fromEntries(veiculos.map((x) => [x.id, placa(x.placa)])) }),
    sel('Situação', 'reprovados', { '': 'Todos', 1: 'Só com problema' }),
    campoData('De', estado.de, (x) => { estado.de = x; carregar(); }), campoData('Até', estado.ate, (x) => { estado.ate = x; carregar(); })), corpo);
  async function carregar() {
    const r = await api.get(`${base(ctx)}/checklists${qs(estado)}`);
    const reprov = r.checklists.filter((c) => !c.aprovado).length;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Checklists', inteiro(r.checklists.length), 'no período', '', 'check'),
        indicador('Com problema', inteiro(reprov), reprov ? 'confira os itens' : 'nenhum', reprov ? 'erro' : 'ok', 'alertas'),
        indicador('Veículos', inteiro(new Set(r.checklists.map((c) => c.veiculo_id)).size), 'com checklist', '', 'veiculos')),
      r.checklists.length ? el('div', { class: 'lista-checklists' }, r.checklists.map((c) => {
        const problemas = c.itens.filter((i) => !i.ok);
        return el('article', { class: `cartao checklist-painel${c.aprovado ? '' : ' reprovado'}` },
          el('header', { class: 'linha entre' }, el('div', {}, el('strong', {}, placa(c.placa)), el('span', { class: 'mudo' }, ` · ${c.motorista ?? 'motorista'}`),
            el('div', { class: 'pequeno mudo' }, `${dataHora(c.criado_em)}${c.km ? ` · ${inteiro(c.km)} km` : ''}`)),
          c.aprovado ? etiqueta('tudo OK', 'ok') : etiqueta(`${problemas.length} problema(s)`, 'erro')),
          el('ul', { class: 'itens-check' }, c.itens.map((i) => el('li', { class: i.ok ? 'ok' : 'problema' }, icone(i.ok ? 'check' : 'fechar'),
            el('span', {}, i.texto, i.obs ? el('em', {}, ` · ${i.obs}`) : null)))),
          c.observacao ? el('p', { class: 'pequeno', style: 'margin:0' }, c.observacao) : null,
          miniaturas(ctx, c.fotos, `Checklist · ${placa(c.placa)}`));
      })) : cartao(null, el('div', { class: 'vazio-seguranca' }, icone('check'), el('strong', {}, 'Nenhum checklist no período.'),
        el('span', { class: 'mudo' }, 'Os motoristas enviam pelo app do motorista, antes de sair. Libere o acesso ao app em Frota → Motoristas.'))));
  }
  await carregar();
}

// ---------- Abastecimentos (na tela de Custos) ----------
export function cartaoAbastecimentos(ctx, lista) {
  const total = lista.reduce((s, a) => s + a.valor_centavos, 0);
  const litros = lista.reduce((s, a) => s + a.litros, 0);
  return cartao('Abastecimentos do app do motorista',
    lista.length ? el('p', { class: 'pequeno mudo', style: 'margin-top:0' }, `${inteiro(lista.length)} abastecimento(s) · ${String(Math.round(litros * 10) / 10).replace('.', ',')} L · ${dinheiro(total)}`
      + (litros ? ` · média de ${dinheiro(Math.round(total / litros))}/L` : '')) : null,
    tabela(['Quando', 'Veículo', 'Motorista', '>Litros', '>Valor', '>R$/L', 'Km', 'Posto', 'Cupom'], lista.map((a) => el('tr', {},
      td(dataHora(a.criado_em)), td(el('strong', {}, placa(a.placa))), td(a.motorista ?? '—'), td(String(a.litros).replace('.', ','), 'dir num'), td(dinheiro(a.valor_centavos), 'dir num'),
      td(dinheiro(Math.round(a.valor_centavos / a.litros)), 'dir num'), td(a.km ? inteiro(a.km) : a.hodometro_km ? `${inteiro(a.hodometro_km)} (rastreador)` : '—'), td(a.posto ?? '—'),
      td(miniaturas(ctx, a.fotos, `Cupom · ${placa(a.placa)}`) ?? '—'))), 'Nenhum abastecimento lançado no período. O motorista lança pelo app (litros, valor e foto do cupom).'));
}

// ---------- Avarias (na tela de Manutenção) ----------
const TOM_GRAVIDADE = { alta: 'erro', media: 'aviso', baixa: 'info' };
export async function cartaoAvarias(ctx) {
  const corpo = el('div');
  let status = 'abertas';
  const filtro = el('div', { class: 'chips' });
  async function carregar() {
    const r = await api.get(`${base(ctx)}/avarias?status=${status}`);
    limpar(filtro, [['abertas', 'Abertas'], ['resolvidas', 'Resolvidas'], ['todas', 'Todas']].map(([k, t]) => el('button', { type: 'button', class: `chip${k === status ? ' on' : ''}`,
      onclick: () => { status = k; carregar(); } }, t)));
    limpar(corpo, tabela(['Quando', 'Veículo', 'Motorista', 'O que aconteceu', 'Gravidade', 'Situação', 'Fotos', '^Ações'], r.avarias.map((a) => el('tr', {},
      td(dataHora(a.criado_em)), td(el('strong', {}, placa(a.placa))), td(a.motorista ?? '—'),
      td([a.descricao, a.observacao ? el('div', { class: 'pequeno mudo' }, `Gestor: ${a.observacao}`) : null]),
      td(etiqueta(r.gravidades[a.gravidade], TOM_GRAVIDADE[a.gravidade])),
      td(a.status === 'resolvida' ? [etiqueta('resolvida', 'ok'), el('div', { class: 'pequeno mudo' }, `${a.resolvida_por_nome ?? ''} · ${dataHora(a.resolvida_em)}`)]
        : etiqueta(r.situacoes[a.status], a.status === 'aberta' ? 'aviso' : 'info')),
      td(miniaturas(ctx, a.fotos, `Avaria · ${placa(a.placa)}`) ?? '—'),
      el('td', { class: 'acoes' }, pode(ctx) && a.status !== 'resolvida' ? [
        a.status === 'aberta' ? botao('Em andamento', '', async () => { await api.put(`${base(ctx)}/avarias/${a.id}`, { status: 'em_andamento' }); carregar(); }) : null,
        botao('Resolver', 'primario', async () => {
          const obs = await perguntar('Resolver a avaria', 'O que foi feito? (opcional)', { obrigatorio: false });
          if (obs === null) return;
          await api.put(`${base(ctx)}/avarias/${a.id}`, { status: 'resolvida', observacao: obs });
          toast('Avaria resolvida.');
          carregar();
        })] : null))), status === 'abertas' ? 'Nenhuma avaria aberta.' : 'Nenhuma avaria.'));
  }
  await carregar();
  return cartao('Avarias reportadas pelos motoristas', el('div', { class: 'linha entre', style: 'margin-bottom:10px' },
    el('span', { class: 'pequeno mudo' }, 'O motorista reporta pelo app, com fotos; a empresa recebe o aviso pelo WhatsApp.'), filtro), corpo);
}

export const TELAS_DIARIO = { checklists: telaChecklists };
