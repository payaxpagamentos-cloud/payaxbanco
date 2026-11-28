import { api, BASE, sessao } from './api.js';
import { el, limpar, toast, acao, modal, lerForm, dinheiro, dataBR, dataHora, numero, duracao, confirmar, QUALIDADES, hojeLocal, somarDias } from './ui.js';
import { cabeca, indicador, tabela, td, botao, campo, area, escolha, caixaSim, barras } from './admin-ui.js';

/** Telas de negócio do painel: assinantes, faturas, planos, relatórios, equipe, configurações e auditoria. */

const STATUS_ASSINATURA = { ativa: 'ok', pendente: 'aviso', suspensa: 'erro', cancelada: '' };
const etiquetaStatus = (s) => (s ? el('span', { class: `etiqueta ${STATUS_ASSINATURA[s] ?? ''}` }, s) : el('span', { class: 'etiqueta' }, 'sem assinatura'));

/** Abre um arquivo gerado pela API (CSV) levando o token da sessão. */
async function baixar(caminho, nome) {
  const resp = await fetch(`${BASE}/api${caminho}`, { headers: { Authorization: `Bearer ${sessao.get().token}` } });
  if (!resp.ok) throw new Error('Não foi possível gerar o arquivo.');
  const url = URL.createObjectURL(await resp.blob());
  const a = el('a', { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Senha sorteada de 12 caracteres, sem O/0 e I/l — para ninguém errar ao ditar por telefone. */
function senhaSorteada() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => letras[b % letras.length]).join('');
}

/** Mostra a senha uma vez, para a operação anotar e repassar. Depois dela só dá para trocar. */
const mostrarSenha = (nome, senha) => modal('Senha de acesso', (fechar) => [
  el('p', { class: 'mudo' }, `Passe esta senha para ${nome}. Ela aparece só agora: no banco fica cifrada.`),
  el('div', { class: 'copiavel', style: 'font-size:16px', onclick: (e) => {
    navigator.clipboard?.writeText(senha);
    e.currentTarget.style.borderColor = '#22C58B';
    toast('Senha copiada.');
  } }, senha),
  el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Anotei')),
]);

// ---------------------------------------------------------------- Assinantes

async function telaAssinantes(c) {
  const filtros = { status: '', q: '' };
  const corpo = el('div');

  const abrirAssinante = async (id) => {
    const d = await api.get(`/admin/assinantes/${id}`);
    const planos = (await api.get('/admin/planos')).planos;
    return modal(d.assinante.nome, (fechar) => {
      const acoes = el('div', { class: 'linha', style: 'margin-top:14px' });
      const trocarPlano = el('select', {}, planos.map((p) => el('option', {
        value: p.id, ...(p.id === d.assinatura.plano?.id ? { selected: true } : {}),
      }, `${p.nome} · ${dinheiro(p.preco_centavos)}`)));
      const dataCortesia = el('input', { type: 'date' });

      acoes.append(
        botao('Aplicar plano', 'primario', async () => {
          await api.post(`/admin/assinantes/${id}/assinatura`, {
            plano_id: Number(trocarPlano.value),
            ...(dataCortesia.value ? { acesso_ate: dataCortesia.value } : {}),
          });
          toast('Assinatura atualizada.');
          fechar('salvo');
        }),
        botao(d.assinante.ativo ? 'Desativar conta' : 'Reativar conta', 'vazio', async () => {
          await api.patch(`/admin/assinantes/${id}`, { ativo: !d.assinante.ativo });
          fechar('salvo');
        }),
        botao('Nova senha', 'vazio', async () => {
          const nova = senhaSorteada();
          await api.patch(`/admin/assinantes/${id}`, { senha: nova });
          await modal('Senha provisória', (f2) => [
            el('p', { class: 'mudo' }, `Passe esta senha para ${d.assinante.nome}. Ela só aparece agora.`),
            el('div', { class: 'copiavel', style: 'font-size:16px' }, nova),
            el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => f2(true) }, 'Anotei')),
          ]);
        }),
        d.assinatura.status && d.assinatura.status !== 'cancelada' ? botao('Cancelar assinatura', 'perigo', async () => {
          if (!await confirmar('Cancelar assinatura', 'O acesso vai até o fim do período já pago. Continuar?', 'Cancelar assinatura', true)) return;
          await api.post(`/admin/assinantes/${id}/cancelar`, {});
          fechar('salvo');
        }) : null);

      return [
        el('div', { class: 'indicadores', style: 'margin-bottom:14px' },
          indicador('Situação', d.assinatura.status ?? 'sem assinatura', d.assinatura.plano?.nome ?? '—', true),
          indicador('Acesso até', d.assinatura.acesso_ate ? dataBR(d.assinatura.acesso_ate) : '—', d.assinatura.proxima_cobranca ? `cobra em ${dataBR(d.assinatura.proxima_cobranca)}` : null),
          indicador('Assistiu (30 dias)', duracao(d.audiencia.segundos), `${d.audiencia.sessoes} sessões`),
          indicador('Telas agora', d.telas.length)),
        el('div', { class: 'cartao fundo' },
          el('div', { class: 'pequeno mudo' }, `${d.assinante.email}${d.assinante.telefone ? ` · ${d.assinante.telefone}` : ''}`),
          el('div', { class: 'pequeno mudo' }, `cliente desde ${dataBR(d.assinante.criado_em)}${d.assinante.ultimo_acesso ? ` · último acesso ${dataHora(d.assinante.ultimo_acesso)}` : ''}`),
          el('div', { class: 'linha', style: 'margin-top:8px;gap:6px' }, d.perfis.map((p) => el('span', { class: 'etiqueta' }, p.nome, p.infantil ? ' · infantil' : '')))),
        el('h3', { style: 'margin-top:16px' }, 'Faturas'),
        // A confirmação do pagamento fica aqui também, e não só na tela de Faturas: quando a
        // operação recebe o PIX, é nesta ficha que ela está — e é um clique só para liberar.
        tabela(['Competência', 'Vencimento', '>Valor', 'Situação', '>Ações'], d.faturas.slice(0, 8).map((f) => el('tr', {},
          td(f.competencia), td(dataBR(f.vencimento)), td(dinheiro(f.valor_centavos), true),
          td(el('span', { class: `etiqueta ${f.status === 'paga' ? 'ok' : f.status === 'aberta' ? 'aviso' : ''}` }, f.status)),
          td(el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
            f.status === 'aberta' ? botao('Confirmar pagamento', 'primario', async () => {
              if (!await confirmar('Confirmar pagamento',
                `Dar ${dinheiro(f.valor_centavos)} como recebido de ${d.assinante.nome}? O acesso é liberado na hora e a próxima cobrança é remarcada.`,
                'Confirmar')) return;
              await api.post(`/admin/faturas/${f.id}/confirmar`);
              toast('Pagamento confirmado e acesso liberado.');
              fechar('salvo');
            }) : null,
            f.status === 'aberta' ? botao('Cancelar fatura', 'perigo', async () => {
              if (!await confirmar('Cancelar fatura', 'A cobrança some e o acesso não é liberado. Continuar?', 'Cancelar fatura', true)) return;
              await api.post(`/admin/faturas/${f.id}/cancelar`, {});
              fechar('salvo');
            }) : null), true))), 'Sem faturas.'),
        el('h3', { style: 'margin-top:16px' }, 'Mudar plano ou liberar acesso'),
        el('div', { class: 'duas' },
          el('label', { class: 'campo' }, 'Plano', trocarPlano),
          el('label', { class: 'campo' }, 'Liberar acesso até (cortesia, sem fatura)', dataCortesia)),
        acoes,
      ];
    }, { largo: true });
  };

  const carregar = async () => {
    const params = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v));
    const { assinantes } = await api.get(`/admin/assinantes?${params}`);
    limpar(corpo, tabela(['Assinante', 'Plano', 'Situação', 'Acesso até', 'Faturas', '>Ações'],
      assinantes.map((a) => el('tr', {},
        td(el('div', {}, el('strong', {}, a.nome), el('div', { class: 'mini apagado' }, a.email))),
        td(a.plano ?? '—'),
        td(el('div', { class: 'linha', style: 'gap:5px' }, etiquetaStatus(a.status),
          a.ativo ? null : el('span', { class: 'etiqueta erro' }, 'conta desativada'),
          a.cancelar_no_fim ? el('span', { class: 'etiqueta aviso' }, 'cancela no fim') : null)),
        td(a.acesso_ate ? dataBR(a.acesso_ate) : '—'),
        td(a.faturas_abertas ? el('span', { class: 'etiqueta aviso' }, `${a.faturas_abertas} em aberto`) : el('span', { class: 'etiqueta ok' }, 'em dia')),
        td(botao('Abrir', 'vazio', async () => { if (await abrirAssinante(a.id)) carregar(); }), true))),
      'Nenhum assinante com esses filtros.'));
  };

  const busca = el('input', { type: 'search', placeholder: 'Nome ou e-mail' });
  busca.addEventListener('input', () => { filtros.q = busca.value.trim(); carregar(); });

  const novoAssinante = async () => {
    const planos = (await api.get('/admin/planos')).planos;
    return modal('Novo assinante', (fechar) => {
      const f = el('form', { class: 'form' },
        campo('Nome completo', { name: 'nome', required: true, maxlength: 120, autocomplete: 'off' }),
        campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'off' },
          'É com ele que a pessoa entra no app.'),
        campo('Celular com DDD (opcional)', { name: 'telefone', type: 'tel', placeholder: '(11) 99999-0000' }),
        escolha('Plano', 'plano_id', [['', 'Sem plano (entra, mas não assiste)'],
          ...planos.map((p) => [p.id, `${p.nome} · ${dinheiro(p.preco_centavos)}`])], ''),
        campo('Liberar acesso até (teste ou cortesia, sem fatura)', { name: 'acesso_ate', type: 'date' },
          'Em branco: segue a cobrança normal do plano.'),
        campo('Senha (opcional)', { name: 'senha', minlength: 8, autocomplete: 'new-password' },
          'Em branco, a plataforma sorteia uma e mostra na tela.'));

      const criar = botao('Criar assinante', 'primario', async () => {
        if (!f.reportValidity()) return;
        const d = lerForm(f);
        const r = await api.post('/admin/assinantes', {
          nome: d.nome,
          email: d.email,
          ...(d.telefone ? { telefone: d.telefone } : {}),
          ...(d.plano_id ? { plano_id: Number(d.plano_id) } : {}),
          ...(d.acesso_ate ? { acesso_ate: d.acesso_ate } : {}),
          ...(d.senha ? { senha: d.senha } : {}),
        });
        fechar('salvo');
        await mostrarSenha(r.assinante.nome, r.senha);
        toast('Assinante cadastrado.');
      });
      return [f, el('div', { class: 'linha fim', style: 'margin-top:14px' },
        el('button', { class: 'btn vazio', type: 'button', onclick: () => fechar(false) }, 'Cancelar'), criar)];
    });
  };

  limpar(c, cabeca('Assinantes',
    botao('Novo assinante', 'primario', async () => { if (await novoAssinante()) carregar(); }, 'mais')),
    el('div', { class: 'filtros' },
      escolha('Situação', 'status', [['', 'Todas'], ['ativa', 'Ativas'], ['pendente', 'Aguardando pagamento'], ['suspensa', 'Suspensas'], ['cancelada', 'Canceladas']], '',
        { onchange: (e) => { filtros.status = e.target.value; carregar(); } }),
      el('label', { class: 'campo' }, 'Buscar', busca)),
    corpo);
  await carregar();
}

