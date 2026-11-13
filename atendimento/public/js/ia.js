/**
 * Telas da atendente virtual: o que ela sabe (base de conhecimento), o que ela faz sem pensar
 * (intenções), o que ela pode consultar (ferramentas), como ela fala (configuração) e o teste.
 */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, acao, confirmar, formModal, modal, campo, area, escolha, marcar, lerForm, inteiro,
  porcento, dataHora, dinheiro,
} from './ui.js';
import {cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, vazio, filtroPeriodo, cartaoMotivos} from './comum.js';

const ESFORCOS = { '': 'Padrão do servidor', low: 'Baixo — responde rápido e custa menos', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };

// ---------- Tela principal da atendente virtual ----------

export async function telaIa(ctx) {
  const abas = el('div', { class: 'abas' });
  const corpo = el('div');
  const TELAS = {
    desempenho: ['Desempenho', desempenho],
    conhecimento: ['Base de conhecimento', conhecimento],
    intencoes: ['Intenções', intencoes],
    ferramentas: ['Ferramentas', ferramentas],
    configuracao: ['Como ela atende', configuracao],
    teste: ['Testar', teste],
  };
  let atual = 'desempenho';
  const trocar = async (k) => {
    atual = k;
    limpar(abas, Object.entries(TELAS).map(([chave, [rotulo]]) => el('button', {
      class: `aba${chave === atual ? ' on' : ''}`, type: 'button', onclick: () => trocar(chave),
    }, rotulo)));
    limpar(corpo, el('p', { class: 'mudo' }, 'Carregando…'));
    try { await TELAS[k][1](ctx, corpo); } catch (err) { limpar(corpo, el('p', { class: 'mudo' }, err.message)); }
  };
  limpar(ctx.conteudo, abas, corpo);
  await trocar(atual);
}

// ---------- Desempenho ----------

