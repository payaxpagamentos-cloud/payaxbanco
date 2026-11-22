/** Administração: usuários, configurações da plataforma, diagnóstico e histórico. */
import { api, qs, baixar, BASE, sessao } from './api.js';
import {
  el, limpar, icone, toast, acao, formModal, confirmar, perguntar, campo, escolha, marcar, lerForm,
  inteiro, dinheiro, dataHora, etiqueta, reaisCampo, centavos, repetir, mb, PERFIS,
} from './ui.js';
import { cartao, indicador, tabela, vazio, campoEmpresa, carregarEmpresas, listaDeEmpresas } from './comum.js';

export async function usuarios(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get('/painel/usuarios');
    limpar(corpo, tabela([
      [(u) => el('div', {}, el('div', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email)), 'Usuário'],
      [(u) => PERFIS[u.perfil], 'Perfil'],
      ctx.master ? [(u) => u.empresa ?? (u.perfil === 'master' ? 'Todas' : '—'), 'Empresa'] : null,
      [(u) => u.anunciante ?? u.ponto ?? '—', 'Vínculo'],
      [(u) => (u.ativo ? etiqueta('Ativo', 'ok') : etiqueta('Inativo', 'erro')), 'Situação'],
      [(u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca'), 'Último acesso'],
      [(u) => el('div', { class: 'acoes' },
        // Só o master mexe num master (o servidor também recusa).
        u.perfil !== 'master' || ctx.master
          ? el('button', { class: 'btn pequeno', onclick: () => editarUsuario(u, pintar, ctx.master) }, icone('editar'), 'Editar')
          : null,
        el('button', {
          class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
            const nova = await perguntar('Trocar senha', `Nova senha de ${u.nome} (mínimo 10 caracteres)`);
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
    ].filter(Boolean), d.itens, { vazioTexto: 'Nenhum usuário.' }));
  };
  if (ctx.master) await carregarEmpresas();

  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'Equipe (master, administrador e operador) e os acessos dos portais do anunciante e do lojista.'),
      el('button', { class: 'btn primario', onclick: () => novoUsuario(opcoes, pintar, ctx.master) }, icone('mais'), 'Novo usuário')),
    corpo);
  await pintar();
}

/** Empresas que usam o sistema (só o master): cada uma enxerga só os próprios dados. */
export async function empresas(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const pintar = async () => {
    const d = await api.get('/painel/empresas');
    limpar(corpo, tabela([
      [(e) => el('div', {}, el('div', {}, e.nome), e.documento ? el('div', { class: 'pequeno mudo' }, e.documento) : null), 'Empresa'],
      [(e) => inteiro(e.pontos), 'Pontos', 'num'],
      [(e) => inteiro(e.telas), 'TVs', 'num'],
      [(e) => inteiro(e.anunciantes), 'Anunciantes', 'num'],
      [(e) => inteiro(e.usuarios), 'Equipe', 'num'],
      [(e) => (e.ativo ? etiqueta('Ativa', 'ok') : etiqueta('Desativada', 'erro')), 'Situação'],
      [(e) => el('div', { class: 'acoes' },
        el('button', { class: 'btn pequeno', onclick: () => editarEmpresa(e, pintar) }, icone('editar'), 'Editar'),
        el('button', {
          class: `btn pequeno${e.ativo ? ' perigo' : ''}`, onclick: (ev) => acao(ev.target, async () => {
            if (e.ativo && !await confirmar('Desativar empresa', `A equipe de ${e.nome} deixa de entrar no sistema. Os dados ficam guardados.`, 'Desativar')) return;
            await api.patch(`/painel/empresas/${e.id}`, { ativo: !e.ativo });
            toast(e.ativo ? 'Empresa desativada.' : 'Empresa ativada.');
            pintar();
          }),
        }, e.ativo ? 'Desativar' : 'Ativar')), '', 'acoes'],
    ], d.itens, { vazioTexto: 'Nenhuma empresa.' }));
  };
  limpar(ctx.conteudo,
    el('div', { class: 'linha entre', style: 'margin-bottom:16px' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'Cada empresa enxerga só os próprios pontos, TVs, clientes, campanhas e financeiro. O master vê todas.'),
      el('button', { class: 'btn primario', onclick: () => editarEmpresa(null, pintar) }, icone('mais'), 'Nova empresa')),
    corpo);
  await pintar();
}

function editarEmpresa(e, recarregar) {
  return formModal(e ? `Editar ${e.nome}` : 'Nova empresa', () => [
    campo('Nome', { name: 'nome', value: e?.nome ?? '', required: true, maxlength: 120 }),
    campo('CNPJ (opcional)', { name: 'documento', value: e?.documento ?? '', maxlength: 20 }),
  ], async (d) => {
    if (e) await api.patch(`/painel/empresas/${e.id}`, d);
    else await api.post('/painel/empresas', d);
    toast(e ? 'Empresa atualizada.' : 'Empresa criada. Agora cadastre a equipe dela em Usuários.');
    await carregarEmpresas();
    recarregar();
  });
}

/** Corrigir nome, e-mail (que é o login) e, na equipe, o perfil. */
function editarUsuario(u, recarregar, master) {
  const daEquipe = ['master', 'administrador', 'operador'].includes(u.perfil);
  const perfis = Object.fromEntries(Object.entries(PERFIS)
    .filter(([k]) => ['administrador', 'operador'].includes(k) || (k === 'master' && master)));
  return formModal(`Editar ${u.nome}`, () => [
    campo('Nome', { name: 'nome', value: u.nome, required: true, maxlength: 120 }),
    campo('E-mail (login)', { name: 'email', type: 'email', value: u.email, required: true }),
    daEquipe ? escolha('Perfil', 'perfil', perfis, u.perfil) : null,
    // O master pode trocar a pessoa de empresa (quem é master enxerga todas e fica sem).
    daEquipe && master && u.perfil !== 'master' ? campoEmpresa(u.empresa_id ? String(u.empresa_id) : '') : null,
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Mudando o e-mail, a pessoa passa a entrar com o e-mail novo. A senha continua a mesma.'),
  ], async (d) => {
    const corpo = { nome: d.nome, email: d.email };
    if (daEquipe && d.perfil && d.perfil !== u.perfil) corpo.perfil = d.perfil;
    if (d.empresa_id && Number(d.empresa_id) !== u.empresa_id) corpo.empresa_id = Number(d.empresa_id);
    await api.patch(`/painel/usuarios/${u.id}`, corpo);
    toast('Usuário atualizado.');
    recarregar();
  });
}

function novoUsuario(opcoes, recarregar, master = true) {
  return formModal('Novo usuário', () => {
    // Só o master cria outro master.
    const perfis = master ? PERFIS : Object.fromEntries(Object.entries(PERFIS).filter(([k]) => k !== 'master'));
    const perfil = escolha('Perfil', 'perfil', perfis, 'operador');
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
      campo('Senha (mínimo 10 caracteres)', { name: 'senha', type: 'password', required: true, minlength: 10 }),
      perfil, master ? campoEmpresa() : null, anunciante, ponto,
      master && listaDeEmpresas().length > 1
        ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'A empresa vale para administrador e operador: eles só enxergam os dados dela. Acesso de portal segue a empresa do anunciante ou do ponto.')
        : null,
    ];
  }, async (d) => {
    await api.post('/painel/usuarios', d);
    toast('Usuário criado.');
    recarregar();
  });
}