// ---------------------------------------------------------------- Faturas

async function telaFaturas(c) {
  const filtros = { status: 'aberta', vencidas: '' };
  const corpo = el('div');

  const carregar = async () => {
    const params = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v));
    const { faturas, total_centavos: total } = await api.get(`/admin/faturas?${params}`);
    limpar(corpo,
      el('div', { class: 'indicadores', style: 'margin-bottom:16px' },
        indicador('Faturas listadas', faturas.length),
        indicador('Em aberto na lista', dinheiro(total), 'soma do que ainda não foi pago', true)),
      tabela(['Fatura', 'Assinante', 'Competência', 'Vencimento', '>Valor', 'Situação', '>Ações'],
        faturas.map((f) => el('tr', {},
          td(`#${f.id}`),
          td(el('div', {}, el('strong', {}, f.assinante), el('div', { class: 'mini apagado' }, `${f.email} · ${f.plano}`))),
          td(f.competencia),
          td(el('span', { class: f.status === 'aberta' && f.vencimento < hojeLocal() ? 'etiqueta erro' : '' }, dataBR(f.vencimento))),
          td(dinheiro(f.valor_centavos), true),
          td(el('span', { class: `etiqueta ${f.status === 'paga' ? 'ok' : f.status === 'aberta' ? 'aviso' : ''}` }, f.status)),
          td(el('div', { class: 'linha', style: 'gap:6px' },
            f.status === 'aberta' ? botao('Confirmar PIX', 'primario', async () => {
              if (!await confirmar('Confirmar pagamento', `Confirmar o recebimento de ${dinheiro(f.valor_centavos)} de ${f.assinante}? O acesso é liberado na hora.`, 'Confirmar')) return;
              await api.post(`/admin/faturas/${f.id}/confirmar`);
              toast('Pagamento confirmado e acesso liberado.');
              carregar();
            }) : null,
            f.status === 'aberta' ? botao('Cancelar', 'perigo', async () => {
              await api.post(`/admin/faturas/${f.id}/cancelar`, {});
              carregar();
            }) : null,
            f.txid ? el('span', { class: 'mini apagado', title: 'Identificador do PIX' }, f.txid) : null), true))),
        'Nenhuma fatura com esses filtros.'));
  };

  limpar(c, cabeca('Faturas',
    botao('Rodar cobrança agora', 'vazio', async () => {
      const r = await api.post('/admin/faturas/rodar-cobranca');
      toast(`${r.faturas} fatura(s) gerada(s), ${r.suspensas} suspensa(s), ${r.encerradas} encerrada(s).`);
      carregar();
    }),
    botao('Baixar CSV', 'vazio', async () => baixar(`/admin/faturas?csv=1&${new URLSearchParams(Object.entries(filtros).filter(([, v]) => v))}`, 'faturas.csv'))),
  el('div', { class: 'filtros' },
    escolha('Situação', 'status', [['', 'Todas'], ['aberta', 'Em aberto'], ['paga', 'Pagas'], ['cancelada', 'Canceladas']], 'aberta',
      { onchange: (e) => { filtros.status = e.target.value; carregar(); } }),
    escolha('Vencimento', 'vencidas', [['', 'Todos'], ['1', 'Só as vencidas']], '',
      { onchange: (e) => { filtros.vencidas = e.target.value; carregar(); } })),
  corpo);
  await carregar();
}

