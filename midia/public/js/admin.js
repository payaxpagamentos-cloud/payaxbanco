/** Administração: usuários, configurações da plataforma, diagnóstico e histórico. */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, formModal, confirmar, perguntar, campo, escolha, marcar, lerForm,
  inteiro, dinheiro, dataHora, etiqueta, reaisCampo, centavos, repetir, PERFIS,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';

export async function usuarios(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get('/painel/usuarios');
    limpar(corpo, tabela([
      [(u) => el('div', {}, el('div', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email)), 'Usuário'],
      [(u) => PERFIS[u.perfil], 'Perfil'],
      [(u) => u.anunciante ?? u.ponto ?? '—', 'Vínculo'],
      [(u) => (u.ativo ? etiqueta('Ativo', 'ok') : etiqueta('Inativo', 'erro')), 'Situação'],
      [(u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca'), 'Último acesso'],
      [(u) => el('div', { class: 'acoes' },
        el('button', {
          class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
            const nova = await perguntar('Trocar senha', `Nova senha de ${u.nome} (mínimo 8 caracteres)`);
            if (!nova) return;
            await api.patch(`/painel/usuarios/${u.id}`, { senha: nova });
            toast('Senha trocada.');
          }),
        }, 'Senha'),
        el('button', {
          class: `btn pequeno${u.ativo ? ' perigo' : ''}`, onclick: (e) => acao(e.target, async () => {
            await api.patch(`/painel/usuarios/${u.id}`, { ativo: !u.ativo });
            toast(u.ativo ? 'Usuário desativado.' : 'Usuário ativado.');
            pintar();
          }),
        }, u.ativo ? 'Desativar' : 'Ativar')), '', 'acoes'],
    ], d.itens, { vazioTexto: 'Nenhum usuário.' }));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'Equipe (master e operador) e os acessos dos portais do anunciante e do lojista.'),
      el('button', { class: 'btn primario', onclick: () => novoUsuario(opcoes, pintar) }, icone('mais'), 'Novo usuário')),
    corpo);
  await pintar();
}

function novoUsuario(opcoes, recarregar) {
  return formModal('Novo usuário', () => {
    const perfil = escolha('Perfil', 'perfil', PERFIS, 'operador');
    const anunciante = escolha('Anunciante', 'anunciante_id', Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])), '');
    const ponto = escolha('Ponto', 'local_id', Object.fromEntries(opcoes.locais.map((l) => [l.id, l.nome])), '');
    anunciante.hidden = true;
    ponto.hidden = true;
    perfil.querySelector('select').addEventListener('change', (e) => {
      anunciante.hidden = e.target.value !== 'anunciante';
      ponto.hidden = e.target.value !== 'lojista';
    });
    return [
      campo('Nome', { name: 'nome', required: true, maxlength: 120 }),
      campo('E-mail (login)', { name: 'email', type: 'email', required: true }),
      campo('Senha (mínimo 8 caracteres)', { name: 'senha', type: 'password', required: true, minlength: 8 }),
      perfil, anunciante, ponto,
    ];
  }, async (d) => {
    await api.post('/painel/usuarios', d);
    toast('Usuário criado.');
    recarregar();
  });
}