// Configurações em abas: cada uma é um formulário que salva só os próprios campos.
const ABAS_CONFIG = [['empresa', 'Empresa'], ['tvs', 'TVs'], ['sistema', 'Sistema']];
const LIGA_DESLIGA = ['aviso_lojista', 'comunicado_automatico', 'marca_preenche', 'avisos_email', 'clima_ligado'];

/** Abas no alto da tela (submenu na própria página): trocar de aba muda o endereço, então dá para voltar nela. */
export function abas(lista, atual, rota) {
  return el('nav', { class: 'abas', 'aria-label': 'Seções' },
    lista.map(([k, rotulo]) => el('a', { class: `aba${k === atual ? ' on' : ''}`, href: `#/${rota}/${k}`, 'aria-current': k === atual ? 'page' : null }, rotulo)));
}

/** Formulário de configurações que manda só os campos dele (o servidor não mexe no que não veio). */
function formConfig(conteudo, rotuloBotao = 'Salvar') {
  const f = el('form', { class: 'form' }, ...conteudo,
    el('div', { class: 'linha entre' }, el('span', {}), el('button', { class: 'btn primario largo' }, rotuloBotao)));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button[class*=primario]'), async () => {
      const d = lerForm(f);
      const corpo = { ...d };
      for (const k of LIGA_DESLIGA) if (f.elements[k]) corpo[k] = d[k] ? 1 : 0;
      if ('mensalidade' in d) corpo.mensalidade_tela_centavos = centavos(d.mensalidade) ?? 0;
      if ('cpm' in d) corpo.cpm_centavos = centavos(d.cpm) ?? 0;
      if ('comissao' in d) corpo.comissao_local_percentual = Math.round(Number(String(d.comissao).replace(',', '.')) * 100);
      for (const k of ['mensalidade', 'cpm', 'comissao']) delete corpo[k];
      await api.put('/painel/configuracoes', corpo);
      toast('Configurações salvas.');
    });
  });
  return f;
}