// ---------------------------------------------------------------- Planos

async function telaPlanos(c) {
  const { planos } = await api.get('/admin/planos');

  const formPlano = (p = null) => modal(p ? `Plano ${p.nome}` : 'Novo plano', (fechar) => {
    const f = el('form', { class: 'form' },
      el('div', { class: 'duas' },
        campo('Nome', { name: 'nome', required: true, maxlength: 60, value: p?.nome ?? '' }),
        campo('Preço (R$)', { name: 'preco', type: 'number', step: '0.01', min: 0, required: true, value: p ? (p.preco_centavos / 100).toFixed(2) : '' })),
      area('Descrição que aparece na vitrine', { name: 'descricao', rows: 2, maxlength: 400 }),
      el('div', { class: 'tres' },
        campo('Telas ao mesmo tempo', { name: 'telas', type: 'number', min: 1, max: 10, value: p?.telas ?? 1 }),
        campo('Perfis', { name: 'perfis_max', type: 'number', min: 1, max: 10, value: p?.perfis_max ?? 4 }),
        escolha('Qualidade', 'qualidade', Object.entries(QUALIDADES), p?.qualidade ?? 'hd')),
      el('div', { class: 'tres' },
        escolha('Cobrança', 'periodicidade', [['mensal', 'Mensal'], ['anual', 'Anual']], p?.periodicidade ?? 'mensal'),
        campo('Nível (conteúdo exclusivo)', { name: 'nivel', type: 'number', min: 1, max: 9, value: p?.nivel ?? 1 }),
        campo('Ordem na vitrine', { name: 'ordem', type: 'number', min: 0, max: 999, value: p?.ordem ?? 1 })),
      caixaSim('Permite downloads', 'downloads', Boolean(p?.downloads)),
      caixaSim('Inclui os canais ao vivo', 'canais_ao_vivo', p ? Boolean(p.canais_ao_vivo) : true),
      caixaSim('À venda na vitrine', 'ativo', p ? Boolean(p.ativo) : true),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, 'Salvar plano')));
    f.querySelector('textarea[name=descricao]').value = p?.descricao ?? '';
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      const corpo = {
        nome: d.nome,
        descricao: d.descricao || null,
        preco_centavos: Math.round(Number(String(d.preco).replace(',', '.')) * 100),
        periodicidade: d.periodicidade,
        telas: Number(d.telas),
        perfis_max: Number(d.perfis_max),
        qualidade: d.qualidade,
        nivel: Number(d.nivel),
        ordem: Number(d.ordem),
        downloads: Boolean(d.downloads),
        canais_ao_vivo: Boolean(d.canais_ao_vivo),
        ativo: Boolean(d.ativo),
      };
      acao(f.querySelector('button.primario'), async () => {
        if (p) await api.patch(`/admin/planos/${p.id}`, corpo);
        else await api.post('/admin/planos', corpo);
        fechar('salvo');
      });
    });
    return f;
  });

  limpar(c, cabeca('Planos', botao('Novo plano', 'primario', async () => { if (await formPlano()) telaPlanos(c); }, 'mais')),
    el('div', { class: 'aviso', style: 'margin-bottom:16px' },
      'O nível decide o conteúdo exclusivo: um título ou canal marcado com um plano só abre para quem assina esse plano ou outro de nível igual ou maior.'),
    tabela(['Plano', '>Preço', 'Telas', 'Qualidade', 'Extras', 'Assinantes', 'Situação', '>Ações'],
      planos.map((p) => el('tr', {},
        td(el('div', {}, el('strong', {}, p.nome), el('div', { class: 'mini apagado' }, `nível ${p.nivel} · ${p.periodicidade}`))),
        td(dinheiro(p.preco_centavos), true),
        td(p.telas),
        td(QUALIDADES[p.qualidade] ?? p.qualidade),
        td(el('div', { class: 'linha', style: 'gap:5px' },
          p.downloads ? el('span', { class: 'etiqueta ok' }, 'downloads') : null,
          p.canais_ao_vivo ? el('span', { class: 'etiqueta info' }, 'canais') : el('span', { class: 'etiqueta' }, 'só catálogo'),
          el('span', { class: 'etiqueta' }, `${p.perfis_max} perfis`))),
        td(numero(p.assinaturas_ativas)),
        td(p.ativo ? el('span', { class: 'etiqueta ok' }, 'à venda') : el('span', { class: 'etiqueta' }, 'fora da vitrine')),
        td(botao('Editar', 'vazio', async () => { if (await formPlano(p)) telaPlanos(c); }), true)))));
}

