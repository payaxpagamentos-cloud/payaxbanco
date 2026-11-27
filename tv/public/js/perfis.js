import { api, perfil as perfilGuardado } from './api.js';
import { MASCOTES, urlMascote } from './mascotes.js';
import { el, marca, limpar, corPerfil, iniciais, icone, acao, toast, modal, lerForm, etiquetaIdade, CLASSIFICACOES } from './ui.js';

/** Tela "Quem está assistindo?" — perfis da conta, como nas TVs. */
export function telaPerfis(raiz, { aoEscolher, permitirSair = true, maximo = 4, aoSair }) {
  const grade = el('div', { class: 'perfis' });
  let editando = false;

  const escolher = async (p) => {
    if (!p.tem_pin) {
      perfilGuardado.set({ id: p.id, nome: p.nome, cor: p.cor, avatar: p.avatar, infantil: p.infantil });
      return aoEscolher(p);
    }
    const pin = await modal(`Perfil ${p.nome}`, (fechar) => {
      const campo = el('input', { type: 'password', inputmode: 'numeric', maxlength: 6, placeholder: '••••', style: 'letter-spacing:.4em;text-align:center;font-size:22px' });
      const f = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(campo.value); } },
        el('label', { class: 'campo' }, 'Digite o PIN deste perfil', campo),
        el('div', { class: 'linha fim' }, el('button', { class: 'btn primario' }, 'Entrar')));
      return f;
    });
    if (!pin) return undefined;
    try {
      const r = await api.post(`/conta/perfis/${p.id}/abrir`, { pin });
      perfilGuardado.set({ id: p.id, nome: p.nome, cor: p.cor, avatar: p.avatar, infantil: p.infantil, chave: r.chave });
      return aoEscolher(p);
    } catch (err) {
      toast(err.message, true);
      return undefined;
    }
  };

  const formPerfil = (p = null) => modal(p ? `Perfil ${p.nome}` : 'Novo perfil', (fechar) => {
    // Foto obrigatória: perfil sem cara fica sem identidade na hora de escolher quem vai assistir.
    // Já vem um escolhido, para ninguém travar na tela sem saber o que fazer.
    let avatar = p?.avatar ?? MASCOTES[0].id;
    const galeria = el('div', { class: 'mascotes' }, MASCOTES.map((m) => {
      const b = el('button', { type: 'button', class: `mascote${m.id === avatar ? ' on' : ''}`, title: m.nome, 'aria-label': m.nome },
        el('img', { src: urlMascote(m.id), alt: '' }));
      b.addEventListener('click', () => {
        avatar = m.id;
        [...galeria.children].forEach((x) => x.classList.toggle('on', x === b));
      });
      return b;
    }));

    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Foto do perfil', galeria),
      el('label', { class: 'campo' }, 'Nome do perfil', el('input', { name: 'nome', maxlength: 30, required: true, value: p?.nome ?? '' })),
      el('label', { class: 'campo linha-campo' }, el('input', { type: 'checkbox', name: 'infantil', ...(p?.infantil ? { checked: true } : {}) }), 'Perfil infantil (só conteúdo até 10 anos)'),
      el('label', { class: 'campo' }, 'Classificação máxima',
        el('select', { name: 'classificacao_max' }, Object.entries(CLASSIFICACOES).map(([valor, rotulo]) => el('option', {
          value: valor, ...(String(p?.classificacao_max ?? 18) === valor ? { selected: true } : {}),
        }, valor === '0' ? 'Livre' : `${rotulo} anos`)))),
      el('label', { class: 'campo' }, p?.tem_pin ? 'Novo PIN (em branco mantém o atual)' : 'PIN de 4 a 6 números (opcional)',
        el('input', { name: 'pin', inputmode: 'numeric', maxlength: 6, placeholder: p?.tem_pin ? 'PIN cadastrado' : 'sem PIN' })),
      p?.tem_pin ? el('label', { class: 'campo' }, 'PIN atual (para trocar ou tirar)', el('input', { name: 'pin_atual', inputmode: 'numeric', maxlength: 6 })) : null,
      el('div', { class: 'linha entre', style: 'margin-top:4px' },
        p && !p.principal ? el('button', {
          type: 'button',
          class: 'btn perigo pequeno',
          onclick: async (e) => {
            e.preventDefault();
            await acao(e.currentTarget, async () => { await api.del(`/conta/perfis/${p.id}`); fechar('apagado'); });
          },
        }, icone('lixeira'), 'Apagar perfil') : el('span'),
        el('button', { class: 'btn primario' }, p ? 'Salvar' : 'Criar perfil')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = {
        nome: d.nome,
        avatar,
        infantil: Boolean(d.infantil),
        classificacao_max: Number(d.classificacao_max),
        ...(d.pin ? { pin: d.pin, pin_atual: d.pin_atual ?? '' } : {}),
      };
      acao(f.querySelector('button.primario'), async () => {
        if (p) await api.patch(`/conta/perfis/${p.id}`, corpo);
        else await api.post('/conta/perfis', corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  const desenhar = async () => {
    const r = await api.get('/conta/perfis');
    limpar(grade, r.perfis.map((p) => {
      const b = el('button', { class: 'perfil-botao' },
        p.avatar
          ? el('span', { class: 'avatar g com-foto' }, el('img', { src: urlMascote(p.avatar), alt: '' }),
            editando ? el('span', { class: 'marca-editar' }, icone('engrenagem', 22)) : null)
          : el('span', { class: 'avatar g', style: `background:${corPerfil(p.nome, p.cor)}` }, editando ? icone('engrenagem', 26) : iniciais(p.nome)),
        el('span', {}, p.nome),
        el('span', { class: 'linha', style: 'justify-content:center;gap:5px' },
          p.infantil ? el('span', { class: 'etiqueta ok' }, 'infantil') : null,
          p.tem_pin ? el('span', { class: 'etiqueta' }, 'PIN') : null,
          etiquetaIdade(p.classificacao_max)));
      b.addEventListener('click', async () => {
        if (!editando) return escolher(p);
        const saida = await formPerfil(p);
        if (saida) await desenhar();
        return undefined;
      });
      return b;
    }),
    r.perfis.length < (r.maximo ?? maximo)
      ? el('button', {
        class: 'perfil-botao',
        onclick: async () => { if (await formPerfil()) await desenhar(); },
      }, el('span', { class: 'avatar g', style: 'background:var(--surface-3);color:var(--text-2)' }, icone('mais', 30)), el('span', {}, 'Novo perfil'))
      : null);
  };

  const botaoEditar = el('button', { class: 'btn vazio pequeno' }, icone('engrenagem'), 'Gerenciar perfis');
  botaoEditar.addEventListener('click', () => {
    editando = !editando;
    botaoEditar.replaceChildren(icone(editando ? 'certo' : 'engrenagem'), editando ? 'Pronto' : 'Gerenciar perfis');
    desenhar();
  });

  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa larga centro' },
    el('div', { class: 'linha', style: 'justify-content:center' }, marca()),
    el('h1', { style: 'margin:20px 0 22px' }, 'Quem está assistindo?'),
    grade,
    el('div', { class: 'linha', style: 'justify-content:center;margin-top:26px' },
      botaoEditar,
      permitirSair ? el('button', { class: 'btn vazio pequeno', onclick: aoSair }, 'Sair da conta') : null))));

  desenhar().catch((err) => toast(err.message, true));
}
