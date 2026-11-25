/**
 * Controle de senha: a tela de quem atende. Um botão grande chama a próxima senha, e ela aparece na TV
 * do ponto em poucos segundos. Serve para a equipe (escolhendo o ponto) e para o portal do próprio ponto.
 */
import { api, qs } from './api.js';
import { el, limpar, toast, acao, confirmar, perguntar, campo, escolha, repetir, dataHora } from './ui.js';

const CHAVE_GUICHE = 'midia.senha.guiche';
const lembrado = () => { try { return localStorage.getItem(CHAVE_GUICHE) || 'Guichê 1'; } catch { return 'Guichê 1'; } };
const lembrar = (v) => { try { localStorage.setItem(CHAVE_GUICHE, v); } catch { /* ignora */ } };

/** "4 min 05 s" — quanto tempo durou (ou está durando) o atendimento. */
const tempo = (seg) => {
  if (seg === null || seg === undefined) return '—';
  const m = Math.floor(seg / 60);
  const r = Math.floor(seg % 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min ${String(r).padStart(2, '0')} s`;
};
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');

function painel(ctx, { base, local = () => null }) {
  const corpo = el('div', { class: 'coluna' });
  // Estes dois campos ficam fora do que é redesenhado: o que o atendente está digitando não some.
  const guiche = el('input', { name: 'guiche', maxlength: 30, value: lembrado(), placeholder: 'Guichê 1' });
  const assunto = el('input', { name: 'assunto', maxlength: 80, placeholder: 'Ex.: Plano novo, 2ª via, suporte…', list: 'assuntos-senha', autocomplete: 'off' });
  const sugestoes = el('datalist', { id: 'assuntos-senha' });
  const cronometro = el('strong', { class: 'senha-tempo' }, '');
  let aberta = null;
  const meuGuiche = () => guiche.value.trim() || 'Guichê 1';
  const corpoReq = (extra = {}) => ({ ...(local() ? { local_id: local() } : {}), guiche: meuGuiche(), ...extra });
  const marcarTempo = () => { cronometro.textContent = aberta ? tempo((Date.now() - Date.parse(aberta.chamada_em)) / 1000) : ''; };
  ctx.parar(repetir(async () => { marcarTempo(); }, 1000));

  const pintar = async (dados) => {
    const s = dados ?? await api.get(`${base}/senhas${qs({ ...(local() ? { local_id: local() } : {}), guiche: meuGuiche() })}`);
    aberta = s.em_atendimento;
    marcarTempo();
    limpar(sugestoes, ...s.assuntos.map((a) => el('option', { value: a })));
    const chamar = (tipo, extra = {}) => (ev) => acao(ev.currentTarget, async () => {
      const r = await api.post(`${base}/senhas/chamar`, corpoReq({ tipo, assunto_anterior: assunto.value.trim() || undefined, ...extra }));
      assunto.value = '';
      toast(`Chamando ${r.atual.codigo} — ${r.atual.guiche}`);
      pintar(r);
    });
    limpar(corpo,
      el('div', { class: 'cartao senha-atual' },
        el('div', { class: 'pequeno mudo', style: 'letter-spacing:.18em;text-transform:uppercase;font-weight:700' }, 'Na TV agora'),
        el('div', { class: 'senha-grande' }, s.atual ? s.atual.codigo : '—'),
        el('div', { class: 'senha-onde' }, s.atual ? `${s.atual.guiche} · chamada às ${hora(s.atual.repetida_em ?? s.atual.chamada_em)}` : 'Nenhuma senha chamada hoje')),

      el('div', { class: 'cartao' },
        el('label', { class: 'campo' }, el('span', {}, 'Seu guichê (é o que aparece na TV)'), guiche),
        s.em_atendimento
          ? el('div', { class: 'senha-atendendo' },
            el('div', { class: 'linha entre', style: 'gap:10px;flex-wrap:wrap' },
              el('span', {}, 'Você está atendendo ', el('strong', {}, s.em_atendimento.codigo)), cronometro),
            el('label', { class: 'campo', style: 'margin-top:10px' }, el('span', {}, 'Assunto deste atendimento'), assunto, sugestoes),
            el('p', { class: 'pequeno mudo', style: 'margin:6px 0 0' }, 'Chamar a próxima encerra este atendimento e guarda o assunto e o tempo.'))
          : null,
        el('div', { class: 'senha-botoes' },
          el('button', { class: 'btn primario senha-chamar', onclick: chamar('N') },
            el('span', {}, 'Chamar próxima'), el('strong', {}, s.proxima.N)),
          el('button', { class: 'btn senha-chamar', onclick: chamar('P') },
            el('span', {}, 'Chamar preferencial'), el('strong', {}, s.proxima.P))),
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:12px' },
          s.em_atendimento ? el('button', { class: 'btn', onclick: (ev) => acao(ev.currentTarget, async () => {
            const r = await api.post(`${base}/senhas/encerrar`, corpoReq({ assunto: assunto.value.trim() || undefined }));
            assunto.value = '';
            toast('Atendimento encerrado.');
            pintar(r);
          }) }, 'Encerrar atendimento') : null,
          el('button', { class: 'btn', disabled: !s.atual, onclick: (ev) => acao(ev.currentTarget, async () => {
            pintar(await api.post(`${base}/senhas/repetir`, corpoReq()));
            toast('Chamando de novo.');
          }) }, 'Chamar de novo'),
          el('button', { class: 'btn', onclick: async () => {
            const n = await perguntar('Chamar uma senha específica', 'Número da senha normal (ex.: 12)');
            if (!n) return;
            const r = await api.post(`${base}/senhas/chamar`, corpoReq({ tipo: 'N', numero: Number(n), assunto_anterior: assunto.value.trim() || undefined }));
            assunto.value = '';
            pintar(r);
          } }, 'Chamar número…'),
          el('button', { class: 'btn perigo', onclick: async () => {
            if (!await confirmar('Zerar as senhas de hoje?', 'Apaga as chamadas e os atendimentos de hoje deste ponto. A contagem volta para 0001.', 'Zerar')) return;
            pintar(await api.post(`${base}/senhas/zerar`, corpoReq()));
            toast('Contagem zerada.');
          } }, 'Zerar o dia'))),

      el('div', { class: 'cartao' },
        el('h2', {}, 'Atendimentos de hoje'),
        el('p', { class: 'mudo', style: 'margin-top:-8px' },
          `${s.chamadas_hoje} senha(s) chamada(s) · ${s.encerrados_hoje} atendimento(s) encerrado(s)`
          + (s.tempo_medio_s !== null ? ` · tempo médio ${tempo(s.tempo_medio_s)}` : '')),
        s.atendimentos.length
          ? el('div', { class: 'lista-senhas' }, s.atendimentos.map((a) => el('div', { class: 'item-senha' },
            el('div', { class: 'cabeca' }, el('strong', {}, a.codigo), el('span', { class: 'mudo' }, `${a.guiche} · ${hora(a.chamada_em)}`),
              el('span', { class: 'tempo' }, a.encerrada_em ? tempo(a.duracao_s) : 'em atendimento')),
            el('button', { type: 'button', class: 'assunto', title: 'Tocar para escrever ou corrigir o assunto', onclick: async () => {
              const novo = await perguntar(`Assunto da senha ${a.codigo}`, 'Assunto do atendimento', { obrigatorio: false, valor: a.assunto ?? '' });
              if (novo === null) return;
              pintar(await api.post(`${base}/senhas/assunto`, corpoReq({ id: a.id, assunto: novo })));
            } }, a.assunto || 'sem assunto — tocar para escrever'))))
          : el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhuma senha chamada hoje.')),
      el('p', { class: 'pequeno mudo' }, 'A contagem recomeça sozinha em 0001 todo dia. Para a senha aparecer na TV: em TVs › Editar, deixe "Tela dividida" em Sim e "a metade do ponto mostra" em Chamada de senha.'));
  };
  guiche.addEventListener('change', () => { lembrar(meuGuiche()); pintar(); });
  pintar().catch((e) => limpar(corpo, el('p', { class: 'aviso erro' }, e.message)));
  // Mais de um atendente chamando: a tela de cada um acompanha (sem atrapalhar quem está digitando o assunto).
  ctx.parar(repetir(() => (document.activeElement === assunto || document.activeElement === guiche ? null : pintar()), 8000));
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