// ---------------------------------------------------------------- Relatórios

async function telaRelatorios(c) {
  const periodo = { de: somarDias(hojeLocal(), -29), ate: hojeLocal() };
  const corpo = el('div');

  const carregar = async () => {
    const qs = `de=${periodo.de}&ate=${periodo.ate}`;
    const [aud, fin] = await Promise.all([
      api.get(`/admin/relatorios/audiencia?${qs}`),
      api.get('/admin/relatorios/financeiro').catch(() => null),
    ]);
    const totalMin = aud.por_dia.reduce((s, d) => s + d.minutos, 0);
    const totalSessoes = aud.por_dia.reduce((s, d) => s + d.sessoes, 0);
    limpar(corpo,
      el('div', { class: 'indicadores', style: 'margin-bottom:16px' },
        indicador('Minutos assistidos', numero(totalMin), `${(totalMin / 60).toFixed(0)} horas no período`, true),
        indicador('Telas abertas', numero(totalSessoes)),
        indicador('Média por dia', numero(Math.round(totalMin / Math.max(1, aud.por_dia.length))), 'minutos'),
        fin ? indicador('Receita recorrente', dinheiro(fin.painel?.mrr_centavos ?? 0), 'por mês') : null),
      el('h2', {}, 'Audiência por dia'),
      barras(aud.por_dia, { valor: (d) => d.minutos, rotulo: (d) => dataBR(d.dia), unidade: 'min' }),
      el('h2', { style: 'margin-top:24px' }, 'Por hora do dia'),
      barras(aud.por_hora, { valor: (d) => d.minutos, rotulo: (d) => `${String(d.hora).padStart(2, '0')}h`, unidade: 'min' }),
      el('div', { class: 'grade', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:24px' },
        el('div', {}, el('h2', {}, 'Títulos mais assistidos'),
          tabela(['Título', '>Minutos', '>Telas'], aud.titulos.map((t) => el('tr', {},
            td(el('div', {}, el('strong', {}, t.nome), el('div', { class: 'mini apagado' }, t.tipo))),
            td(numero(t.minutos), true), td(numero(t.sessoes), true))), 'Sem audiência no período.')),
        el('div', {}, el('h2', {}, 'Canais mais assistidos'),
          tabela(['Canal', '>Minutos', '>Telas'], aud.canais.map((t) => el('tr', {},
            td(el('div', {}, el('strong', {}, t.nome), el('div', { class: 'mini apagado' }, `canal ${t.numero}`))),
            td(numero(t.minutos), true), td(numero(t.sessoes), true))), 'Sem audiência no período.'))),
      el('h2', { style: 'margin-top:24px' }, 'Aparelhos'),
      tabela(['Aparelho', '>Telas', '>Minutos'], aud.por_dispositivo.map((d) => el('tr', {},
        td(d.dispositivo), td(numero(d.sessoes), true), td(numero(d.minutos), true))), 'Sem dados.'),
      fin ? el('div', {}, el('h2', { style: 'margin-top:24px' }, 'Financeiro por competência'),
        tabela(['Competência', '>Faturas', '>Cobrado', '>Pago', '>Em aberto'], fin.competencias.map((f) => el('tr', {},
          td(f.competencia), td(numero(f.faturas), true), td(dinheiro(f.cobrado_centavos), true),
          td(dinheiro(f.pago_centavos), true),
          td(f.aberto_centavos ? el('span', { class: 'etiqueta aviso' }, dinheiro(f.aberto_centavos)) : dinheiro(0), true))), 'Sem faturas.'),
      el('h2', { style: 'margin-top:24px' }, 'Por plano'),
      tabela(['Plano', '>Assinaturas', '>Ativas', '>Receita/mês'], fin.planos.map((p) => el('tr', {},
        td(p.nome), td(numero(p.assinaturas), true), td(numero(p.ativas), true), td(dinheiro(p.receita_centavos), true))), 'Sem planos.')) : null);
  };

  const de = el('input', { type: 'date', value: periodo.de });
  const ate = el('input', { type: 'date', value: periodo.ate });
  const mudar = () => { periodo.de = de.value; periodo.ate = ate.value; carregar(); };
  de.addEventListener('change', mudar);
  ate.addEventListener('change', mudar);

  limpar(c, cabeca('Relatórios',
    botao('Audiência em CSV', 'vazio', async () => baixar(`/admin/relatorios/audiencia.csv?de=${periodo.de}&ate=${periodo.ate}`, 'audiencia.csv')),
    botao('Financeiro em CSV', 'vazio', async () => baixar('/admin/relatorios/financeiro.csv', 'financeiro.csv'))),
  el('div', { class: 'filtros' }, el('label', { class: 'campo' }, 'De', de), el('label', { class: 'campo' }, 'Até', ate)),
  corpo);
  await carregar();
}

// ---------------------------------------------------------------- Equipe

async function telaEquipe(c) {
  const { equipe } = await api.get('/admin/equipe');
  const formPessoa = (u = null) => modal(u ? u.nome : 'Nova pessoa na equipe', (fechar) => {
    const f = el('form', { class: 'form' },
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: u?.nome ?? '' }),
      u ? null : campo('E-mail', { name: 'email', type: 'email', required: true }),
      escolha('Perfil de acesso', 'perfil', [['curador', 'Curadoria (conteúdo e grade)'], ['admin', 'Administrador (tudo)']], u?.perfil ?? 'curador'),
      campo(u ? 'Nova senha (em branco mantém)' : 'Senha (mínimo 8)', { name: 'senha', type: 'password', minlength: 8, ...(u ? {} : { required: true }) }),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Cancelar'),
        el('button', { class: 'btn primario' }, 'Salvar')));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      acao(f.querySelector('button.primario'), async () => {
        if (u) {
          await api.patch(`/admin/equipe/${u.id}`, { nome: d.nome, perfil: d.perfil, ...(d.senha ? { senha: d.senha } : {}) });
        } else {
          await api.post('/admin/equipe', { nome: d.nome, email: d.email, perfil: d.perfil, senha: d.senha });
        }
        fechar('salvo');
      });
    });
    return f;
  });

  limpar(c, cabeca('Equipe', botao('Nova pessoa', 'primario', async () => { if (await formPessoa()) telaEquipe(c); }, 'mais')),
    el('div', { class: 'aviso', style: 'margin-bottom:16px' },
      'Curadoria cuida de canais, grade, catálogo e home. Administrador vê também assinantes, faturas, planos, relatórios e configurações.'),
    tabela(['Nome', 'E-mail', 'Perfil', 'Situação', 'Último acesso', '>Ações'],
      equipe.map((u) => el('tr', {},
        td(el('strong', {}, u.nome)), td(u.email),
        td(el('span', { class: `etiqueta ${u.perfil === 'admin' ? 'info' : ''}` }, u.perfil === 'admin' ? 'administrador' : 'curadoria')),
        td(u.ativo ? el('span', { class: 'etiqueta ok' }, 'ativo') : el('span', { class: 'etiqueta erro' }, 'desativado')),
        td(u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca entrou'),
        td(el('div', { class: 'linha', style: 'gap:6px' },
          botao('Editar', 'vazio', async () => { if (await formPessoa(u)) telaEquipe(c); }),
          botao(u.ativo ? 'Desativar' : 'Reativar', u.ativo ? 'perigo' : 'vazio', async () => {
            await api.patch(`/admin/equipe/${u.id}`, { ativo: !u.ativo });
            telaEquipe(c);
          })), true)))));
}