export async function configuracoes(ctx) {
  const c = await api.get('/painel/configuracoes');
  const f = el('form', { class: 'form' },
    el('fieldset', {}, el('legend', {}, 'Plataforma'),
      campo('Nome que aparece no painel e nas TVs', { name: 'nome_plataforma', value: c.nome_plataforma, required: true, maxlength: 60 })),

    el('fieldset', {}, el('legend', {}, 'Programação das telas'),
      el('div', { class: 'duas' },
        campo('Duração padrão de uma imagem (segundos)', { name: 'duracao_imagem_s', type: 'number', min: 3, max: 120, value: c.duracao_imagem_s }),
        campo('Inserções por hora sugeridas numa campanha nova', { name: 'insercoes_hora_padrao', type: 'number', min: 1, max: 120, value: c.insercoes_hora_padrao })),
      el('div', { class: 'duas' },
        campo('Tempo mínimo do loop (segundos)', { name: 'bloco_minimo_s', type: 'number', min: 30, max: 3600, value: c.bloco_minimo_s }),
        campo('Tempo máximo do loop (segundos)', { name: 'bloco_maximo_s', type: 'number', min: 60, max: 7200, value: c.bloco_maximo_s })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'Abaixo do mínimo, o institucional completa o loop. Acima do máximo, as campanhas de menor prioridade perdem inserções.')),

    el('fieldset', {}, el('legend', {}, 'TVs'),
      el('div', { class: 'duas' },
        campo('A TV fala com o servidor a cada (segundos)', { name: 'batida_intervalo_s', type: 'number', min: 15, max: 900, value: c.batida_intervalo_s }),
        campo('Sem contato por (minutos) = offline', { name: 'offline_minutos', type: 'number', min: 2, max: 1440, value: c.offline_minutos })),
      marcar('O lojista pode escrever o aviso da faixa da própria TV', { name: 'aviso_lojista', checked: Boolean(c.aviso_lojista) })),

    el('fieldset', {}, el('legend', {}, 'Preços de tabela e faturamento'),
      el('div', { class: 'tres' },
        campo('Mensalidade por TV (R$)', { name: 'mensalidade', value: reaisCampo(c.mensalidade_tela_centavos), inputmode: 'decimal' }),
        campo('CPM — por mil impactos (R$)', { name: 'cpm', value: reaisCampo(c.cpm_centavos), inputmode: 'decimal' }),
        campo('Comissão sugerida ao lojista (%)', { name: 'comissao', value: (c.comissao_local_percentual / 100).toString().replace('.', ','), inputmode: 'decimal' })),
      el('div', { class: 'duas' },
        campo('Dia de vencimento das faturas', { name: 'vencimento_dia', type: 'number', min: 1, max: 28, value: c.vencimento_dia }),
        campo('Guardar a prova de exibição detalhada por (dias)', { name: 'prova_dias', type: 'number', min: 0, max: 3650, value: c.prova_dias })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O resumo por dia (relatórios e faturamento) nunca é apagado; 0 guarda todo o detalhe para sempre.')),

    el('fieldset', {}, el('legend', {}, 'PIX das faturas'),
      campo('Chave PIX', { name: 'pix_chave', value: c.pix_chave, maxlength: 80, placeholder: 'e-mail, CNPJ, telefone ou chave aleatória' }),
      el('div', { class: 'duas' },
        campo('Nome do recebedor', { name: 'pix_nome', value: c.pix_nome, maxlength: 60 }),
        campo('Cidade do recebedor', { name: 'pix_cidade', value: c.pix_cidade, maxlength: 40 })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Sem a chave, a fatura sai sem o código de pagamento.')),

    el('div', { class: 'linha entre' }, el('span', {}), el('button', { class: 'btn primario largo' }, 'Salvar configurações')));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button[class*=primario]'), async () => {
      const d = lerForm(f);
      const corpo = {
        ...d,
        aviso_lojista: d.aviso_lojista ? 1 : 0,
        mensalidade_tela_centavos: centavos(d.mensalidade) ?? 0,
        cpm_centavos: centavos(d.cpm) ?? 0,
        comissao_local_percentual: Math.round(Number(String(d.comissao).replace(',', '.')) * 100),
      };
      for (const k of ['mensalidade', 'cpm', 'comissao']) delete corpo[k];
      await api.put('/painel/configuracoes', corpo);
      toast('Configurações salvas.');
    });
  });
  limpar(ctx.conteudo, el('div', { class: 'cartao grande', style: 'max-width:860px' }, f));
}

export async function diagnostico(ctx) {
  const corpo = el('div', { class: 'coluna' });
  const pintar = async () => {
    const d = await api.get('/painel/diagnostico');
    const falhas = d.verificacoes.filter((v) => !v.ok).length;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'TVs ativas', valor: inteiro(d.telas.total), ic: 'telas' }),
        indicador({ rotulo: 'No ar agora', valor: inteiro(d.telas.online), ic: 'ok', cor: 'verde' }),
        indicador({ rotulo: 'Sem contato', valor: inteiro(d.telas.offline), ic: 'erro', cor: d.telas.offline ? 'vermelho' : 'azul' }),
        indicador({ rotulo: 'A parear', valor: inteiro(d.telas.sem_parear), ic: 'parear', cor: 'laranja' })),
      cartao(falhas ? `Verificações — ${falhas} ponto(s) de atenção` : 'Verificações — tudo em ordem',
        el('div', { class: 'checagens' }, d.verificacoes.map((v) => el('div', { class: `checagem${v.ok ? '' : ' falha'}` },
          el('span', { class: 'marca-ok' }, v.ok ? '✓' : '!'),
          el('div', {}, el('strong', {}, v.nome), el('p', {}, v.detalhe)))))));
  };
  await pintar();
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    el('div', { class: 'linha entre' }, el('p', { class: 'mudo', style: 'margin:0' }, 'Atualiza sozinho a cada minuto.'),
      el('button', { class: 'btn', onclick: (e) => acao(e.target, pintar) }, icone('relogio'), 'Atualizar agora')),
    corpo));
  ctx.parar(repetir(pintar, 60_000));
}

export async function historico(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const filtro = { acao: '', limite: 200 };
  const pintar = async () => {
    const d = await api.get(`/painel/auditoria${qs(filtro)}`);
    limpar(corpo, tabela([
      [(a) => dataHora(a.criado_em), 'Quando'],
      [(a) => a.usuario ?? 'sistema', 'Quem'],
      [(a) => a.acao.replace(/_/g, ' '), 'O que'],
      [(a) => (a.detalhes ? el('span', { class: 'pequeno mono mudo' }, a.detalhes.slice(0, 160)) : '—'), 'Detalhes'],
      [(a) => a.ip ?? '—', 'IP'],
    ], d.itens, { vazioTexto: 'Nada registrado ainda.' }));
  };
  let timer;
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      el('label', { class: 'campo' }, 'Filtrar ação', el('input', {
        placeholder: 'Ex.: fatura, tela, campanha', oninput: (e) => { filtro.acao = e.target.value; clearTimeout(timer); timer = setTimeout(pintar, 300); },
      }))),
    corpo);
  await pintar();
}