export async function configuracoes(ctx) {
  // A aba Sistema (atualizar o sistema e backup) é só do master; o administrador vê o resto.
  const abasVisiveis = ctx.master ? ABAS_CONFIG : ABAS_CONFIG.filter(([k]) => k !== 'sistema');
  const aba = abasVisiveis.some(([k]) => k === ctx.parametros[0]) ? ctx.parametros[0] : 'empresa';
  const c = await api.get('/painel/configuracoes');
  let corpo;
  if (aba === 'empresa') {
    corpo = el('div', { class: 'cartao grande' }, formConfig([
    el('fieldset', {}, el('legend', {}, 'Marca'),
      el('div', { class: 'duas' },
        campo('Nome que aparece no painel e nas telas', { name: 'nome_plataforma', value: c.nome_plataforma, required: true, maxlength: 60 }),
        campo('Frase da marca', { name: 'slogan', value: c.slogan, maxlength: 80, placeholder: 'Sua marca em movimento.' }))),

    el('fieldset', {}, el('legend', {}, 'PIX das faturas'),
      campo('Chave PIX', { name: 'pix_chave', value: c.pix_chave, maxlength: 80, placeholder: 'e-mail, CNPJ, telefone ou chave aleatória' }),
      el('div', { class: 'duas' },
        campo('Nome do recebedor', { name: 'pix_nome', value: c.pix_nome, maxlength: 60 }),
        campo('Cidade do recebedor', { name: 'pix_cidade', value: c.pix_cidade, maxlength: 40 })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Sem a chave, a fatura sai sem o código de pagamento.')),

    el('fieldset', {}, el('legend', {}, 'Nota fiscal'),
      campo('CNPJ da empresa', { name: 'empresa_documento', value: c.empresa_documento, maxlength: 20, placeholder: '00.000.000/0001-00' }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'A NFS-e é emitida no sistema da prefeitura (precisa de certificado digital). O painel guarda o número da nota em cada fatura e monta a planilha com tomador, CNPJ, serviço e valor para a emissão.')),

    el('fieldset', {}, el('legend', {}, 'WhatsApp da empresa'),
      campo('Número com DDD', { name: 'whatsapp', value: c.whatsapp, maxlength: 20, placeholder: '(19) 99999-0000' }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'É o número que aparece para o cliente: no site, nos portais do anunciante e do ponto, e na proposta que ele abre pelo link. '
        + 'As mensagens continuam saindo do WhatsApp de quem opera — o sistema abre a conversa com o texto pronto, não dispara sozinho.')),

    el('fieldset', {}, el('legend', {}, 'Avisos por e-mail'),
      c.email.configurado
        ? el('p', { class: 'aviso ok' }, `Envio configurado. Os avisos vão para quem opera a rede (${c.email.equipe} pessoa(s)).`)
        : el('p', { class: 'aviso' }, 'Sem servidor de e-mail (MIDIA_SMTP_HOST). Ninguém é avisado quando uma tela cai ou uma fatura vence.'),
      marcar('Avisar por e-mail: tela fora do ar, fatura vencida e fila de aprovação parada', { name: 'avisos_email', checked: Boolean(c.avisos_email) }),
      c.email.url ? null : el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'Dica: configure MIDIA_URL com o endereço público do painel para os links dos e-mails abrirem direto na tela certa.'),
      el('div', { class: 'linha' }, el('button', {
        type: 'button', class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
          const r = await api.post('/painel/configuracoes/email-teste', {});
          toast(r.enviado ? 'E-mail de teste enviado. Confira a sua caixa.' : `Não saiu: ${r.motivo}`, !r.enviado);
        }),
      }, 'Enviar e-mail de teste para mim')))]));
  } else if (aba === 'tvs') {
    corpo = el('div', { class: 'cartao grande' }, formConfig([
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
      marcar('O responsável pelo ponto pode escrever o aviso da faixa da própria tela', { name: 'aviso_lojista', checked: Boolean(c.aviso_lojista) }),
      marcar('Comunicado publicado pelo ponto entra no ar direto (sem passar pela equipe)', { name: 'comunicado_automatico', checked: Boolean(c.comunicado_automatico) })),

    el('fieldset', {}, el('legend', {}, 'Tela da marca'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'Quando a tela não tem nenhuma campanha no ar, ela mostra a peça da marca (logotipo, frase e o símbolo), para '
        + 'a TV nunca ficar preta. Com anúncio no ar, a tela é só do cliente: a marca não entra no meio. A própria '
        + 'tela desenha a peça: não precisa subir arte, e ela se ajusta a telas deitadas e em pé.'),
      el('div', { class: 'duas' },
        marcar('Mostrar a tela da marca quando não houver campanha', { name: 'marca_preenche', checked: Boolean(c.marca_preenche) }),
        campo('Tempo de cada aparição (segundos)', { name: 'marca_duracao_s', type: 'number', min: 5, max: 60, value: c.marca_duracao_s }))),

    el('fieldset', {}, el('legend', {}, 'Conteúdo útil na tela'),
      marcar('Mostrar o clima do dia nas telas', { name: 'clima_ligado', checked: Boolean(c.clima_ligado) }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'A temperatura aparece na faixa de baixo e, nas telas divididas, num quadro ao lado dos comunicados. '
        + 'Os dados vêm do Open-Meteo (gratuito, sem cadastro) e exigem que o servidor alcance a internet; '
        + 'a busca é uma por cidade, a cada 30 minutos. Se o serviço não responder, a tela simplesmente deixa de mostrar o clima.'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'A agenda do ponto ("O que vem por aí") aparece sozinha quando um comunicado tem data de evento — vale para a assembleia do prédio, a aula da academia ou a promoção da loja.')),

    el('fieldset', {}, el('legend', {}, 'Prova visual das telas'),
      el('div', { class: 'duas' },
        campo('A TV manda uma foto do que está na tela a cada (minutos)', { name: 'foto_minutos', type: 'number', min: 0, max: 1440, value: c.foto_minutos }),
        campo('Guardar a prova de exibição detalhada por (dias)', { name: 'prova_dias', type: 'number', min: 0, max: 3650, value: c.prova_dias })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'O player desenha o próprio conteúdo e envia a imagem; o painel guarda só a última de cada TV, em TVs. '
        + 'Não há câmera nem leitura do ambiente — é uma cópia do que o aparelho está exibindo. 0 desliga.'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O resumo por dia (relatórios e faturamento) nunca é apagado; 0 guarda todo o detalhe da prova de exibição para sempre.'))]));
  } else {
    corpo = el('div', { class: 'coluna' }, await cartaoAtualizacao(ctx), await cartaoDkim(), await cartaoBackup());
  }
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    abas(abasVisiveis, aba, 'configuracoes'),
    el('p', { class: 'pequeno mudo', style: 'margin:0' },
      aba === 'empresa' ? 'Os dados da empresa: marca, PIX e nota fiscal das faturas, WhatsApp e avisos.'
        : aba === 'tvs' ? 'Como as telas montam o loop, falam com o servidor e o que mostram além dos anúncios.'
          : 'Atualização do sistema e cópias de segurança do banco.'),
    corpo));
}

/** CRM › Produtos: a tabela de preços que a proposta e o faturamento usam. */
export async function produtos(ctx) {
  const c = await api.get('/painel/configuracoes');
  limpar(ctx.conteudo, el('div', { class: 'coluna' },
    el('div', { class: 'cartao grande' }, formConfig([
    el('fieldset', {}, el('legend', {}, 'Preços de tabela e faturamento'),
      el('div', { class: 'tres' },
        campo('Mensalidade por TV (R$)', { name: 'mensalidade', value: reaisCampo(c.mensalidade_tela_centavos), inputmode: 'decimal' }),
        campo('CPM — por mil impactos (R$)', { name: 'cpm', value: reaisCampo(c.cpm_centavos), inputmode: 'decimal' }),
        campo('Comissão sugerida ao lojista (%)', { name: 'comissao', value: (c.comissao_local_percentual / 100).toString().replace('.', ','), inputmode: 'decimal' })),
      el('div', { class: 'duas' },
        campo('Dia de vencimento das faturas', { name: 'vencimento_dia', type: 'number', min: 1, max: 28, value: c.vencimento_dia }),
        campo('Avisar do fim do contrato com (dias)', { name: 'contrato_aviso_dias', type: 'number', min: 0, max: 180, value: c.contrato_aviso_dias })),),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'A mensalidade e o CPM são o ponto de partida da proposta comercial; dá para ajustar o preço em cada proposta. '
        + 'A comissão é a sugerida ao cadastrar um ponto novo.')], 'Salvar preços'))));
}