// ---------------------------------------------------------------- Configurações

async function telaConfig(c) {
  const { config, servidor } = await api.get('/admin/config');
  const f = el('form', { class: 'form' },
    el('h2', {}, 'Cobrança por PIX'),
    el('div', { class: 'tres' },
      campo('Chave PIX da plataforma', { name: 'pix_chave', maxlength: 120, value: config.pix_chave ?? '' }),
      campo('Nome do recebedor', { name: 'pix_recebedor', maxlength: 60, value: config.pix_recebedor ?? '' }),
      campo('Cidade do recebedor', { name: 'pix_cidade', maxlength: 40, value: config.pix_cidade ?? '' })),
    el('div', { class: 'duas' },
      campo('Carência antes de suspender (dias)', { name: 'carencia_dias', type: 'number', min: 0, max: 60, value: config.carencia_dias }),
      campo('Gerar a fatura com quantos dias de antecedência', { name: 'antecedencia_fatura_dias', type: 'number', min: 0, max: 30, value: config.antecedencia_fatura_dias })),
    el('h2', { style: 'margin-top:18px' }, 'Player'),
    el('div', { class: 'duas' },
      campo('Créditos finais (segundos) — marca como assistido', { name: 'creditos_s', type: 'number', min: 0, max: 1800, value: config.creditos_s }),
      campo('Voltar quantos segundos ao retomar', { name: 'retomar_folga_s', type: 'number', min: 0, max: 120, value: config.retomar_folga_s })),
    el('h2', { style: 'margin-top:18px' }, 'Grade dos canais abertos (EPG)'),
    campo('Endereço do arquivo XMLTV', { name: 'epg_url', maxlength: 1000, value: config.epg_url ?? '', placeholder: 'https://provedor-de-grade.exemplo/br.xml.gz' },
      'A plataforma busca este arquivo uma vez por dia e preenche a programação dos canais. Aceita .xml e .xml.gz. O provedor é escolhido por vocês (a emissora, a afiliada ou um serviço de grade).'),
    el('div', { class: 'linha' },
      (() => {
        const b = el('button', { type: 'button', class: 'btn pequeno' }, 'Importar a grade agora');
        b.addEventListener('click', () => acao(b, async () => {
          const url = f.querySelector('input[name=epg_url]').value.trim();
          if (!url) throw new Error('Cadastre o endereço do XMLTV primeiro.');
          const r = await api.post('/admin/epg/importar-url', { url });
          toast(`${r.importados} programa(s) importados em ${r.canais} canal(is).`);
        }));
        return b;
      })(),
      el('span', { class: 'pequeno mudo' }, config.epg_importado_em ? `última importação: ${dataHora(config.epg_importado_em)}` : 'nunca importada')),
    el('h2', { style: 'margin-top:18px' }, 'Canais ao vivo'),
    escolha('Canais sempre ligados', 'canais_quentes', [
      ['', `Padrão do servidor (${servidor.canais_quentes_padrao === 'todos' ? 'todos' : `os ${servidor.canais_quentes_padrao} mais assistidos`})`],
      ['0', 'Nenhum — todos abrem sob demanda'],
      ['10', 'Os 10 mais assistidos'],
      ['20', 'Os 20 mais assistidos'],
      ['40', 'Os 40 mais assistidos'],
      ['todos', 'Todos os canais'],
    ], config.canais_quentes ?? ''),
    el('p', { class: 'mini apagado', style: 'margin:-6px 0 0' },
      'Canal ligado abre na hora; canal desligado leva alguns segundos para entrar no ar. Cada canal ligado usa cerca de 60 MB de memória, '
      + '1,4% de um núcleo e a banda do próprio sinal entrando o dia inteiro, além de uma conexão permanente no fornecedor. '
      + `Este servidor tem agora ${Number(servidor.recursos.memoriaLivreMB).toLocaleString('pt-BR')} MB livres e ${Number(Number(servidor.recursos.nucleos).toFixed(1)).toLocaleString('pt-BR')} núcleo(s) para o app. `
      + 'Com "Todos", os canais sobem aos poucos, dos mais assistidos para os menos, e a plataforma para de ligar quando a memória ou o processador chegam ao limite — '
      + 'os que ficarem de fora continuam abrindo sob demanda. A tela Canais mostra quantos estão ligados.'),
    escolha('Atraso do sinal SRT', 'srt_atraso_ms', [
      ['', 'Como veio do fornecedor (normalmente 2 segundos)'],
      ['1000', 'No máximo 1 segundo'],
      ['500', 'No máximo meio segundo'],
    ], config.srt_atraso_ms ?? ''),
    el('p', { class: 'mini apagado', style: 'margin:-6px 0 0' },
      'É quanto a plataforma segura o sinal antes de usar, para repor pacote perdido no caminho. Menos atraso faz o canal desligado abrir mais cedo '
      + '(até 1,5 segundo a menos). Só diminua se a origem do fornecedor estiver na mesma rede deste servidor: com rede ruim entre os dois, a imagem pica. '
      + 'Se a origem exigir mais, vale o dela e esta opção não tem efeito. A mudança vale para os canais que ligarem depois de salvar.'),
    el('h2', { style: 'margin-top:18px' }, 'Aviso na home'),
    area('Mensagem para os assinantes (em branco não mostra nada)', { name: 'aviso_home', rows: 2, maxlength: 300 }),
    el('div', { class: 'linha fim' }, el('button', { class: 'btn primario' }, 'Salvar configurações')));
  f.querySelector('textarea[name=aviso_home]').value = config.aviso_home ?? '';
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = lerForm(f);
    acao(f.querySelector('button'), async () => {
      await api.put('/admin/config', {
        pix_chave: d.pix_chave,
        pix_recebedor: d.pix_recebedor,
        pix_cidade: d.pix_cidade,
        carencia_dias: Number(d.carencia_dias),
        antecedencia_fatura_dias: Number(d.antecedencia_fatura_dias),
        creditos_s: Number(d.creditos_s),
        retomar_folga_s: Number(d.retomar_folga_s),
        epg_url: d.epg_url,
        aviso_home: d.aviso_home,
        canais_quentes: d.canais_quentes ?? '',
        srt_atraso_ms: d.srt_atraso_ms ?? '',
      });
      toast('Configurações salvas.');
    });
  });

  limpar(c, cabeca('Configurações'),
    !config.pix_chave ? el('div', { class: 'aviso atencao', style: 'margin-bottom:16px' },
      'Sem a chave PIX, as faturas saem sem código de pagamento. Cadastre a chave da conta que recebe as assinaturas.') : null,
    el('div', { class: 'cartao' }, f),
    el('h2', { style: 'margin-top:24px' }, 'Servidor'),
    tabela(['Item', 'Valor'], [
      ['Marca', servidor.marca],
      ['Cobrança', servidor.pagamentos === 'simulado' ? 'simulado (teste: o assinante confirma na tela)' : 'manual (a operação confirma o PIX)'],
      ['Transmissão dos canais', servidor.relay_ligado ? 'ligada' : 'desligada (o player vai direto na origem)'],
      ['Tamanho máximo de vídeo', `${servidor.video_max_mb} MB`],
      ['Tela sem sinal de vida é encerrada em', `${servidor.telas_sem_sinal_s} segundos`],
      ['Pasta dos arquivos', servidor.midia_dir],
    ].map(([k, v]) => el('tr', {}, td(el('strong', {}, k)), td(el('span', { class: 'mudo' }, String(v)))))),
    el('h2', { style: 'margin-top:24px' }, 'Sistema'),
    el('p', { class: 'mudo', style: 'margin:0 0 12px' },
      'Atualize a plataforma enviando o pacote que você recebeu. Funciona pelo celular, sem precisar de SSH.'),
    await blocoSistema());
}