async function desempenho(ctx, alvo) {
  const { hojeLocal, somarDias } = await import('./ui.js');
  const estado = { de: somarDias(hojeLocal(), -29), ate: hojeLocal() };
  const conteudo = el('div');
  const desenhar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/relatorios${qs(estado)}`);
    const r = d.resumo;
    const resolvidas = r.resolvidas_ia + r.resolvidas_cliente;
    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Resolveu sozinha', porcento(r.taxa_resolucao_ia), `${inteiro(resolvidas)} de ${inteiro(r.encerradas)} conversas`, 'robo', 'verde'),
        indicador('Passou para a equipe', inteiro(r.transferidas), porcento(r.taxa_transferencia), 'pessoa', 'laranja'),
        indicador('Respostas geradas', inteiro(r.ia.respostas), `${inteiro(r.ia.ferramentas)} ferramenta(s) usada(s)`, 'raio', 'azul'),
        indicador('Custo estimado', dinheiro(r.ia.custo_centavos), r.ia.ms_medio === null ? 'sem respostas' : `${inteiro(r.ia.ms_medio)} ms por resposta`, 'dinheiro', 'roxo')),
      el('div', { class: 'grade-2' },
        cartao('Ferramentas mais usadas',
          tabela(['Ferramenta', '>Usos'], d.ia.ferramentas.map((f) => el('tr', {}, td(f.nome), td(inteiro(f.usos), 'dir num'))), 'A IA ainda não usou ferramenta no período')),
        cartao('Intenções que resolveram antes da IA',
          tabela(['Intenção', '>Usos'], d.ia.intencoes.map((i) => el('tr', {}, td(i.nome), td(inteiro(i.usos), 'dir num'))), 'Nenhuma intenção acionada no período'))),
      cartao('Artigos da base: quais puxam o atendimento',
        tabela(['Artigo', '^Ativo', '>Usos'], d.ia.conhecimento.map((a) => el('tr', {},
          td(a.titulo), td(a.ativo ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'), td(inteiro(a.usos), 'dir num'))),
        'A base está vazia: a atendente virtual não tem como responder nada sozinha'),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Artigo com zero uso costuma estar com título ou perguntas de exemplo fora do jeito que o cliente escreve.')),
      d.ia.erros.length ? cartao('Falhas da IA no período',
        tabela(['Falha', 'Detalhe', '^Vezes', 'Última'], d.ia.erros.map((e) => el('tr', {},
          td(e.nome), td(el('span', { class: 'pequeno' }, String(e.detalhe ?? '').slice(0, 120))), td(inteiro(e.vezes), 'centro num'), td(dataHora(e.ultimo)))))) : null,
      cartaoMotivos(d.motivos));
  };
  limpar(alvo, filtroPeriodo(estado, () => desenhar().catch((e) => toast(e.message, true))), conteudo);
  await desenhar();
}

// ---------- Base de conhecimento ----------

async function conhecimento(ctx, alvo) {
  const lista = el('div');
  const recarregar = async () => {
    const { itens } = await api.get(`/empresas/${ctx.empresaId}/ia/conhecimento`);
    limpar(lista, itens.length ? el('div', { class: 'cartoes-conhecimento' }, itens.map((a) => el('article', { class: `cartao artigo${a.ativo ? '' : ' inativo'}` },
      el('div', { class: 'linha entre' },
        el('h3', {}, a.titulo),
        el('div', { class: 'linha', style: 'gap:4px' },
          el('span', { class: 'etiqueta' }, `${inteiro(a.usos)} uso(s)`),
          a.ativo ? null : el('span', { class: 'etiqueta aviso' }, 'Desativado'),
          ctx.soAdmin ? botaoIcone('editar', 'Editar', () => editar(a)) : null,
          ctx.soAdmin ? botaoIcone('lixo', 'Excluir', () => excluir(a), 'perigo') : null)),
      el('p', {}, a.resposta),
      a.perguntas ? el('div', { class: 'perguntas' }, String(a.perguntas).split('\n').filter(Boolean).map((q) => el('span', { class: 'etiqueta' }, q))) : null)))
      : vazio('A base de conhecimento está vazia.', 'Sem base, a atendente virtual não responde nada sozinha: ela transfere tudo. Comece pelas 5 perguntas que a sua equipe mais recebe.'));
  };

  const form = (a = {}) => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'O título deve ser o assunto como o cliente pensa. Nas perguntas de exemplo, escreva do jeito que ele escreve — é o que faz a busca acertar.'),
    campo('Título', { name: 'titulo', value: a.titulo ?? '', required: true, maxlength: 160, placeholder: 'Segunda via do boleto' }),
    area('Resposta (a atendente virtual usa este texto)', { name: 'resposta', rows: 5, required: true, maxlength: 4000 }, a.resposta ?? ''),
    area('Perguntas de exemplo (uma por linha)', { name: 'perguntas', rows: 4, maxlength: 2000, placeholder: 'preciso da segunda via\nboleto vencido\nnão recebi a fatura' }, a.perguntas ?? ''),
    marcar('Ativo', { name: 'ativo', checked: a.id ? Boolean(a.ativo) : true }),
  ];

  const criar = () => formModal('Novo artigo', () => form(), async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ia/conhecimento`, d);
    toast('Artigo criado.');
    await recarregar();
  }, { largo: true });

  const editar = (a) => formModal('Editar artigo', () => form(a), async (d) => {
    await api.patch(`/empresas/${ctx.empresaId}/ia/conhecimento/${a.id}`, d);
    toast('Artigo salvo.');
    await recarregar();
  }, { largo: true });

  const excluir = async (a) => {
    if (!await confirmar('Excluir artigo', `"${a.titulo}" sai da base e a atendente virtual deixa de responder isso.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/ia/conhecimento/${a.id}`);
    toast('Artigo excluído.');
    await recarregar();
  };

  const testarBusca = () => modal('Testar a busca', (fechar) => {
    const resultado = el('div');
    const f = el('form', { class: 'form' },
      campo('O que o cliente escreveria', { name: 'pergunta', required: true, placeholder: 'não consigo pagar minha fatura' }),
      el('button', { class: 'btn primario' }, 'Buscar'));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(f.querySelector('button'), async () => {
        const { achados } = await api.get(`/empresas/${ctx.empresaId}/ia/conhecimento/buscar${qs(lerForm(f))}`);
        limpar(resultado, achados.length
          ? tabela(['Artigo', '>Pontos'], achados.map((a) => el('tr', {}, td(a.titulo), td(a.pontos, 'dir num'))))
          : el('p', { class: 'mudo' }, 'Nada na base responde isso — a atendente virtual transferiria. Vale criar um artigo.'));
      });
    });
    return [el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'Mostra o que a atendente virtual encontraria, com a pontuação de cada artigo.'), f, resultado,
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar'))];
  }, { largo: true });

  limpar(alvo, acoesTopo(
    el('div', { class: 'linha', style: 'gap:8px' }, botao('Testar a busca', '', testarBusca)),
    ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Novo artigo') : null), lista);
  await recarregar();
}

// ---------- Intenções ----------

async function intencoes(ctx, alvo) {
  const filas = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;
  const lista = el('div');
  const ACOES = { responder: 'Responde na hora', transferir: 'Transfere para a fila', encerrar: 'Responde e encerra' };

  const recarregar = async () => {
    const { itens } = await api.get(`/empresas/${ctx.empresaId}/ia/intencoes`);
    limpar(lista, cartao(null, tabela(['Ordem', 'Intenção', 'Palavras-chave', 'Ação', 'Fila', '>Usos', '^Ativa', ''],
      itens.map((i) => el('tr', {},
        td(inteiro(i.ordem), 'centro num'),
        td(el('strong', {}, i.nome)),
        td(el('div', { class: 'perguntas' }, String(i.palavras).split('\n').filter(Boolean).slice(0, 6).map((p) => el('span', { class: 'etiqueta' }, p)))),
        td(ACOES[i.acao] ?? i.acao),
        td(i.fila_nome ?? '—'),
        td(inteiro(i.usos), 'dir num'),
        td(i.ativa ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
        td(ctx.soAdmin ? el('div', { class: 'linha', style: 'gap:4px' }, botaoIcone('editar', 'Editar', () => editar(i)), botaoIcone('lixo', 'Excluir', () => excluir(i), 'perigo')) : null, 'dir'))),
    'Nenhuma intenção cadastrada. Sem elas, tudo passa pela IA — o que funciona, mas custa mais.')));
  };

  const form = (i = {}) => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'Intenção resolve antes de a IA ser chamada: é barata, instantânea e previsível. Use para o que se repete muito e tem resposta sempre igual. '
      + 'A comparação ignora acentos e maiúsculas, e ganha a palavra mais específica.'),
    campo('Nome', { name: 'nome', value: i.nome ?? '', required: true, maxlength: 80, placeholder: 'Segunda via do boleto' }),
    area('Palavras-chave (uma por linha)', { name: 'palavras', rows: 4, required: true, placeholder: 'boleto\nsegunda via\n2a via' }, i.palavras ?? ''),
    escolha('Ação', 'acao', ACOES, i.acao ?? 'responder'),
    area('Resposta (para "responde na hora" e "responde e encerra")', { name: 'resposta', rows: 3, maxlength: 4000 }, i.resposta ?? ''),
    escolha('Fila (para "transfere")', 'fila_id', { '': '— fila padrão da IA —', ...Object.fromEntries(filas.map((f) => [f.id, f.nome])) }, i.fila_id ?? ''),
    campo('Ordem (menor vem primeiro no empate)', { name: 'ordem', type: 'number', value: i.ordem ?? 0, min: 0, max: 999 }),
    marcar('Ativa', { name: 'ativa', checked: i.id ? Boolean(i.ativa) : true }),
  ];

  const criar = () => formModal('Nova intenção', () => form(), async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ia/intencoes`, d);
    toast('Intenção criada.');
    await recarregar();
  }, { largo: true });

  const editar = (i) => formModal('Editar intenção', () => form(i), async (d) => {
    await api.patch(`/empresas/${ctx.empresaId}/ia/intencoes/${i.id}`, d);
    toast('Intenção salva.');
    await recarregar();
  }, { largo: true });

  const excluir = async (i) => {
    if (!await confirmar('Excluir intenção', `"${i.nome}" deixa de ser reconhecida: o assunto passa a ir para a IA.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/ia/intencoes/${i.id}`);
    toast('Intenção excluída.');
    await recarregar();
  };

  limpar(alvo, acoesTopo(el('span'), ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova intenção') : null), lista);
  await recarregar();
}

// ---------- Ferramentas ----------

async function ferramentas(ctx, alvo) {
  const lista = el('div');
  const recarregar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/ia/ferramentas`);
    limpar(lista,
      cartao('Nativas da plataforma',
        tabela(['Ferramenta', 'O que faz'], d.internas.map((f) => el('tr', {}, td(el('code', {}, f.nome)), td(el('span', { class: 'pequeno' }, f.descricao)))))),
      cartao('Da sua empresa (consultam o seu sistema)',
        tabela(['Ferramenta', 'Descrição', 'Endereço', '>Usos', '^Ativa', ''], d.itens.map((f) => el('tr', {},
          td(el('code', {}, f.nome)),
          td(el('span', { class: 'pequeno' }, f.descricao)),
          td(el('div', {}, el('span', { class: 'etiqueta' }, f.metodo), el('div', { class: 'pequeno mudo' }, f.url),
            f.cabecalhos_nomes.length ? el('div', { class: 'pequeno mudo' }, `cabeçalhos: ${f.cabecalhos_nomes.join(', ')}`) : null)),
          td(inteiro(f.usos), 'dir num'),
          td(f.ativa ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
          td(ctx.soAdmin ? el('div', { class: 'linha', style: 'gap:4px' },
            botaoIcone('teste', 'Testar', () => testar(f)), botaoIcone('editar', 'Editar', () => editar(f)), botaoIcone('lixo', 'Excluir', () => excluir(f), 'perigo')) : null, 'dir'))),
        'Nenhuma ferramenta da empresa. Com uma, a atendente virtual consulta fatura, pedido ou contrato no seu sistema e resolve sem passar para a equipe.'),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'A plataforma manda os parâmetros escolhidos pela IA mais um bloco "contato" com telefone, nome, documento e código do cliente — '
          + 'a identificação vem do nosso banco, nunca do modelo.')));
  };

  const form = (f = {}) => [
    campo('Nome (é como a IA chama)', { name: 'nome', value: f.nome ?? '', required: true, placeholder: 'consultar_fatura', pattern: '[a-z][a-z0-9_]{2,48}' }),
    area('Descrição (a IA lê isto para decidir usar)', { name: 'descricao', rows: 3, required: true, maxlength: 1000 },
      f.descricao ?? 'Consulta as faturas em aberto do cliente no sistema da empresa. Use quando o cliente perguntar de boleto, valor ou vencimento.'),
    escolha('Método', 'metodo', { POST: 'POST', GET: 'GET' }, f.metodo ?? 'POST'),
    campo('Endereço (https)', { name: 'url', value: f.url ?? '', required: true, placeholder: 'https://api.suaempresa.com.br/faturas' }),
    area('Parâmetros (JSON Schema do objeto)', { name: 'parametros', rows: 6, placeholder: '{"type":"object","properties":{"mes":{"type":"string","description":"Mês no formato AAAA-MM"}},"required":["mes"]}' },
      f.parametros ?? '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'),
    area('Cabeçalhos (JSON; ficam cifrados)', { name: 'cabecalhos', rows: 3, placeholder: '{"Authorization":"Bearer sua-chave"}' }, ''),
    campo('Tempo limite (ms)', { name: 'timeout_ms', type: 'number', value: f.timeout_ms ?? 10000, min: 1000, max: 30000 }),
    marcar('Ativa', { name: 'ativa', checked: f.id ? Boolean(f.ativa) : true }),
  ];

  const criar = () => formModal('Nova ferramenta', () => form(), async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ia/ferramentas`, d);
    toast('Ferramenta criada.');
    await recarregar();
  }, { largo: true });

  const editar = (f) => formModal('Editar ferramenta', () => form(f), async (d) => {
    // Cabeçalhos em branco mantêm os que já estavam cifrados.
    if (!d.cabecalhos) delete d.cabecalhos;
    await api.patch(`/empresas/${ctx.empresaId}/ia/ferramentas/${f.id}`, d);
    toast('Ferramenta salva.');
    await recarregar();
  }, { largo: true });

  const excluir = async (f) => {
    if (!await confirmar('Excluir ferramenta', `A atendente virtual deixa de consultar "${f.nome}".`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/ia/ferramentas/${f.id}`);
    toast('Ferramenta excluída.');
    await recarregar();
  };

  const testar = (f) => formModal(`Testar ${f.nome}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'Chama o seu sistema de verdade, com o último contato da empresa como identificação.'),
    area('Parâmetros (JSON)', { name: 'entrada', rows: 4 }, '{}'),
  ], async (d, formEl) => {
    const r = await api.post(`/empresas/${ctx.empresaId}/ia/ferramentas/${f.id}/testar`, { entrada: d.entrada });
    formEl.append(el('div', { class: `aviso-caixa ${r.resultado.ok ? 'ok' : 'erro'}`, style: 'margin-top:10px' },
      el('strong', {}, r.resultado.ok ? `Respondeu em ${r.ms} ms` : 'Falhou'),
      el('pre', { class: 'json' }, JSON.stringify(r.resultado, null, 2).slice(0, 2000))));
    return false;
  }, { rotulo: 'Chamar', largo: true });

  limpar(alvo, acoesTopo(el('span'), ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova ferramenta') : null), lista);
  await recarregar();
}

// ---------- Configuração ----------

async function configuracao(ctx, alvo) {
  const cfg = await api.get(`/empresas/${ctx.empresaId}/ia`);
  const filas = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;

  const f = el('form', { class: 'form colunas' },
    cartao('Identidade e tom',
      marcar('Atendente virtual ligada (ela faz o primeiro atendimento)', { name: 'ativa', checked: cfg.ativa }),
      campo('Nome dela', { name: 'nome_assistente', value: cfg.nome_assistente ?? 'ZOE', maxlength: 40 }),
      area('Saudação (primeira mensagem da conversa)', { name: 'saudacao', rows: 3, maxlength: 1000, placeholder: 'Vazio usa uma saudação padrão. Use {cliente}, {empresa} e {assistente}.' }, cfg.saudacao ?? ''),
      area('Como ela deve falar', { name: 'tom', rows: 6, maxlength: 3000, placeholder: 'Vazio usa o tom padrão: português do Brasil, você, mensagens curtas, sem formalidade de ofício.' }, cfg.tom ?? ''),
      area('Regras desta empresa', { name: 'regras', rows: 6, maxlength: 5000, placeholder: 'Nunca prometa desconto nem prazo de visita técnica.\nCliente com fatura vencida há mais de 30 dias vai para o Financeiro.' }, cfg.regras ?? '')),

    cartao('Quando passar para a equipe',
      campo('Máximo de mensagens antes de transferir', { name: 'max_turnos', type: 'number', value: cfg.max_turnos, min: 1, max: 60 }),
      marcar('Transferir quando ela não souber responder (recomendado)', { name: 'transferir_sem_resposta', checked: cfg.transferir_sem_resposta }),
      escolha('Fila padrão (quando ela não escolhe uma)', 'fila_padrao_id', { '': '— primeira fila ativa —', ...Object.fromEntries(filas.map((x) => [x.id, x.nome])) }, cfg.fila_padrao_id ?? ''),
      campo('Encerrar por abandono depois de (minutos, 0 = nunca)', { name: 'encerrar_apos_min', type: 'number', value: cfg.encerrar_apos_min, min: 0, max: 10080 }),
      marcar('Pedir avaliação de 1 a 5 no fim', { name: 'pedir_csat', checked: cfg.pedir_csat })),

    cartao('Mensagens automáticas',
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'Deixe em branco para usar o texto padrão, mostrado como dica em cada campo.'),
      area('Ao transferir', { name: 'mensagem_transferencia', rows: 2, maxlength: 1000, placeholder: cfg.padroes.transferencia }, cfg.mensagem_transferencia ?? ''),
      area('Ao transferir fora do horário', { name: 'mensagem_fora_horario', rows: 2, maxlength: 1000, placeholder: cfg.padroes.fora_horario }, cfg.mensagem_fora_horario ?? ''),
      area('Ao encerrar', { name: 'mensagem_encerramento', rows: 2, maxlength: 1000, placeholder: cfg.padroes.encerramento }, cfg.mensagem_encerramento ?? ''),
      area('Ao pedir a avaliação', { name: 'mensagem_csat', rows: 2, maxlength: 1000, placeholder: cfg.padroes.csat }, cfg.mensagem_csat ?? '')),

    cartao('Modelo',
      cfg.chave_no_servidor
        ? el('div', { class: 'aviso-caixa ok' }, icone('ok'), el('span', {}, `A chave da Claude API está configurada no servidor. Modelo em uso: ${cfg.modelo_efetivo}.`))
        : el('div', { class: 'aviso-caixa aviso' }, icone('alerta'), el('span', {},
          'O servidor está sem a chave da Claude API (ATEND_IA_CHAVE). Sem ela a atendente virtual funciona só com as intenções e a base de conhecimento, '
          + 'e o que não casar vai para o menu de departamentos.')),
      campo('Modelo (vazio = padrão do servidor)', { name: 'modelo', value: cfg.modelo ?? '', maxlength: 60, placeholder: cfg.modelo_efetivo }),
      escolha('Esforço de raciocínio', 'esforco', ESFORCOS, cfg.esforco ?? ''),
      el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' },
        'Esforço maior pensa mais, erra menos em caso difícil e custa mais. Para atendimento de WhatsApp, o baixo costuma bastar.'),
      botao('Ver o prompt que ela recebe', '', verPrompt)),

    el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', disabled: !ctx.soAdmin }, 'Salvar')));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button[type=submit], .btn.primario'), async () => {
      await api.patch(`/empresas/${ctx.empresaId}/ia`, lerForm(f));
      toast('Atendente virtual salva.');
    });
  });

  async function verPrompt() {
    const p = await api.get(`/empresas/${ctx.empresaId}/ia/prompt`);
    modal('O prompt da atendente virtual', (fechar) => [
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
        'É exatamente o que vai para o modelo em toda conversa, montado a partir desta configuração, das suas filas e da base de conhecimento.'),
      el('pre', { class: 'json', style: 'max-height:50vh' }, p.sistema),
      el('h3', { style: 'margin:14px 0 6px' }, 'Ferramentas disponíveis'),
      tabela(['Ferramenta', 'Parâmetros'], p.ferramentas.map((t) => el('tr', {}, td(el('code', {}, t.nome)), td(t.parametros.join(', ') || '—')))),
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  }

  limpar(alvo, f);
}

// ---------- Teste ----------

async function teste(ctx, alvo) {
  const historico = el('div', { class: 'teste-historico' });
  const texto = el('input', { placeholder: 'Escreva como um cliente escreveria…', required: true, maxlength: 1000 });
  const continuar = el('input', { type: 'checkbox', name: 'continuar' });

  const f = el('form', { class: 'linha', style: 'gap:8px;align-items:flex-end' },
    el('label', { class: 'campo', style: 'flex:1' }, 'Mensagem do cliente', texto),
    el('button', { class: 'btn primario' }, icone('enviar'), 'Enviar'));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const r = await api.post(`/empresas/${ctx.empresaId}/ia/testar`, { texto: texto.value, continuar: continuar.checked });
      historico.prepend(resultadoTeste(texto.value, r));
      texto.value = '';
      continuar.checked = true;
    });
  });

  limpar(alvo,
    cartao('Testar a atendente virtual',
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
        'Roda a atendente de verdade — mesmo prompt, mesma base, mesmas ferramentas — num contato de teste. Nada é enviado para o WhatsApp.'),
      f,
      el('label', { class: 'marcar', style: 'margin-top:8px' }, continuar, 'Continuar a mesma conversa de teste (sem marcar, cada mensagem começa do zero)')),
    historico);
}

function resultadoTeste(pergunta, r) {
  const DESFECHOS = {
    respondeu: ['Respondeu e seguiu com o cliente', 'ok'], encerrada: ['Resolveu e encerrou', 'ok'],
    transferida: ['Transferiu para a equipe', 'info'], menu: ['Ofereceu o menu de departamentos', 'aviso'],
    saudacao: ['Só cumprimentou, esperando o pedido', ''], na_fila: ['Já estava na fila', ''],
    humano_atendendo: ['Um humano está atendendo', ''], sem_saida: ['Não tinha para onde ir', 'erro'],
    contato_bloqueado: ['Contato bloqueado', 'erro'],
  };
  const [rotulo, tipo] = DESFECHOS[r.acao] ?? [r.acao, ''];
  return el('div', { class: 'cartao teste-passo' },
    el('div', { class: 'linha entre' },
      el('strong', {}, `"${pergunta}"`),
      el('span', { class: `etiqueta ${tipo}` }, rotulo)),
    r.respostas.length ? el('div', { class: 'mensagens compacta' }, r.respostas.map((m) => el('div', { class: `bolha ${m.autor}` },
      el('div', { class: 'corpo-bolha' }, el('p', {}, m.texto ?? `[${m.tipo}]`))))) : el('p', { class: 'mudo' }, 'Nenhuma mensagem para o cliente.'),
    r.estado === 'aguardando' || r.estado === 'humano' ? el('div', { class: 'aviso-caixa info' }, icone('transferir'), el('div', {},
      el('strong', {}, `Foi para a fila ${r.fila ?? '—'}`),
      r.motivo_transferencia ? el('div', { class: 'pequeno' }, `Motivo: ${r.motivo_transferencia}`) : null,
      r.resumo ? el('div', { class: 'pequeno' }, `Resumo para o atendente: ${r.resumo}`) : null)) : null,
    r.eventos.length ? el('details', {}, el('summary', {}, `${r.eventos.length} passo(s) da atendente virtual`),
      el('ol', { class: 'passos-ia' }, r.eventos.map((ev) => el('li', {},
        el('strong', {}, ev.tipo === 'ferramenta' ? ev.nome : ev.tipo),
        ev.detalhe ? el('div', { class: 'pequeno mudo' }, String(ev.detalhe).slice(0, 400)) : null,
        ev.tokens_entrada ? el('small', {}, `${inteiro(ev.tokens_entrada)} tokens de entrada · ${inteiro(ev.tokens_saida)} de saída · ${inteiro(ev.ms)} ms`) : null)))) : null);
}

export { telaIa as default };
