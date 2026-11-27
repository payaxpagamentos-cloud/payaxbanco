import { api, sessao, perfil as perfilGuardado, BASE } from './api.js';
import { botaoExcluirConta } from './excluir-conta.js';
import { el, limpar, icone, toast, acao, modal, lerForm, dinheiro, dataBR, dataHora, copiar, confirmar, QUALIDADES, corPerfil, iniciais } from './ui.js';

const STATUS = {
  ativa: ['Assinatura ativa', 'ok'],
  pendente: ['Aguardando pagamento', 'aviso'],
  suspensa: ['Suspensa por fatura em aberto', 'erro'],
  cancelada: ['Cancelada', 'erro'],
};

/** Minha conta: assinatura, faturas, perfis, telas e dados de acesso. */
export async function telaConta(raiz, { ir, aoMudar }) {
  limpar(raiz, el('div', { class: 'secao' }, el('div', { class: 'cartao vazio' }, 'Carregando…')));
  const [conta, faturas, telas] = await Promise.all([api.get('/conta'), api.get('/conta/faturas'), api.get('/conta/telas')]);
  const a = conta.assinatura;

  const recarregar = async () => { await telaConta(raiz, { ir, aoMudar }); aoMudar?.(); };

  const botaoExcluir = botaoExcluirConta();

  // ---- Assinatura
  const botoes = el('div', { class: 'linha', style: 'margin-top:14px' });
  if (a.ativa || a.status === 'suspensa' || a.status === 'pendente') {
    botoes.append(el('button', { class: 'btn', onclick: () => ir('#/planos') }, 'Trocar de plano'));
    if (a.cancelar_no_fim) {
      const b = el('button', { class: 'btn primario' }, 'Voltar a assinar');
      b.addEventListener('click', () => acao(b, async () => { await api.post('/conta/reativar'); toast('Que bom ter você de volta!'); await recarregar(); }));
      botoes.append(b);
    } else {
      const b = el('button', { class: 'btn perigo' }, 'Cancelar assinatura');
      b.addEventListener('click', () => acao(b, async () => {
        const motivo = await modal('Cancelar assinatura', (fechar) => {
          const f = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(lerForm(e.currentTarget).motivo || '-'); } },
            el('p', { class: 'mudo', style: 'margin:0' }, a.acesso_ate ? `Você continua assistindo até ${dataBR(a.acesso_ate)}.` : 'O acesso será encerrado.'),
            el('label', { class: 'campo' }, 'Conta pra gente o motivo (opcional)', el('input', { name: 'motivo', maxlength: 200 })),
            el('div', { class: 'linha fim' },
              el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar(null) }, 'Deixar como está'),
              el('button', { class: 'btn perigo' }, 'Confirmar cancelamento')));
          return f;
        });
        if (!motivo) return;
        const r = await api.post('/conta/cancelar', { motivo: motivo === '-' ? null : motivo });
        toast(r.aviso);
        await recarregar();
      }));
      botoes.append(b);
    }
  } else {
    botoes.append(el('button', { class: 'btn primario grande', onclick: () => ir('#/planos') }, 'Escolher um plano'));
  }

  const fatura = a.fatura_aberta;
  const caixaFatura = fatura ? el('div', { class: 'cartao fundo', style: 'margin-top:14px' },
    el('div', { class: 'linha entre' },
      el('div', {}, el('strong', {}, 'Fatura em aberto'), el('div', { class: 'pequeno mudo' }, `${fatura.descricao} · vence em ${dataBR(fatura.vencimento)}`)),
      el('strong', { class: 'num', style: 'font-size:19px' }, dinheiro(fatura.valor_centavos))),
    fatura.pix_copia_cola ? el('div', { class: 'coluna', style: 'margin-top:12px' },
      el('div', { class: 'copiavel' }, fatura.pix_copia_cola),
      el('div', { class: 'linha' },
        el('button', { class: 'btn pequeno', onclick: () => copiar(fatura.pix_copia_cola) }, 'Copiar código PIX'),
        el('a', { class: 'btn pequeno vazio', href: `${new URL('.', import.meta.url).pathname.replace(/\/js\/$/, '')}/api/conta/faturas/${fatura.id}/qr`, target: '_blank', rel: 'noopener' }, 'Ver QR Code'),
        conta.pagamentos === 'simulado' ? (() => {
          const b = el('button', { class: 'btn primario pequeno' }, 'Já paguei (teste)');
          b.addEventListener('click', () => acao(b, async () => { await api.post(`/conta/faturas/${fatura.id}/pagar`); toast('Acesso liberado!'); await recarregar(); }));
          return b;
        })() : null)) : el('div', { class: 'aviso atencao', style: 'margin-top:12px' }, 'A chave PIX ainda não foi cadastrada pela operação.')) : null;

  // ---- Telas em uso
  const caixaTelas = el('div', { class: 'coluna' }, telas.telas.length
    ? telas.telas.map((t) => el('div', { class: 'cartao fundo linha entre' },
      el('div', {}, el('strong', {}, t.o_que ?? 'Assistindo'), el('div', { class: 'pequeno mudo' }, `${t.dispositivo ?? 'Aparelho'} · desde ${dataHora(t.desde)}`)),
      el('span', { class: 'etiqueta vivo' }, 'assistindo')))
    : el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhuma tela assistindo agora.'));
  const botaoEncerrar = el('button', { class: 'btn pequeno perigo' }, 'Encerrar todas as telas');
  botaoEncerrar.addEventListener('click', () => acao(botaoEncerrar, async () => {
    if (!await confirmar('Encerrar telas', 'Quem estiver assistindo em outro aparelho será interrompido. Continuar?', 'Encerrar', true)) return;
    const r = await api.post('/conta/telas/encerrar', {});
    toast(`${r.encerradas} tela(s) encerrada(s).`);
    await recarregar();
  }));

  // ---- Dados da conta
  const formDados = el('form', { class: 'form' },
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', value: conta.usuario.nome, maxlength: 120, required: true })),
      el('label', { class: 'campo' }, 'Celular', el('input', { name: 'telefone', value: conta.usuario.telefone ?? '', type: 'tel' }))),
    el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', value: conta.usuario.email, type: 'email', required: true })),
    el('label', { class: 'campo' }, 'Senha atual (só para trocar o e-mail)',
      el('input', { name: 'senha_atual', type: 'password', autocomplete: 'current-password' })),
    el('div', { class: 'linha fim' }, el('button', { class: 'btn primario pequeno' }, 'Salvar dados')));
  formDados.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = lerForm(formDados);
    acao(formDados.querySelector('button'), async () => {
      await api.patch('/auth/me', {
        nome: d.nome, email: d.email, ...(d.telefone ? { telefone: d.telefone } : { telefone: null }),
        ...(d.senha_atual ? { senha_atual: d.senha_atual } : {}),
      });
      formDados.querySelector('input[name=senha_atual]').value = '';
      toast('Dados salvos.');
      const s = sessao.get();
      sessao.set({ ...s, usuario: { ...s.usuario, nome: d.nome, email: d.email } });
      aoMudar?.();
    });
  });

  const botaoSenha = el('button', { class: 'btn pequeno vazio' }, 'Trocar senha');
  botaoSenha.addEventListener('click', async () => {
    const dados = await modal('Trocar senha', (fechar) => {
      const f = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(lerForm(e.currentTarget)); } },
        el('label', { class: 'campo' }, 'Senha atual', el('input', { name: 'atual', type: 'password', required: true, autocomplete: 'current-password' })),
        el('label', { class: 'campo' }, 'Nova senha (mínimo 8)', el('input', { name: 'nova', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
        el('div', { class: 'linha fim' }, el('button', { class: 'btn primario' }, 'Trocar senha')));
      return f;
    });
    if (!dados) return;
    try {
      const r = await api.post('/auth/senha', dados);
      sessao.trocarToken(r?.token);
      toast('Senha trocada. Os outros aparelhos desta conta foram desconectados.');
    } catch (err) { toast(err.message, true); }
  });

  limpar(raiz, el('div', { class: 'secao', style: 'max-width:900px' },
    el('h1', {}, 'Minha conta'),
    el('div', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('div', {},
          el('div', { class: 'pequeno mudo' }, 'Plano'),
          el('h2', { style: 'margin:2px 0' }, a.plano?.nome ?? 'Sem plano'),
          a.plano ? el('div', { class: 'pequeno mudo' },
            `${dinheiro(a.plano.preco_centavos)}/mês · ${a.plano.telas} tela(s) · ${QUALIDADES[a.plano.qualidade] ?? a.plano.qualidade}${a.plano.downloads ? ' · downloads' : ''}`) : null),
        el('span', { class: `etiqueta ${STATUS[a.status]?.[1] ?? ''}` }, a.operacao ? 'Acesso da operação' : STATUS[a.status]?.[0] ?? 'Sem assinatura')),
      a.acesso_ate || a.proxima_cobranca ? el('div', { class: 'linha', style: 'margin-top:12px;gap:22px' },
        a.acesso_ate ? el('div', {}, el('div', { class: 'pequeno mudo' }, 'Acesso até'), el('strong', {}, dataBR(a.acesso_ate))) : null,
        a.proxima_cobranca && !a.cancelar_no_fim ? el('div', {}, el('div', { class: 'pequeno mudo' }, 'Próxima cobrança'), el('strong', {}, dataBR(a.proxima_cobranca))) : null) : null,
      a.cancelar_no_fim ? el('div', { class: 'aviso atencao', style: 'margin-top:12px' }, `Cancelamento agendado: você assiste até ${dataBR(a.acesso_ate)}.`) : null,
      a.aviso && !a.ativa ? el('div', { class: 'aviso erro', style: 'margin-top:12px' }, a.aviso) : null,
      caixaFatura,
      botoes),

    el('h2', { style: 'margin-top:26px' }, 'Perfis de visualização'),
    el('div', { class: 'cartao' },
      el('div', { class: 'linha' }, conta.perfis.map((p) => el('div', { class: 'linha firme', style: 'gap:8px' },
        el('span', { class: 'avatar', style: `background:${corPerfil(p.nome, p.cor)}` }, iniciais(p.nome)),
        el('span', {}, p.nome, p.infantil ? el('span', { class: 'etiqueta ok', style: 'margin-left:5px' }, 'infantil') : null)))),
      el('div', { class: 'linha', style: 'margin-top:12px' },
        el('button', { class: 'btn pequeno', onclick: () => { perfilGuardado.limpar(); ir('#/perfis'); } }, icone('engrenagem'), 'Gerenciar e trocar perfil'))),

    el('h2', { style: 'margin-top:26px' }, `Telas assistindo agora (${telas.telas.length} de ${telas.limite})`),
    el('div', { class: 'coluna' }, caixaTelas, telas.telas.length ? el('div', { class: 'linha' }, botaoEncerrar) : null),

    el('h2', { style: 'margin-top:26px' }, 'Faturas'),
    faturas.faturas.length ? el('div', { class: 'cartao', style: 'padding:0' }, el('div', { class: 'rolagem' }, el('table', { class: 'tabela' },
      el('thead', {}, el('tr', {}, ['Competência', 'Descrição', 'Vencimento', 'Valor', 'Situação'].map((c, i) => el('th', { class: i === 3 ? 'dir' : '' }, c)))),
      el('tbody', {}, faturas.faturas.map((f) => el('tr', {},
        el('td', {}, f.competencia),
        el('td', {}, f.descricao),
        el('td', {}, dataBR(f.vencimento)),
        el('td', { class: 'dir num' }, dinheiro(f.valor_centavos)),
        el('td', {}, el('span', { class: `etiqueta ${f.status === 'paga' ? 'ok' : f.status === 'aberta' ? 'aviso' : ''}` }, f.status)))))))) 
      : el('div', { class: 'cartao vazio' }, 'Nenhuma fatura ainda.'),

    el('h2', { style: 'margin-top:26px' }, 'Dados de acesso'),
    el('div', { class: 'cartao' }, formDados, el('div', { class: 'linha', style: 'margin-top:12px' }, botaoSenha,
      el('button', { class: 'btn pequeno vazio perigo', onclick: () => { sessao.limpar(); window.dispatchEvent(new CustomEvent('tv:sair')); } }, 'Sair da conta'))),

    el('h2', { style: 'margin-top:26px' }, 'Excluir minha conta'),
    el('div', { class: 'cartao' },
      el('p', { class: 'mudo', style: 'margin:0 0 12px' },
        'Apaga o cadastro, os perfis e o histórico de quem assistiu. A assinatura é cancelada na hora e o acesso acaba imediatamente. Não dá para desfazer.'),
      el('div', { class: 'linha' }, botaoExcluir)),

    el('p', { class: 'pequeno mudo', style: 'margin-top:22px' },
      el('a', { href: `${BASE}/privacidade.html`, target: '_blank', rel: 'noopener' }, 'Política de privacidade'),
      ' · ',
      el('a', { href: `${BASE}/termos.html`, target: '_blank', rel: 'noopener' }, 'Termos de uso'))));
}