// ---------------------------------------------------------------- Sistema

/**
 * Atualização da plataforma pelo painel — serve para atualizar do celular, sem SSH.
 *
 * O painel só ENVIA o pacote; quem extrai e reconstrói é um agente que roda no servidor
 * (scripts/atualizador.sh, no cron). Enquanto ele trabalha a plataforma reinicia, então a tela
 * perde contato por alguns segundos: a espera abaixo conta com isso e fica tentando.
 */
async function blocoSistema() {
  const caixa = el('div', { class: 'cartao' });

  const desenhar = (s) => {
    const arquivo = el('input', { type: 'file', accept: '.zip,.gz,.tgz,application/zip,application/gzip,application/x-gzip' });
    // Senha de atualização: existe quando foi cadastrada no servidor. É conferida lá fora, pelo
    // agente — o painel só repassa o que foi digitado aqui.
    const senha = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Senha de atualização' });
    const enviar = botao('Enviar e atualizar', 'primario', async () => {
      const f = arquivo.files?.[0];
      if (!f) throw new Error('Escolha o arquivo .tar.gz da atualização.');
      if (s.exige_senha && !senha.value) throw new Error('Informe a senha de atualização.');
      if (!await confirmar('Atualizar a plataforma',
        `Vai ser aplicado o arquivo "${f.name}". A plataforma reinicia e fica alguns segundos fora do ar. `
        + 'O banco, os vídeos e o catálogo não são tocados. Continuar?', 'Atualizar agora')) return;
      // File é um Blob: o envio vai como corpo cru, igual ao das artes e dos vídeos.
      await api.post('/admin/sistema/pacote', f, {
        tipo: f.type || 'application/octet-stream',
        cabecalhos: s.exige_senha ? { 'X-Senha-Atualizacao': encodeURIComponent(senha.value) } : {},
      });
      toast('Pacote enviado. Aplicando…');
      await acompanhar(s.versao.versao);
    });

    limpar(caixa,
      el('div', { class: 'linha entre', style: 'flex-wrap:wrap;gap:10px' },
        el('div', {},
          el('div', { class: 'rotulo' }, 'Versão instalada'),
          el('div', { style: 'font-size:20px;font-weight:700' }, s.versao.versao),
          s.versao.gerado_em ? el('div', { class: 'mini apagado' }, `montada em ${dataHora(s.versao.gerado_em)}`) : null),
        s.ultima ? el('span', { class: `etiqueta ${s.ultima.situacao === 'concluida' ? 'ok' : 'erro'}` },
          s.ultima.situacao === 'concluida' ? 'última atualização concluída' : 'última atualização falhou') : null),
      s.ultima?.detalhe ? el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, s.ultima.detalhe) : null,
      !s.agente
        ? el('div', { class: 'aviso atencao', style: 'margin-top:14px' },
          'Esta instalação ainda não tem o agente de atualização. Faça uma atualização pelo servidor '
          + '(o instalador o coloca no lugar) e depois esta tela passa a funcionar.')
        : el('div', { style: 'margin-top:16px' },
          el('label', { class: 'campo' }, 'Pacote da atualização (.zip ou .tar.gz)', arquivo),
          el('p', { class: 'mini apagado', style: 'margin:6px 0 12px' },
            'Pelo celular: toque no campo, escolha o arquivo que você recebeu e envie. '
            + 'A atualização leva de 1 a 3 minutos e a plataforma volta sozinha.'),
          s.exige_senha
            ? el('label', { class: 'campo', style: 'margin-bottom:12px' }, 'Senha de atualização', senha,
              el('div', { class: 'mini apagado', style: 'margin-top:6px' },
                'É a senha cadastrada no servidor só para atualizar. Não é a do seu login.'))
            : el('div', { class: 'aviso atencao', style: 'margin-bottom:12px' },
              'Proteção recomendada: hoje, quem tiver a senha de um administrador consegue atualizar a plataforma — e um pacote '
              + 'de atualização manda no servidor inteiro. Para exigir uma senha separada a cada envio, rode uma vez no servidor: '
              + 'sudo bash /opt/playtechvip/scripts/atualizador.sh --senha'),
          el('div', { class: 'linha' }, enviar)),
      s.na_fila ? el('div', { class: 'aviso atencao', style: 'margin-top:14px' },
        `Há um pacote na fila, enviado por ${s.na_fila.por}. O servidor aplica em até um minuto.`) : null,
      s.registro ? el('details', { style: 'margin-top:14px' },
        el('summary', { class: 'pequeno mudo' }, 'Registro da última atualização'),
        el('pre', { class: 'mini', style: 'white-space:pre-wrap;max-height:240px;overflow:auto;margin:8px 0 0' }, s.registro)) : null);
  };

  /** Fica consultando até a versão mudar. A plataforma reinicia no meio, então falha é esperada. */
  const acompanhar = async (versaoAntes) => {
    const aviso = el('div', { class: 'aviso', style: 'margin-top:14px' }, 'Aplicando a atualização… a plataforma reinicia agora.');
    caixa.append(aviso);
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => { setTimeout(r, 2000); });
      try {
        const s = await api.get('/admin/sistema');
        if (s.versao.versao !== versaoAntes && !s.na_fila) {
          desenhar(s);
          toast(`Atualizada para ${s.versao.versao}.`);
          return;
        }
        if (s.ultima?.situacao === 'erro' && !s.na_fila) {
          desenhar(s);
          toast(s.ultima.detalhe || 'A atualização falhou.', true);
          return;
        }
      } catch { /* a plataforma está reiniciando: continuar tentando */ }
    }
    aviso.textContent = 'A atualização está demorando mais que o esperado. Recarregue a página em instantes.';
  };

  desenhar(await api.get('/admin/sistema'));
  return caixa;
}