// Etapas que o atualizador do servidor informa (atualizar-pelo-painel.sh).
const ETAPAS = {
  conferindo: 'Conferindo o pacote', guardando: 'Guardando uma cópia da versão no ar', instalando: 'Instalando a versão nova',
  testando: 'Conferindo se o sistema voltou', revertendo: 'Voltando para a versão anterior',
};
const FINAIS = ['concluida', 'falhou', 'revertida'];

/**
 * Atualizar o sistema pelo painel (dá para fazer do celular): envia o vaimidia.zip com a senha
 * digitada de novo. Quem troca a versão é um serviço do servidor; se a nova não subir, ele volta a anterior.
 */
/** O registro DKIM pronto para copiar e colar no Registro.br, sem precisar entrar no servidor. */
async function cartaoDkim() {
  const d = await api.get('/painel/sistema/dkim').catch(() => ({ configurado: false, motivo: 'Não foi possível consultar.' }));
  const linha = (rotulo, valor) => el('div', { class: 'chave', style: 'gap:10px;align-items:flex-start' },
    el('span', { class: 'mudo' }, rotulo),
    el('span', { style: 'display:flex;gap:8px;align-items:flex-start;min-width:0' },
      el('code', { style: 'word-break:break-all;text-align:right' }, valor),
      el('button', { class: 'btn pequeno', onclick: () => { navigator.clipboard?.writeText(valor); toast(`${rotulo} copiado.`); } }, 'Copiar')));
  return el('div', { class: 'cartao' },
    el('h2', {}, 'E-mail: registro DKIM'),
    d.configurado
      ? el('div', { class: 'coluna' },
        el('p', { class: 'mudo', style: 'margin-top:-8px' }, `No Registro.br, no domínio ${d.dominio}, crie um registro novo com estes dados. Ele evita que os e-mails do sistema caiam no spam.`),
        linha('Tipo', d.tipo), linha('Nome', d.nome), linha('Dados', d.dados))
      : el('p', { class: 'mudo' }, d.motivo));
}

