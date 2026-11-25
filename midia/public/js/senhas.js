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

/** Um toque curto de aviso: chegou senha para este atendente. */
function apitar() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.22 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.2);
      o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.22);
    });
    setTimeout(() => ctx.close(), 900);
  } catch { /* sem som, segue */ }
}

function painel(ctx, { base, local = () => null }) {
  const corpo = el('div', { class: 'coluna' });
  // Estes campos ficam fora do que é redesenhado: o que o atendente está digitando não some.
  const guiche = el('input', { name: 'guiche', maxlength: 30, value: lembrado(), placeholder: 'Guichê 1' });
  const assunto = el('input', { name: 'assunto', maxlength: 80, placeholder: 'Ex.: Plano novo, 2ª via, troca de equipamento…', list: 'assuntos-senha', autocomplete: 'off' });
  const sugestoes = el('datalist', { id: 'assuntos-senha' });
  const cronometro = el('strong', { class: 'senha-tempo' }, '');
  const servicos = el('textarea', { name: 'servicos', rows: 4, placeholder: 'Comercial\nSuporte' });
  const rotuloEncerrar = el('span', {}, 'Encerrar atendimento');
  // (Atualizado a cada sinal, mesmo enquanto o atendente digita o assunto.)
  const marcarEncerrar = (s) => { rotuloEncerrar.textContent = s.disponivel && s.aguardando ? 'Encerrar e receber a próxima' : 'Encerrar atendimento'; };
  let aberta = null;
  let idAberta; // undefined na primeira leitura: não apita por atendimento que já estava aberto
  let totem = null;
  let totemAberto = false;
  const meuGuiche = () => guiche.value.trim() || 'Guichê 1';
  const ponto = () => (local() ? { local_id: local() } : {});
  const corpoReq = (extra = {}) => ({ ...ponto(), guiche: meuGuiche(), ...extra });
  const ler = () => api.get(`${base}/senhas${qs({ ...ponto(), guiche: meuGuiche() })}`);
  const marcarTempo = () => { cronometro.textContent = aberta ? tempo((Date.now() - Date.parse(aberta.chamada_em)) / 1000) : ''; };
  const pararRelogio = repetir(async () => { marcarTempo(); }, 1000);
  const linkTotem = () => new URL(`totem/?t=${totem.totem_chave}`, location.href.split('#')[0]).href;

  const pintar = async (dados) => {
    const s = dados ?? await ler();
    if (!totem) { totem = await api.get(`${base}/senhas/totem${qs(ponto())}`); servicos.value = totem.servicos.join('\n'); }
    const chegou = s.em_atendimento && idAberta !== undefined && s.em_atendimento.id !== idAberta;
    idAberta = s.em_atendimento?.id ?? null;
    aberta = s.em_atendimento;
    if (chegou) { assunto.value = ''; apitar(); toast(`Senha ${aberta.codigo} para você${aberta.servico ? ` — ${aberta.servico}` : ''}`); }
    marcarTempo();
    marcarEncerrar(s);
    limpar(sugestoes, ...s.assuntos.map((a) => el('option', { value: a })));
    const chamar = (tipo, extra = {}) => (ev) => acao(ev.currentTarget, async () => {
      const r = await api.post(`${base}/senhas/chamar`, corpoReq({ tipo, assunto_anterior: assunto.value.trim() || undefined, ...extra }));
      assunto.value = ''; idAberta = r.em_atendimento?.id ?? null;
      toast(`Chamando ${r.atual.codigo} — ${r.atual.guiche}`);
      pintar(r);
    });
    const disponibilidade = (sim) => (ev) => acao(ev.currentTarget, async () => {
      pintar(await api.post(`${base}/senhas/disponivel`, corpoReq({ disponivel: sim })));
      toast(sim ? 'Você está disponível: a próxima senha vem para você.' : 'Pausado: você não recebe senha.');
    });
    const a = s.em_atendimento;
    limpar(corpo,
      el('div', { class: `cartao senha-vez ${s.disponivel ? 'ligado' : ''}` },
        el('div', {},
          el('strong', {}, s.disponivel ? 'Você está disponível' : 'Você está em pausa'),
          el('div', { class: 'pequeno mudo' }, s.disponivel
            ? 'A senha do totem vem sozinha para quem está há mais tempo sem atender.'
            : 'Fique disponível para receber as senhas do totem automaticamente.')),
        s.disponivel
          ? el('button', { class: 'btn', onclick: disponibilidade(false) }, 'Pausar')
          : el('button', { class: 'btn primario', onclick: disponibilidade(true) }, 'Ficar disponível')),

      el('div', { class: 'cartao' },
        el('label', { class: 'campo' }, el('span', {}, 'Seu guichê (é o que aparece na TV)'), guiche),
        a
          ? el('div', { class: 'senha-atendendo' },
            el('div', { class: 'linha entre', style: 'gap:10px;flex-wrap:wrap' },
              el('span', {}, 'Você está atendendo ', el('strong', { class: 'senha-cod' }, a.codigo)), cronometro),
            a.servico || a.cpf ? el('div', { class: 'senha-cliente' },
              a.servico ? el('span', { class: 'etiqueta' }, a.servico) : null,
              a.tipo === 'P' ? el('span', { class: 'etiqueta' }, 'Preferencial') : null,
              a.cpf ? el('span', {}, `CPF ${a.cpf}`) : null,
              a.espera_s !== null ? el('span', { class: 'mudo' }, `esperou ${tempo(a.espera_s)}`) : null) : null,
            el('label', { class: 'campo', style: 'margin-top:10px' }, el('span', {}, 'Assunto deste atendimento'), assunto, sugestoes),
            el('button', { class: 'btn primario', style: 'margin-top:12px;width:100%', onclick: (ev) => acao(ev.currentTarget, async () => {
              const r = await api.post(`${base}/senhas/encerrar`, corpoReq({ assunto: assunto.value.trim() || undefined }));
              assunto.value = '';
              const veio = r.em_atendimento;
              idAberta = veio?.id ?? null;
              if (veio) apitar();
              toast(veio ? `Encerrado. Próxima: ${veio.codigo}` : 'Atendimento encerrado.');
              pintar(r);
            }) }, rotuloEncerrar))
          : el('p', { class: 'mudo', style: 'margin:12px 0 0' }, s.disponivel
            ? (s.aguardando ? 'Chamando a próxima…' : 'Aguardando o próximo cliente tirar senha no totem.')
            : 'Sem atendimento em aberto.'),
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:12px' },
          el('button', { class: 'btn', onclick: chamar('N') }, `Chamar ${s.proxima.N}`),
          el('button', { class: 'btn', onclick: chamar('P') }, `Chamar ${s.proxima.P}`),
          el('button', { class: 'btn', disabled: !s.atual, onclick: (ev) => acao(ev.currentTarget, async () => {
            pintar(await api.post(`${base}/senhas/repetir`, corpoReq()));
            toast('Chamando de novo na TV.');
          }) }, 'Chamar de novo'),
          el('button', { class: 'btn', onclick: async () => {
            const n = await perguntar('Chamar uma senha específica', 'Número da senha normal (ex.: 12)');
            if (!n) return;
            const r = await api.post(`${base}/senhas/chamar`, corpoReq({ tipo: 'N', numero: Number(n), assunto_anterior: assunto.value.trim() || undefined }));
            assunto.value = ''; idAberta = r.em_atendimento?.id ?? null;
            pintar(r);
          } }, 'Chamar número…'))),

      el('div', { class: 'cartao' },
        el('h2', {}, `Fila de espera (${s.aguardando})`),
        s.fila.length
          ? el('div', { class: 'lista-senhas' }, s.fila.map((f) => el('div', { class: 'item-senha' },
            el('div', { class: 'cabeca' }, el('strong', {}, f.codigo), el('span', { class: 'mudo' }, [f.servico, f.tipo === 'P' ? 'preferencial' : null].filter(Boolean).join(' · ')),
              el('span', { class: 'tempo' }, `há ${tempo((Date.now() - Date.parse(f.emitida_em)) / 1000)}`)))))
          : el('p', { class: 'mudo', style: 'margin:0' }, 'Ninguém aguardando.'),
        s.operadores.length ? el('div', { class: 'senha-equipe' },
          el('div', { class: 'pequeno mudo', style: 'font-weight:700;margin-bottom:6px' }, 'Atendentes agora (na ordem de quem recebe a próxima)'),
          s.operadores.map((o) => el('div', { class: 'linha entre', style: 'gap:10px;padding:4px 0' },
            el('span', {}, `${o.nome} · ${o.guiche}`),
            el('span', { class: o.atendendo ? '' : 'mudo' }, o.atendendo ? `atendendo ${o.atendendo}` : o.disponivel ? `livre há ${tempo((Date.now() - Date.parse(o.livre_desde)) / 1000)}` : 'em pausa')))) : null),

      el('div', { class: 'cartao senha-atual' },
        el('div', { class: 'pequeno mudo', style: 'letter-spacing:.18em;text-transform:uppercase;font-weight:700' }, 'Na TV agora'),
        el('div', { class: 'senha-grande' }, s.atual ? s.atual.codigo : '—'),
        el('div', { class: 'senha-onde' }, s.atual ? `${s.atual.guiche} · chamada às ${hora(s.atual.repetida_em ?? s.atual.chamada_em)}` : 'Nenhuma senha chamada hoje')),

      el('div', { class: 'cartao' },
        el('h2', {}, 'Atendimentos de hoje'),
        el('p', { class: 'mudo', style: 'margin-top:-8px' },
          `${s.chamadas_hoje} chamada(s) · ${s.encerrados_hoje} encerrado(s)`
          + (s.tempo_medio_s !== null ? ` · atendimento médio ${tempo(s.tempo_medio_s)}` : '')
          + (s.espera_media_s !== null ? ` · espera média ${tempo(s.espera_media_s)}` : '')),
        s.atendimentos.length
          ? el('div', { class: 'lista-senhas' }, s.atendimentos.map((x) => el('div', { class: 'item-senha' },
            el('div', { class: 'cabeca' }, el('strong', {}, x.codigo), el('span', { class: 'mudo' }, `${x.guiche} · ${hora(x.chamada_em)}`),
              el('span', { class: 'tempo' }, x.encerrada_em ? tempo(x.duracao_s) : 'em atendimento')),
            x.servico || x.cpf ? el('div', { class: 'pequeno mudo' }, [x.servico, x.cpf ? `CPF ${x.cpf}` : null, x.espera_s !== null ? `esperou ${tempo(x.espera_s)}` : null].filter(Boolean).join(' · ')) : null,
            el('button', { type: 'button', class: 'assunto', title: 'Tocar para escrever ou corrigir o assunto', onclick: async () => {
              const novo = await perguntar(`Assunto da senha ${x.codigo}`, 'Assunto do atendimento', { obrigatorio: false, valor: x.assunto ?? '' });
              if (novo === null) return;
              pintar(await api.post(`${base}/senhas/assunto`, corpoReq({ id: x.id, assunto: novo })));
            } }, x.assunto || 'sem assunto — tocar para escrever'))))
          : el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhuma senha chamada hoje.')),

      el('details', { class: 'cartao senha-totem', open: totemAberto, ontoggle: (e) => { totemAberto = e.currentTarget.open; } },
        el('summary', {}, 'Totem e configuração'),
        el('p', { class: 'mudo' }, 'Abra este link no navegador do totem (tablet ou tela de toque). O cliente digita o CPF, escolhe o atendimento e recebe a senha.'),
        el('div', { class: 'senha-link' }, linkTotem()),
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin:10px 0 16px' },
          el('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(linkTotem()); toast('Link copiado.'); } catch { toast('Copie o link acima.'); } } }, 'Copiar link'),
          el('a', { class: 'btn', href: linkTotem(), target: '_blank', rel: 'noopener' }, 'Abrir o totem'),
          el('button', { class: 'btn', onclick: async () => {
            if (!await confirmar('Gerar um link novo?', 'O link atual para de funcionar: o totem precisa ser aberto de novo com o link novo.', 'Gerar')) return;
            totem = await api.post(`${base}/senhas/totem`, { ...ponto(), novo_link: true });
            pintar();
          } }, 'Gerar link novo')),
        el('label', { class: 'campo' }, el('span', {}, 'Atendimentos que o cliente escolhe no totem (um por linha)'), servicos),
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' },
          el('button', { class: 'btn primario', onclick: (ev) => acao(ev.currentTarget, async () => {
            totem = await api.post(`${base}/senhas/totem`, { ...ponto(), servicos: servicos.value });
            servicos.value = totem.servicos.join('\n');
            toast('Atendimentos salvos.');
          }) }, 'Salvar atendimentos'),
          el('button', { class: 'btn perigo', onclick: async () => {
            if (!await confirmar('Zerar as senhas de hoje?', 'Apaga a fila, as chamadas e os atendimentos de hoje deste ponto. A contagem volta para 0001.', 'Zerar')) return;
            idAberta = null;
            pintar(await api.post(`${base}/senhas/zerar`, corpoReq()));
            toast('Contagem zerada.');
          } }, 'Zerar o dia')),
        el('p', { class: 'pequeno mudo', style: 'margin-bottom:0' }, 'A contagem recomeça sozinha em 0001 todo dia. Para a senha aparecer na TV: em TVs › Editar, deixe "Tela dividida" em Sim e "a metade do ponto mostra" em Chamada de senha.')));
  };
  guiche.addEventListener('change', () => { lembrar(meuGuiche()); pintar(); });
  pintar().catch((e) => limpar(corpo, el('p', { class: 'aviso erro' }, e.message)));
  // A tela dá sinal a cada poucos segundos: é assim que o sistema sabe que o atendente está ali e
  // entrega a senha. Enquanto ele digita, a tela só é redesenhada se chegou senha nova.
  // (Relógio próprio, que segue mesmo com a aba em segundo plano: o atendente costuma estar em outro sistema.)
  let lendo = false;
  const sinal = setInterval(async () => {
    if (lendo) return;
    lendo = true;
    try {
      const s = await ler();
      const digitando = [assunto, guiche, servicos].includes(document.activeElement);
      const novo = (s.em_atendimento?.id ?? null) !== idAberta;
      if (novo && s.em_atendimento && document.hidden) document.title = `● Senha ${s.em_atendimento.codigo} para você`;
      marcarEncerrar(s);
      if (!digitando || novo) await pintar(s);
    } catch { /* tenta de novo no próximo sinal */ } finally { lendo = false; }
  }, 4000);
  const titulo = document.title;
  const voltou = () => { if (!document.hidden) document.title = titulo; };
  document.addEventListener('visibilitychange', voltou);
  ctx.parar(() => { pararRelogio(); clearInterval(sinal); document.removeEventListener('visibilitychange', voltou); document.title = titulo; });
  corpo.repintar = () => { totem = null; idAberta = undefined; return pintar(); };
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
