/**
 * Controle de senha: a tela de quem atende. Um botão grande chama a próxima senha, e ela aparece na TV
 * do ponto em poucos segundos. Serve para a equipe (escolhendo o ponto) e para o portal do próprio ponto.
 */
import { api, qs } from './api.js';
import { el, limpar, toast, acao, confirmar, perguntar, campo, escolha, repetir, dataHora } from './ui.js';

const CHAVE_GUICHE = 'midia.senha.guiche';
const lembrado = () => { try { return localStorage.getItem(CHAVE_GUICHE) || 'Guichê 1'; } catch { return 'Guichê 1'; } };
const lembrar = (v) => { try { localStorage.setItem(CHAVE_GUICHE, v); } catch { /* ignora */ } };

function painel(ctx, { base, local = () => null }) {
  const corpo = el('div', { class: 'coluna' });
  const guiche = el('input', { name: 'guiche', maxlength: 30, value: lembrado(), placeholder: 'Guichê 1' });
  guiche.addEventListener('change', () => lembrar(guiche.value.trim() || 'Guichê 1'));
  const q = () => (local() ? qs({ local_id: local() }) : '');
  const corpoReq = (extra = {}) => ({ ...(local() ? { local_id: local() } : {}), guiche: guiche.value.trim() || 'Guichê 1', ...extra });

  const pintar = async (dados) => {
    const s = dados ?? await api.get(`${base}/senhas${q()}`);
    const chamar = (tipo) => (ev) => acao(ev.currentTarget, async () => {
      const r = await api.post(`${base}/senhas/chamar`, corpoReq({ tipo }));
      toast(`Chamando ${r.atual.codigo} — ${r.atual.guiche}`);
      pintar(r);
    });
    limpar(corpo,
      el('div', { class: 'cartao senha-atual' },
        el('div', { class: 'pequeno mudo', style: 'letter-spacing:.18em;text-transform:uppercase;font-weight:700' }, 'Na TV agora'),
        el('div', { class: 'senha-grande' }, s.atual ? s.atual.codigo : '—'),
        el('div', { class: 'senha-onde' }, s.atual ? `${s.atual.guiche} · ${dataHora(s.atual.repetida_em ?? s.atual.chamada_em)}` : 'Nenhuma senha chamada hoje')),
      el('div', { class: 'cartao' },
        el('label', { class: 'campo' }, el('span', {}, 'Seu guichê (é o que aparece na TV)'), guiche),
        el('div', { class: 'senha-botoes' },
          el('button', { class: 'btn primario senha-chamar', onclick: chamar('N') },
            el('span', {}, 'Chamar próxima'), el('strong', {}, s.proxima.N)),
          el('button', { class: 'btn senha-chamar', onclick: chamar('P') },
            el('span', {}, 'Chamar preferencial'), el('strong', {}, s.proxima.P))),
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:12px' },
          el('button', { class: 'btn', disabled: !s.atual, onclick: (ev) => acao(ev.currentTarget, async () => {
            pintar(await api.post(`${base}/senhas/repetir`, corpoReq()));
            toast('Chamando de novo.');
          }) }, 'Chamar de novo'),
          el('button', { class: 'btn', onclick: async () => {
            const n = await perguntar('Chamar uma senha específica', 'Número da senha normal (ex.: 12)');
            if (!n) return;
            pintar(await api.post(`${base}/senhas/chamar`, corpoReq({ tipo: 'N', numero: Number(n) })));
          } }, 'Chamar número…'),
          el('button', { class: 'btn perigo', onclick: async () => {
            if (!await confirmar('Zerar as senhas de hoje?', 'A contagem volta para N001 e P001 e a TV fica sem senha até a próxima chamada.', 'Zerar')) return;
            pintar(await api.post(`${base}/senhas/zerar`, corpoReq()));
            toast('Contagem zerada.');
          } }, 'Zerar o dia'))),
      el('div', { class: 'cartao' },
        el('h2', {}, `Últimas chamadas (${s.chamadas_hoje} hoje)`),
        s.ultimas.length
          ? el('ul', { class: 'linha-tempo' }, s.ultimas.map((u) => el('li', {},
            el('div', { class: 'quando' }, dataHora(u.repetida_em ?? u.chamada_em)),
            el('div', {}, el('strong', {}, u.codigo), ` — ${u.guiche}`))))
          : el('p', { class: 'mudo', style: 'margin:0' }, 'Ainda não há outras chamadas hoje.')),
      el('p', { class: 'pequeno mudo' }, 'Para a senha aparecer na TV: em TVs › Editar, deixe "Tela dividida" em Sim e "a metade do ponto mostra" em Chamada de senha.'));
  };
  pintar().catch((e) => limpar(corpo, el('p', { class: 'aviso erro' }, e.message)));
  // Mais de um atendente chamando: a tela de cada um acompanha.
  ctx.parar(repetir(() => pintar(), 8000));
  corpo.repintar = () => pintar();
  return corpo;
}

export async function senhasEquipe(ctx) {
  const opcoes = await api.get('/painel/opcoes');
  if (!opcoes.locais.length) { limpar(ctx.conteudo, el('p', { class: 'mudo' }, 'Cadastre um ponto primeiro.')); return; }
  let localId = opcoes.locais[0].id;
  const area = painel(ctx, { base: '/painel', local: () => localId });
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Ponto', 'local_id', Object.fromEntries(opcoes.locais.map((l) => [l.id, l.nome])), localId, { onchange: (e) => { localId = Number(e.target.value); area.repintar(); } })),
    area);
}

export async function senhasLojista(ctx) {
  limpar(ctx.conteudo, painel(ctx, { base: '/ponto' }));
}