async function cartaoAtualizacao(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const situacao = el('div', { class: 'coluna', style: 'gap:8px' });
  const arquivo = el('input', { type: 'file', name: 'pacote', accept: '.zip,application/zip', required: true });
  const senha = el('input', { type: 'password', name: 'senha', autocomplete: 'current-password', required: true, placeholder: 'Sua senha' });
  const botao = el('button', { class: 'btn primario' }, icone('enviar'), 'Atualizar agora');
  const f = el('form', { class: 'coluna', style: 'gap:10px' },
    el('label', { class: 'campo' }, el('span', {}, 'Arquivo vaimidia.zip'), arquivo),
    el('label', { class: 'campo' }, el('span', {}, 'Sua senha, para confirmar'), senha),
    el('div', {}, botao));
  let acompanhando = false;

  const pintar = async () => {
    const s = await api.get('/painel/sistema/atualizacao');
    const e = s.estado;
    const emAndamento = s.esperando || (e && !FINAIS.includes(e.etapa)
      && Date.now() - Date.parse(e.atualizado_em) < 15 * 60_000);
    const linhas = [];
    if (s.sem_resposta) {
      linhas.push(el('p', { class: 'aviso erro' }, 'O servidor ainda não pegou o pedido. O atualizador automático é instalado na '
        + 'primeira atualização feita pelos comandos (./atualizar.sh). Depois dela, este botão passa a funcionar.'));
    } else if (s.esperando) {
      linhas.push(el('p', { class: 'aviso' }, 'Pacote recebido. Esperando o servidor começar…'));
    } else if (e && emAndamento) {
      linhas.push(el('p', { class: 'aviso' }, `${ETAPAS[e.etapa] ?? e.mensagem}… não feche esta página.`));
    } else if (e) {
      const classe = e.etapa === 'concluida' ? 'aviso ok' : 'aviso erro';
      linhas.push(el('p', { class: classe }, `${e.mensagem} (${dataHora(e.atualizado_em)})`));
      if (e.etapa === 'concluida' && acompanhando) {
        linhas.push(el('div', {}, el('button', { class: 'btn primario', type: 'button', onclick: () => location.reload() }, 'Recarregar a página')));
      }
    }
    if (e && e.etapa !== 'concluida' && s.log && !emAndamento) {
      linhas.push(el('details', {}, el('summary', { class: 'pequeno' }, 'Ver o registro'), el('pre', { class: 'pequeno', style: 'white-space:pre-wrap;max-height:240px;overflow:auto' }, s.log)));
    }
    limpar(situacao, ...linhas);
    f.hidden = Boolean(emAndamento && !s.sem_resposta);
  };

  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    acao(botao, async () => {
      const zip = arquivo.files[0];
      if (!zip) throw new Error('Escolha o arquivo vaimidia.zip.');
      if (!/\.zip$/i.test(zip.name)) throw new Error('Escolha o arquivo .zip do sistema (vaimidia.zip).');
      const ok = await confirmar('Atualizar o sistema agora?',
        'O sistema fica fora do ar por cerca de 1 minuto. Antes de trocar, o servidor guarda uma cópia da versão atual '
        + 'e, se a nova não subir, volta para ela sozinho.', 'Atualizar');
      if (!ok) return;
      let resp;
      try {
        resp = await fetch(`${BASE}/api/painel/sistema/atualizacao`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessao.get()?.token ?? ''}`, 'Content-Type': 'application/zip',
            'X-Confirmar-Senha': encodeURIComponent(senha.value),
          },
          body: zip,
        });
      } catch {
        throw new Error('Sem conexão com o servidor durante o envio.');
      }
      if (!resp.ok) {
        let msg = `Erro ${resp.status}`;
        try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
        throw new Error(msg);
      }
      senha.value = '';
      arquivo.value = '';
      acompanhando = true;
      toast('Pacote enviado. O servidor está atualizando.');
      await pintar();
    });
  });

  limpar(corpo,
    el('h2', { style: 'margin:0 0 4px' }, 'Atualizar sistema'),
    el('p', { class: 'pequeno mudo', style: 'margin:0 0 12px' },
      'Envie o vaimidia.zip da versão nova, inclusive pelo celular. O servidor guarda uma cópia da versão atual antes de trocar '
      + 'e, se a nova não subir, volta para ela sozinho.'),
    situacao, f);
  try { await pintar(); } catch { /* o cartão aparece mesmo assim */ }
  // Durante a troca o sistema reinicia: a consulta falha por alguns segundos e a próxima tenta de novo.
  ctx.parar(repetir(pintar, 4000));
  return corpo;
}

/** Backup: cópia do banco guardada pelo servidor, com download, e o espelho dos arquivos das mídias. */
async function cartaoBackup() {
  const corpo = el('div', { class: 'cartao' });
  const pintar = async () => {
    const d = await api.get('/painel/backups');
    limpar(corpo,
      el('div', { class: 'linha entre' },
        el('h2', { style: 'margin:0' }, 'Backup'),
        el('button', {
          class: 'btn primario pequeno', onclick: (e) => acao(e.target, async () => {
            const r = await api.post('/painel/backups');
            toast(`Cópia gerada (${Math.round(r.tamanho / 1024)} kB)${r.espelho.ligado ? ` e ${r.espelho.copiados} arquivo(s) espelhado(s)` : ''}.`);
            pintar();
          }),
        }, icone('baixar'), 'Gerar agora')),
      el('p', { class: 'pequeno mudo' },
        `O banco é copiado a cada ${d.intervalo_horas} h, guardando as ${d.manter} mais recentes em ${d.pasta}.`),
      d.espelho
        ? el('p', { class: 'aviso ok' }, `Os arquivos das mídias (${mb(d.arquivos_bytes)}) são espelhados em ${d.espelho}.`)
        : el('p', { class: 'aviso' }, `O backup guarda só o banco. Os arquivos das mídias ocupam ${mb(d.arquivos_bytes)} e `
          + 'não têm cópia: configure MIDIA_ESPELHO apontando para outro disco ou volume.'),
      tabela([
        [(b) => b.nome, 'Cópia'],
        [(b) => dataHora(b.criado_em), 'Quando'],
        [(b) => mb(b.tamanho), 'Tamanho', 'num dir'],
        [(b) => el('button', { class: 'btn pequeno', onclick: (e) => acao(e.target, () => baixar(`/painel/backups/${b.nome}`, b.nome)) }, 'Baixar'), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nenhuma cópia ainda. A primeira sai alguns minutos depois de o servidor subir.' }));
  };
  await pintar();
  return corpo;
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