// ---------------------------------------------------------------- Auditoria

async function telaAuditoria(c) {
  const { registros } = await api.get('/admin/auditoria?limite=300');
  limpar(c, cabeca('Auditoria'),
    el('p', { class: 'mudo' }, 'Tudo que a equipe fez no painel, com quem fez e de onde.'),
    tabela(['Quando', 'Quem', 'O que', 'Detalhes', 'IP'], registros.map((r) => el('tr', {},
      td(dataHora(r.criado_em)), td(r.usuario ?? 'sistema'),
      td(el('span', { class: 'etiqueta' }, r.acao)),
      td(el('span', { class: 'mini apagado' }, (r.detalhes ?? '').slice(0, 120))),
      td(el('span', { class: 'mini apagado' }, r.ip ?? '—')))), 'Nada registrado ainda.'));
}

export const TELAS_NEGOCIO = {
  assinantes: ['Assinantes', telaAssinantes, 'negocio', 'admin'],
  faturas: ['Faturas', telaFaturas, 'negocio', 'admin'],
  planos: ['Planos', telaPlanos, 'negocio', 'admin'],
  relatorios: ['Relatórios', telaRelatorios, 'negocio', 'admin'],
  equipe: ['Equipe', telaEquipe, 'plataforma', 'admin'],
  config: ['Configurações', telaConfig, 'plataforma', 'admin'],
  auditoria: ['Auditoria', telaAuditoria, 'plataforma', 'admin'],
};
