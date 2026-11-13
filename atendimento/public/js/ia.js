/**
 * Telas da ZOE: o que ela sabe (base de conhecimento), o que ela faz sem pensar
 * (intenções), o que ela pode consultar (ferramentas), como ela fala (configuração) e o teste.
 */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, acao, confirmar, formModal, modal, campo, area, escolha, marcar, lerForm, inteiro,
  porcento, dataHora, dinheiro,
} from './ui.js';
import {cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, vazio, filtroPeriodo, cartaoMotivos} from './comum.js';

const ESFORCOS = { '': 'Padrão do servidor', low: 'Baixo — responde rápido e custa menos', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };

// ---------- Tela principal da ZOE ----------

export async function telaIa(ctx) {
  const abas = el('div', { class: 'abas' });
  const corpo = el('div');
  const TELAS = {
    desempenho: ['Desempenho', desempenho],
    aprendizado: ['Aprendizado', aprendizado],
    conhecimento: ['Base de conhecimento', conhecimento],
    intencoes: ['Intenções', intencoes],
    ferramentas: ['Ferramentas', ferramentas],
    alertas: ['Alertas de rede', alertasDeRede],
    configuracao: ['Como ela atende', configuracao],
    ixc: ['Provedor (IXC)', provedorIxc],
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

// ---------- Aprendizado ----------

/**
 * O que a ZOE não conseguiu resolver, agrupado por tema, com o que os clientes perguntaram e como
 * a equipe resolveu. "Ensinar a ZOE" transforma isso num artigo da base — e o próximo caso igual
 * ela resolve sozinha.
 */
async function aprendizado(ctx, alvo) {
  const estado = { dias: 30, mostrar: 'abertas' };
  const conteudo = el('div');
  const podeEnsinar = ctx.pode('zoe.editar');

  const desenhar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/ia/aprendizado${qs({ dias: estado.dias })}`);
    const r = d.resolucao;
    const variacao = r.taxa !== null && r.anterior !== null ? Number((r.taxa - r.anterior).toFixed(1)) : null;
    const temas = d.temas.filter((t) => (estado.mostrar === 'abertas' ? t.abertas > 0 && t.aprende : true));

    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Resolveu sozinha', r.taxa === null ? '—' : porcento(r.taxa),
          variacao === null ? `${inteiro(r.zoe)} de ${inteiro(r.zoe + r.equipe)} conversas` : `${variacao >= 0 ? '+' : ''}${variacao.toLocaleString('pt-BR')} ponto(s) contra os ${d.dias} dias anteriores`,
          'robo', variacao === null || variacao >= 0 ? 'verde' : 'laranja'),
        indicador('Passou para a equipe', inteiro(d.transferencias), `nos últimos ${d.dias} dias`, 'pessoa', 'laranja'),
        indicador('Para ensinar', inteiro(d.abertas), d.sem_solucao_registrada ? `${inteiro(d.sem_solucao_registrada)} sem "como resolveu"` : 'todas com a solução da equipe', 'alerta', d.abertas ? 'azul' : 'verde'),
        indicador('Já ensinadas', inteiro(d.ensinadas), 'viraram artigo da base', 'ok', 'roxo')),

      d.por_categoria.length ? cartao('Por que ela não resolveu',
        el('div', { class: 'motivos-aprendizado' }, d.por_categoria.map((c) => el('div', { class: 'motivo-aprendizado' },
          el('strong', {}, inteiro(c.casos)), el('span', {}, c.nome))))) : null,

      cartao(null,
        el('div', { class: 'linha entre', style: 'margin-bottom:10px;flex-wrap:wrap;gap:8px' },
          el('h3', { style: 'margin:0' }, 'Temas que escaparam da ZOE'),
          el('div', { class: 'linha', style: 'gap:6px' },
            ...[['abertas', 'Para ensinar'], ['todas', 'Todos']].map(([k, rot]) => el('button', {
              class: `btn pequeno${estado.mostrar === k ? ' primario' : ''}`, type: 'button', onclick: () => { estado.mostrar = k; desenhar(); },
            }, rot)))),
        temas.length ? el('div', { class: 'temas-aprendizado' }, temas.map((t) => cartaoTema(t)))
          : vazio(estado.mostrar === 'abertas' ? 'Nada para ensinar agora.' : 'Nenhuma transferência no período.',
            'Cada vez que a ZOE passar um cliente para a equipe, o motivo aparece aqui.')));
  };

  const cartaoTema = (t) => el('article', { class: `tema-aprendizado ${t.situacao}` },
    el('div', { class: 'linha entre', style: 'gap:8px;align-items:flex-start' },
      el('div', {},
        el('strong', { class: 'titulo-tema' }, t.tema),
        el('div', { class: 'pequeno mudo' }, `${inteiro(t.casos)} caso(s) · ${t.categoria_nome} · último ${dataHora(t.ultima_em)}`)),
      el('span', { class: `etiqueta ${t.situacao === 'aberta' ? (t.aprende ? 'aviso' : '') : 'ok'}` },
        t.situacao === 'aberta' ? (t.aprende ? 'para ensinar' : 'fica com a equipe') : t.situacao === 'ensinada' ? 'ensinada' : 'ignorada')),
    t.perguntas.length ? el('div', { class: 'bloco-tema' }, el('small', {}, 'O que os clientes perguntaram'),
      el('ul', {}, t.perguntas.slice(0, 3).map((q) => el('li', {}, `“${q}”`)))) : null,
    t.faltou.length ? el('div', { class: 'bloco-tema' }, el('small', {}, 'O que a ZOE disse que faltou'),
      el('ul', {}, t.faltou.map((f) => el('li', {}, f)))) : null,
    t.solucoes.length ? el('div', { class: 'bloco-tema' }, el('small', {}, 'Como a equipe resolveu'),
      el('ul', {}, t.solucoes.slice(0, 3).map((x) => el('li', {}, x.texto, el('span', { class: 'pequeno mudo' }, ` — ${x.por ?? 'equipe'}`)))))
      : t.aprende && t.abertas ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Ninguém contou ainda como resolveu. O atendente registra isso ao encerrar a conversa.') : null,
    el('p', { class: 'pequeno', style: 'margin:0;color:var(--text-2)' }, t.acao),
    podeEnsinar && t.abertas ? el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
      botao('Não é para a ZOE', 'pequeno', () => ignorar(t)),
      t.aprende ? botao('Ensinar a ZOE', 'primario pequeno', () => ensinar(t)) : null) : null);

  const ensinar = (t) => formModal(`Ensinar a ZOE: ${t.tema}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'Vira um artigo da base de conhecimento. A ZOE passa a responder isso sozinha — com as palavras abaixo, do jeito que os clientes perguntam.'),
    campo('Título', { name: 'titulo', value: t.tema.charAt(0).toUpperCase() + t.tema.slice(1), required: true, maxlength: 160 }),
    area('A resposta que a ZOE vai dar', { name: 'resposta', rows: 6, required: true, maxlength: 4000,
      placeholder: 'Escreva como você responderia ao cliente: valores, prazos e o que ele precisa fazer.' },
      // Começa pela solução mais completa da equipe; quem ensina ajusta o texto para falar com o cliente.
      [...t.solucoes].sort((x, y) => y.texto.length - x.texto.length)[0]?.texto ?? ''),
    area('Perguntas de exemplo (uma por linha)', { name: 'perguntas', rows: 4, maxlength: 2000 }, t.perguntas.join('\n')),
    t.solucoes.length > 1 ? el('details', {}, el('summary', { class: 'pequeno' }, `Outras ${t.solucoes.length - 1} solução(ões) da equipe`),
      el('ul', { class: 'pequeno' }, t.solucoes.slice(1).map((x) => el('li', {}, x.texto)))) : null,
  ], async (dados) => {
    const r = await api.post(`/empresas/${ctx.empresaId}/ia/aprendizado/ensinar`, { ...dados, tema_chave: t.tema_chave });
    toast(`A ZOE aprendeu "${dados.titulo}" (${r.lacunas} caso(s)).`);
    await desenhar();
  }, { rotulo: 'Ensinar', largo: true });

  const ignorar = async (t) => {
    if (!await confirmar('Não é para a ZOE', `"${t.tema}" sai da lista de pendências. Os próximos casos do tema voltam a aparecer.`, 'Tirar da lista')) return;
    await api.post(`/empresas/${ctx.empresaId}/ia/aprendizado/ignorar`, { tema_chave: t.tema_chave });
    await desenhar();
  };

  const periodo = escolha(null, 'dias', { 7: 'Últimos 7 dias', 30: 'Últimos 30 dias', 90: 'Últimos 90 dias' }, String(estado.dias));
  periodo.addEventListener('change', () => { estado.dias = Number(periodo.value); desenhar().catch((e) => toast(e.message, true)); });
  limpar(alvo, el('label', { class: 'campo', style: 'margin-bottom:12px;max-width:260px' }, 'Período', periodo), conteudo);
  await desenhar();
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
        cartao('Intenções que resolveram antes da ZOE',
          tabela(['Intenção', '>Usos'], d.ia.intencoes.map((i) => el('tr', {}, td(i.nome), td(inteiro(i.usos), 'dir num'))), 'Nenhuma intenção acionada no período'))),
      cartao('Artigos da base: quais puxam o atendimento',
        tabela(['Artigo', '^Ativo', '>Usos'], d.ia.conhecimento.map((a) => el('tr', {},
          td(a.titulo), td(a.ativo ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'), td(inteiro(a.usos), 'dir num'))),
        'A base está vazia: a ZOE não tem como responder nada sozinha'),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Artigo com zero uso costuma estar com título ou perguntas de exemplo fora do jeito que o cliente escreve.')),
      d.ia.erros.length ? cartao('Falhas da ZOE no período',
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
          ctx.pode('zoe.alertas') ? botaoIcone('editar', 'Editar', () => editar(a)) : null,
          ctx.pode('zoe.alertas') ? botaoIcone('lixo', 'Excluir', () => excluir(a), 'perigo') : null)),
      el('p', {}, a.resposta),
      a.perguntas ? el('div', { class: 'perguntas' }, String(a.perguntas).split('\n').filter(Boolean).map((q) => el('span', { class: 'etiqueta' }, q))) : null)))
      : vazio('A base de conhecimento está vazia.', 'Sem base, a ZOE não responde nada sozinha: ela transfere tudo. Comece pelas 5 perguntas que a sua equipe mais recebe.'));
  };

  const form = (a = {}) => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'O título deve ser o assunto como o cliente pensa. Nas perguntas de exemplo, escreva do jeito que ele escreve — é o que faz a busca acertar.'),
    campo('Título', { name: 'titulo', value: a.titulo ?? '', required: true, maxlength: 160, placeholder: 'Segunda via do boleto' }),
    area('Resposta (a ZOE usa este texto)', { name: 'resposta', rows: 5, required: true, maxlength: 4000 }, a.resposta ?? ''),
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
    if (!await confirmar('Excluir artigo', `"${a.titulo}" sai da base e a ZOE deixa de responder isso.`, 'Excluir')) return;
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
          : el('p', { class: 'mudo' }, 'Nada na base responde isso — a ZOE transferiria. Vale criar um artigo.'));
      });
    });
    return [el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'Mostra o que a ZOE encontraria, com a pontuação de cada artigo.'), f, resultado,
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar'))];
  }, { largo: true });

  limpar(alvo, acoesTopo(
    el('div', { class: 'linha', style: 'gap:8px' }, botao('Testar a busca', '', testarBusca)),
    ctx.pode('zoe.editar') ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Novo artigo') : null), lista);
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
        td(ctx.pode('zoe.editar') ? el('div', { class: 'linha', style: 'gap:4px' }, botaoIcone('editar', 'Editar', () => editar(i)), botaoIcone('lixo', 'Excluir', () => excluir(i), 'perigo')) : null, 'dir'))),
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

  limpar(alvo, acoesTopo(el('span'), ctx.pode('zoe.editar') ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova intenção') : null), lista);
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
          td(ctx.pode('zoe.editar') ? el('div', { class: 'linha', style: 'gap:4px' },
            botaoIcone('teste', 'Testar', () => testar(f)), botaoIcone('editar', 'Editar', () => editar(f)), botaoIcone('lixo', 'Excluir', () => excluir(f), 'perigo')) : null, 'dir'))),
        'Nenhuma ferramenta da empresa. Com uma, a ZOE consulta fatura, pedido ou contrato no seu sistema e resolve sem passar para a equipe.'),
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
    if (!await confirmar('Excluir ferramenta', `A ZOE deixa de consultar "${f.nome}".`, 'Excluir')) return;
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

  limpar(alvo, acoesTopo(el('span'), ctx.pode('zoe.editar') ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova ferramenta') : null), lista);
  await recarregar();
}

// ---------- Configuração ----------

async function configuracao(ctx, alvo) {
  const cfg = await api.get(`/empresas/${ctx.empresaId}/ia`);
  const filas = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;

  const t = cfg.transcricao;

  // ---------- Ligações: fala ou teclas ----------
  // As linhas do menu não têm "name": o lerForm não as pega, e o menu vai montado no salvar.
  const linhasMenu = el('div', { class: 'coluna', style: 'gap:8px' });
  const linhaMenu = (o = {}) => {
    const tecla = el('select', { 'aria-label': 'Tecla' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((x) => el('option', { value: x }, `Tecla ${x}`)));
    tecla.value = o.tecla ?? String(linhasMenu.children.length + 1);
    const rotulo = el('input', { value: o.rotulo ?? '', maxlength: 60, placeholder: 'segunda via da fatura', 'aria-label': 'O que a ZOE fala' });
    const pedido = el('input', { value: o.pedido ?? '', maxlength: 300, placeholder: 'Quero a segunda via da minha fatura.', 'aria-label': 'O que essa tecla significa' });
    const linha = el('div', { class: 'linha-menu-voz' }, tecla, rotulo, pedido,
      el('button', { type: 'button', class: 'icone-btn perigo', title: 'Remover', onclick: () => linha.remove() }, icone('lixo')));
    linha.ler = () => ({ tecla: tecla.value, rotulo: rotulo.value.trim(), pedido: pedido.value.trim() });
    linhasMenu.append(linha);
  };
  for (const o of cfg.voz_menu ?? []) linhaMenu(o);

  const blocoMenu = el('div', {},
    el('p', { class: 'pequeno mudo', style: 'margin:8px 0' },
      'Menu principal da ligação. "O que ela fala" entra em "digite 1 para…"; "o que significa" é o pedido que a tecla representa — '
      + 'ele passa pela ZOE como se o cliente tivesse dito, com as mesmas regras e ferramentas. O asterisco sempre repete o menu.'),
    el('div', { class: 'linha-menu-voz cabecalho pequeno mudo' }, el('span', {}, 'Tecla'), el('span', {}, 'O que ela fala'), el('span', {}, 'O que significa'), el('span')),
    linhasMenu,
    el('div', { class: 'linha', style: 'gap:8px;margin-top:8px' },
      el('button', { type: 'button', class: 'btn pequeno', onclick: () => linhaMenu() }, 'Adicionar opção'),
      el('button', { type: 'button', class: 'btn pequeno', onclick: () => { limpar(linhasMenu); for (const o of cfg.voz_menu_padrao) linhaMenu(o); } },
        'Voltar ao menu padrão')));

  const selModo = escolha('Como o cliente responde', 'voz_modo', {
    fala: 'Falando — ele diz o que quer, e o teclado vale para números',
    teclas: 'Pelo teclado — menu numerado ("digite 1 para…")',
  }, cfg.voz_modo ?? 'fala');
  const mostrarMenu = () => { blocoMenu.hidden = selModo.querySelector('select').value !== 'teclas'; };
  selModo.querySelector('select').addEventListener('change', mostrarMenu);
  queueMicrotask(mostrarMenu);

  const f = el('form', { class: 'form colunas' },
    cartao('Ligações',
      selModo,
      el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' },
        'Nos dois jeitos é a mesma ZOE: mesmas regras, ferramentas, confirmação de identidade, alertas e Ouvidoria. '
        + 'Muda só como ela pergunta e como o cliente responde.'),
      blocoMenu),
    t ? cartao('Áudios do cliente',
      el('p', { style: 'margin:0 0 6px' },
        el('span', { class: `etiqueta ${t.ligada ? 'ok' : ''}` }, t.ligada ? 'Transcrição ligada' : 'Transcrição desligada')),
      el('p', { class: 'mudo', style: 'margin:0' }, t.descricao),
      el('p', { class: 'pequeno mudo', style: 'margin:6px 0 0' },
        t.ligada
          ? `A ZOE responde ao que o cliente falou, e o atendente lê a transcrição embaixo do áudio. ${t.custo} `
            + `Áudios acima de ${Math.round(t.max_segundos / 60)} min não são transcritos: a ZOE pede um resumo por escrito.`
          : 'Quando o cliente manda áudio, a ZOE pede com gentileza para ele escrever.')) : null,
    cartao('Identidade e tom',
      marcar('ZOE ligada (ela faz o primeiro atendimento)', { name: 'ativa', checked: cfg.ativa }),
      campo('Nome dela', { name: 'nome_assistente', value: cfg.nome_assistente ?? 'ZOE', maxlength: 40 }),
      area('Saudação (primeira mensagem da conversa)', { name: 'saudacao', rows: 3, maxlength: 1000, placeholder: 'Vazio usa uma saudação padrão. Use {cliente}, {empresa} e {assistente}.' }, cfg.saudacao ?? ''),
      area('Como ela deve falar', { name: 'tom', rows: 6, maxlength: 3000, placeholder: 'Vazio usa o tom padrão: português do Brasil, você, mensagens curtas, sem formalidade de ofício.' }, cfg.tom ?? ''),
      area('Regras desta empresa', { name: 'regras', rows: 6, maxlength: 5000, placeholder: 'Nunca prometa desconto nem prazo de visita técnica.\nCliente com fatura vencida há mais de 30 dias vai para o Financeiro.' }, cfg.regras ?? '')),

    cartao('Quando passar para a equipe',
      campo('Máximo de mensagens antes de transferir', { name: 'max_turnos', type: 'number', value: cfg.max_turnos, min: 1, max: 60 }),
      marcar('Transferir quando ela não souber responder (recomendado)', { name: 'transferir_sem_resposta', checked: cfg.transferir_sem_resposta }),
      marcar('Resolver antes de transferir: quando o cliente pede uma pessoa sem dizer o assunto, ela pergunta o assunto uma vez e tenta resolver (recomendado)',
        { name: 'tentar_antes', checked: cfg.tentar_antes }),
      el('p', { class: 'pequeno mudo', style: 'margin:-4px 0 4px' },
        'Se o cliente pedir uma pessoa de novo, ela transfere na hora, sem discutir: falar com um atendente é direito do consumidor (Decreto do SAC).'),
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
          'O servidor está sem a chave da Claude API (ATEND_IA_CHAVE). Sem ela a ZOE funciona só com as intenções e a base de conhecimento, '
          + 'e o que não casar vai para o menu de departamentos.')),
      campo('Modelo (vazio = padrão do servidor)', { name: 'modelo', value: cfg.modelo ?? '', maxlength: 60, placeholder: cfg.modelo_efetivo }),
      escolha('Esforço de raciocínio', 'esforco', ESFORCOS, cfg.esforco ?? ''),
      el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' },
        'Esforço maior pensa mais, erra menos em caso difícil e custa mais. Para atendimento de WhatsApp, o baixo costuma bastar.'),
      botao('Ver o prompt que ela recebe', '', verPrompt)),

    el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', disabled: !ctx.pode('zoe.editar') }, 'Salvar')));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button[type=submit], .btn.primario'), async () => {
      const dados = lerForm(f);
      if (dados.voz_modo === 'teclas') dados.voz_menu = [...linhasMenu.children].map((l) => l.ler()).filter((o) => o.rotulo || o.pedido);
      await api.patch(`/empresas/${ctx.empresaId}/ia`, dados);
      toast('ZOE salva.');
    });
  });

  async function verPrompt() {
    const p = await api.get(`/empresas/${ctx.empresaId}/ia/prompt`);
    modal('O prompt da ZOE', (fechar) => [
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

// ---------- Provedor (IXC) ----------

/**
 * A integração que transforma a atendente num atendente de provedor de verdade: ela consulta o IXC
 * na hora. A sonda testa cada capacidade NESTA instância e a atendente só recebe o que funciona lá.
 */
async function provedorIxc(ctx, alvo) {
  const filas = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;
  const conteudo = el('div');

  const desenhar = async () => {
    const c = await api.get(`/empresas/${ctx.empresaId}/ixc`);
    const f = el('form', { class: 'form colunas' },
      cartao('Conexão com o IXC',
        c.ativo && c.token_configurado
          ? el('div', { class: 'aviso-caixa ok' }, icone('ok'), el('span', {}, `Integração ligada em ${c.url}.`))
          : el('div', { class: 'aviso-caixa aviso' }, icone('alerta'), el('span', {},
            'Integração desligada. Sem ela a ZOE responde dúvidas gerais, mas não consulta contrato, fatura nem conexão.')),
        marcar('Integração ligada', { name: 'ativo', checked: c.ativo }),
        campo('Endereço do IXC', { name: 'url', value: c.url ?? '', placeholder: 'https://ixc.seuprovedor.com.br', required: false }),
        campo(c.token_configurado ? 'Token (vazio mantém o atual)' : 'Token do IXC', { name: 'token', type: 'password', autocomplete: 'off', placeholder: '12:a1b2c3d4...' }),
        el('p', { class: 'pequeno mudo', style: 'margin:0' },
          'O token fica em Configurações > Usuários > Token, no IXC, no formato "id:hash". Use um usuário técnico só para o bot, '
          + 'com permissão de leitura e, se for usar, de desbloqueio e abertura de chamado. Ele é guardado cifrado e nunca volta para esta tela.'),
        campo('Tempo limite por consulta (ms)', { name: 'timeout_ms', type: 'number', value: c.timeout_ms, min: 1000, max: 30000 })),

      cartao('Identificação do cliente',
        el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
          'Nenhum dado de contrato sai antes da confirmação — isso é garantido pela plataforma, não pelo texto do prompt. '
          + 'Quando o telefone já está no cadastro do IXC, a atendente pede só a confirmação curta.'),
        escolha('Confirmar quem é pelo', 'confirmar_por', {
          cpf3: 'Três primeiros números do CPF/CNPJ (mais rápido)',
          nascimento: 'Data de nascimento do titular (mais rígido)',
        }, c.confirmar_por),
        campo('Tentativas antes de transferir', { name: 'max_tentativas', type: 'number', value: c.max_tentativas, min: 1, max: 6 })),

      cartao('O que ela pode fazer sozinha',
        marcar('Desbloqueio de confiança (liberar acesso de quem está em atraso)', { name: 'desbloqueio_ativo', checked: c.desbloqueio_ativo }),
        el('div', { class: 'grade-2' },
          campo('Máximo por cliente no período', { name: 'desbloqueio_limite', type: 'number', value: c.desbloqueio_limite, min: 0, max: 20 }),
          campo('Período (dias)', { name: 'desbloqueio_periodo_dias', type: 'number', value: c.desbloqueio_periodo_dias, min: 1, max: 365 })),
        el('p', { class: 'pequeno mudo', style: 'margin:0 0 10px' }, 'Estourado o limite, ela explica ao cliente e transfere para o financeiro.'),
        marcar('Abrir chamado técnico (ordem de serviço) no IXC', { name: 'chamado_ativo', checked: c.chamado_ativo }),
        campo('Id do assunto padrão do chamado (opcional)', { name: 'assunto_chamado_id', value: c.assunto_chamado_id ?? '', placeholder: 'deixe vazio para o padrão do IXC' })),

      cartao('Para onde transferir',
        escolha('Assuntos financeiros', 'fila_financeira_id', { '': '— fila padrão —', ...Object.fromEntries(filas.map((x) => [x.id, x.nome])) }, c.fila_financeira_id ?? ''),
        escolha('Assuntos técnicos', 'fila_tecnica_id', { '': '— fila padrão —', ...Object.fromEntries(filas.map((x) => [x.id, x.nome])) }, c.fila_tecnica_id ?? '')),

      el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', disabled: !ctx.pode('zoe.editar') }, 'Salvar')));

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(f.querySelector('.btn.primario'), async () => {
        const d = lerForm(f);
        if (!d.token) delete d.token;
        await api.patch(`/empresas/${ctx.empresaId}/ixc`, d);
        toast('Integração salva.');
        await desenhar();
      });
    });

    limpar(conteudo, f, cartaoSonda(c), cartaoAcoes());
  };

  const cartaoSonda = (c) => cartao('O que funciona nesta instância do IXC',
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
      'O IXC muda de versão para versão. A sonda testa cada consulta no SEU servidor e a ZOE passa a receber '
      + 'só as ferramentas que funcionam aqui — em vez de tentar e errar na frente do cliente. A sonda só lê: não abre chamado nem desbloqueia nada.'),
    c.capacidades
      ? tabela(['Capacidade', 'Recurso no IXC', '^Funciona'], Object.entries(c.capacidades).map(([chave, x]) => el('tr', {},
        td(el('div', {}, el('strong', {}, x.nome ?? chave), x.erro ? el('div', { class: 'pequeno erro-bolha' }, x.erro) : null)),
        td(el('code', {}, x.recurso ?? '—')),
        td(x.ok ? icone('ok') : el('span', { class: 'etiqueta erro' }, 'não'), 'centro'))))
      : el('p', { class: 'mudo', style: 'margin:0' }, 'Ainda não testado.'),
    c.testado_em ? el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, `Último teste: ${dataHora(c.testado_em)}`) : null,
    c.ferramentas.length
      ? el('div', { style: 'margin-top:12px' },
        el('strong', { class: 'pequeno' }, 'Ferramentas que a ZOE tem hoje: '),
        el('div', { class: 'perguntas', style: 'margin-top:6px' }, c.ferramentas.map((n) => el('span', { class: 'etiqueta ok' }, n))))
      : null,
    ctx.pode('zoe.editar') ? el('div', { style: 'margin-top:12px' }, botao('Testar agora', 'primario', sondar)) : null);

  const sondar = async () => {
    const r = await api.post(`/empresas/${ctx.empresaId}/ixc/sonda`, {});
    toast(r.conectado ? `Conectado em ${r.ms} ms. ${r.resumo.length} capacidade(s) funcionando.` : 'Não foi possível conectar ao IXC.', !r.conectado);
    await desenhar();
  };

  const cartaoAcoes = () => {
    const lista = el('div', { class: 'mudo' }, 'Carregando…');
    api.get(`/empresas/${ctx.empresaId}/ixc/acoes`).then((d) => {
      limpar(lista,
        d.resumo.length
          ? el('div', { class: 'perguntas', style: 'margin-bottom:12px' }, d.resumo.map((x) =>
            el('span', { class: `etiqueta ${x.falhas ? 'aviso' : ''}` }, `${x.tipo}: ${inteiro(x.total)}${x.falhas ? ` (${x.falhas} falha(s))` : ''}`)))
          : null,
        tabela(['Quando', 'Cliente', 'Ação', '^OK', 'Detalhe', '>ms'], d.itens.slice(0, 60).map((a) => el('tr', {},
          td(dataHora(a.criado_em)),
          td(el('div', {}, a.contato_nome ?? a.telefone ?? '—', a.ixc_cliente_id ? el('div', { class: 'pequeno mudo' }, `IXC ${a.ixc_cliente_id}`) : null)),
          td(a.tipo),
          td(a.sucesso ? icone('ok') : el('span', { class: 'etiqueta erro' }, 'falhou'), 'centro'),
          td(el('span', { class: 'pequeno' }, String(a.detalhe ?? '').slice(0, 120))),
          td(inteiro(a.ms), 'dir num'))),
        'A ZOE ainda não consultou o IXC.'));
    }).catch((e) => limpar(lista, el('p', { class: 'mudo' }, e.message)));
    return cartao('O que a ZOE fez no IXC (auditoria)', lista);
  };

  limpar(alvo, conteudo);
  await desenhar();
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
    cartao('Testar a ZOE',
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
    r.eventos.length ? el('details', {}, el('summary', {}, `${r.eventos.length} passo(s) da ZOE`),
      el('ol', { class: 'passos-ia' }, r.eventos.map((ev) => el('li', {},
        el('strong', {}, ev.tipo === 'ferramenta' ? ev.nome : ev.tipo),
        ev.detalhe ? el('div', { class: 'pequeno mudo' }, String(ev.detalhe).slice(0, 400)) : null,
        ev.tokens_entrada ? el('small', {}, `${inteiro(ev.tokens_entrada)} tokens de entrada · ${inteiro(ev.tokens_saida)} de saída · ${inteiro(ev.ms)} ms`) : null)))) : null);
}

export { telaIa as default };

// ---------- Alertas de rede ----------

// O rótulo longo explica a escolha no formulário; o curto é o que cabe numa coluna de tabela
// sem repetir a mesma frase em toda linha.
const ABRANGENCIAS = {
  chave: 'Só quem está na área (bairro, cidade, OLT, caixa)',
  clientes: 'Só uma lista de clientes',
  todos: 'Todos os clientes da base',
};
const ABRANGENCIA_CURTA = { chave: 'Por área', clientes: 'Por lista', todos: 'Toda a base' };
const SITUACOES = {
  vigente: ['Em vigor', 'ok'], agendado: ['Agendado', 'info'],
  encerrado: ['Encerrado', ''], desligado: ['Desligado', ''],
};

/** ISO para o que o <input type="datetime-local"> entende, no fuso de quem está olhando. */
const paraCampoLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const deCampoLocal = (v) => (v ? new Date(v).toISOString() : null);

async function alertasDeRede(ctx, alvo) {
  const conteudo = el('div');

  const desenhar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/alertas`);
    const vigentes = d.itens.filter((a) => a.situacao === 'vigente');

    limpar(conteudo,
      cartao('Por que isto existe',
        el('p', { class: 'mudo', style: 'margin:0' },
          'O cadastro do IXC nem sempre está atualizado. Se a ZOE decidir sozinha, pelo cadastro, que existe falha na '
          + 'região do cliente, ela vai afirmar coisa errada — e afirmar errado com confiança é pior do que não saber. '
          + 'Aqui a equipe escreve o que está acontecendo de verdade, com período e área, e a ZOE só conta para quem '
          + 'está dentro. Enquanto o cadastro não estiver confiável, quem sabe da falha é você.')),

      vigentes.length
        ? cartao(`Em vigor agora (${vigentes.length})`,
          el('p', { class: 'pequeno mudo', style: 'margin:0 0 10px' },
            'A ZOE confere estes alertas antes de diagnosticar conexão e antes de abrir chamado técnico.'),
          el('div', { class: 'economia-origens' }, vigentes.map((a) => el('div', { class: 'origem-economia' },
            el('strong', {}, a.titulo),
            el('p', { class: 'pequeno', style: 'margin:4px 0' }, `"${a.mensagem}"`),
            el('p', { class: 'pequeno mudo', style: 'margin:0' },
              `${a.tipo_nome} · ${ABRANGENCIAS[a.abrangencia]} · até ${dataHora(a.fim)}`
              + (a.avisados ? ` · ${inteiro(a.avisados)} cliente(s) já avisado(s)` : ' · ninguém avisado ainda'))))))
        : null,

      cartao('Todos os alertas',
        d.itens.length
          ? tabela(['Alerta', 'Tipo', 'Abrange', 'Período', '>Avisados', 'Situação', ''],
            d.itens.map((a) => el('tr', {},
              td(el('div', {},
                el('strong', {}, a.titulo),
                el('div', { class: 'pequeno mudo' }, a.mensagem.length > 90 ? `${a.mensagem.slice(0, 90)}…` : a.mensagem))),
              td(a.tipo_nome),
              td(el('div', {},
                el('span', {}, ABRANGENCIA_CURTA[a.abrangencia] ?? a.abrangencia),
                a.abrangencia === 'chave' && a.chaves.length
                  ? el('div', { class: 'pequeno mudo' }, a.chaves.slice(0, 3).join(', ') + (a.chaves.length > 3 ? ` +${a.chaves.length - 3}` : ''))
                  : a.abrangencia === 'clientes'
                    ? el('div', { class: 'pequeno mudo' }, `${inteiro(a.clientes.length)} cliente(s)`)
                    : null)),
              td(el('div', {}, dataHora(a.inicio), el('div', { class: 'pequeno mudo' }, `até ${dataHora(a.fim)}`))),
              td(inteiro(a.avisados), 'dir num'),
              td(el('span', { class: `etiqueta ${SITUACOES[a.situacao]?.[1] ?? ''}` }, SITUACOES[a.situacao]?.[0] ?? a.situacao)),
              td(!ctx.pode('zoe.alertas') ? null : el('div', { class: 'linha', style: 'gap:4px;justify-content:flex-end' },
                ctx.pode('zoe.alertas') ? botaoIcone('teste', 'Testar em um cliente', () => testarAlerta(ctx, a)) : null,
                ctx.pode('zoe.alertas') ? botaoIcone(a.ativo ? 'encerrar' : 'ok', a.ativo ? 'Desligar' : 'Ligar', async () => {
                  await api.patch(`/empresas/${ctx.empresaId}/alertas/${a.id}`, { ativo: !a.ativo });
                  toast(a.ativo ? 'Alerta desligado.' : 'Alerta ligado.');
                  await desenhar();
                }) : null,
                ctx.pode('zoe.alertas') ? botaoIcone('editar', 'Editar', () => editarAlerta(ctx, d, a, desenhar)) : null,
                ctx.pode('zoe.alertas') ? botaoIcone('lixo', 'Excluir', async () => {
                  if (!await confirmar('Excluir alerta', `"${a.titulo}" será removido. O histórico de quem já foi avisado se perde.`)) return;
                  await api.delete(`/empresas/${ctx.empresaId}/alertas/${a.id}`);
                  toast('Alerta excluído.');
                  await desenhar();
                }, 'perigo') : null), 'dir'))))
          : vazio('Nenhum alerta cadastrado.',
            'Quando houver uma falha em massa ou uma manutenção programada, cadastre aqui: a ZOE passa a avisar quem está na área, '
            + 'em vez de abrir dezenas de chamados do mesmo problema.')));
  };

  limpar(alvo,
    ctx.pode('zoe.alertas')
      ? acoesTopo(botao('Novo alerta', 'primario', async () => {
        const d = await api.get(`/empresas/${ctx.empresaId}/alertas`);
        editarAlerta(ctx, d, null, desenhar);
      }))
      : null,
    conteudo);
  await desenhar();
}

function editarAlerta(ctx, dados, a, depois) {
  const agora = new Date();
  const emSeisHoras = new Date(Date.now() + 6 * 3600_000);
  let abrangencia = a?.abrangencia ?? 'chave';

  const campoChaves = area('Área afetada — um valor por linha', {
    name: 'chaves', rows: 5,
    placeholder: 'Centro\nJardim América\nOLT-03\nCTO-14',
  }, (a?.chaves ?? []).join('\n'));
  const campoClientes = area('Códigos de cliente ou contrato no IXC — um por linha', {
    name: 'clientes', rows: 5, placeholder: '1042\n1177\n1189',
  }, (a?.clientes ?? []).join('\n'));
  const campoCampos = area('Campos do cadastro a comparar — um por linha (vazio = os padrões)', {
    name: 'campos', rows: 3, placeholder: dados.campos_padrao.slice(0, 4).join('\n'),
  }, (a?.campos ?? []).join('\n'));

  const blocoChave = el('div', {}, campoChaves, campoCampos,
    el('p', { class: 'pequeno mudo' },
      `A comparação é exata, sem acento e sem diferenciar maiúscula: "Centro" NÃO pega "Centro Novo". `
      + `Campos padrão: ${dados.campos_padrao.join(', ')}.`));
  const blocoClientes = el('div', {}, campoClientes);
  const aplicar = () => {
    blocoChave.hidden = abrangencia !== 'chave';
    blocoClientes.hidden = abrangencia !== 'clientes';
  };

  return formModal(a ? `Editar "${a.titulo}"` : 'Novo alerta de rede', () => {
    const sel = escolha('Quem recebe este aviso', 'abrangencia', ABRANGENCIAS, abrangencia);
    sel.querySelector('select').addEventListener('change', (e) => { abrangencia = e.target.value; aplicar(); });
    queueMicrotask(aplicar);
    return [
      campo('Título (só a equipe vê)', { name: 'titulo', required: true, maxlength: 120, placeholder: 'Rompimento de fibra no Centro', value: a?.titulo ?? '' }),
      area('O que a ZOE vai dizer ao cliente', { name: 'mensagem', rows: 3, required: true, maxlength: 1000,
        placeholder: 'Já identificamos uma falha que afeta a sua região e a equipe técnica está no local.' }, a?.mensagem ?? ''),
      escolha('Tipo', 'tipo', Object.fromEntries(Object.entries(dados.tipos).map(([k, v]) => [k, v.nome])), a?.tipo ?? 'massiva'),
      sel,
      blocoChave,
      blocoClientes,
      campo('Previsão de normalização (opcional)', { name: 'previsao', maxlength: 200, placeholder: 'até as 18h de hoje', value: a?.previsao ?? '' }),
      el('div', { class: 'grade-2' },
        campo('Começa em', { name: 'inicio', type: 'datetime-local', required: true, value: paraCampoLocal(a?.inicio) || paraCampoLocal(agora.toISOString()) }),
        campo('Termina em', { name: 'fim', type: 'datetime-local', required: true, value: paraCampoLocal(a?.fim) || paraCampoLocal(emSeisHoras.toISOString()) })),
      marcar('Abrir chamado técnico mesmo assim', { name: 'abre_chamado', checked: Boolean(a?.abre_chamado) }),
      el('p', { class: 'pequeno mudo' },
        'Em falha em massa, o normal é NÃO abrir: seriam dezenas de chamados do mesmo problema, e a equipe já está tratando.'),
      marcar('Alerta ligado', { name: 'ativo', checked: a ? Boolean(a.ativo) : true }),
    ];
  }, async (d) => {
    const corpo = {
      titulo: d.titulo, mensagem: d.mensagem, tipo: d.tipo, abrangencia: d.abrangencia,
      chaves: d.chaves ?? '', clientes: d.clientes ?? '', campos: d.campos ?? '',
      previsao: d.previsao || null, abre_chamado: Boolean(d.abre_chamado), ativo: Boolean(d.ativo),
      inicio: deCampoLocal(d.inicio), fim: deCampoLocal(d.fim),
    };
    if (a) await api.patch(`/empresas/${ctx.empresaId}/alertas/${a.id}`, corpo);
    else await api.post(`/empresas/${ctx.empresaId}/alertas`, corpo);
    toast(a ? 'Alerta alterado.' : 'Alerta criado.');
    await depois();
  });
}

/** Prova em quem o alerta pega antes de confiar nele. */
function testarAlerta(ctx, a) {
  return formModal(`Testar "${a.titulo}"`, () => [
    el('p', { class: 'pequeno mudo' },
      'Informe um cliente e veja se ele está dentro deste alerta — e, se não estiver, quais valores do cadastro dele foram comparados.'),
    campo('CPF, CNPJ ou código do cliente no IXC', { name: 'cliente', required: true, autofocus: true }),
  ], async (d) => {
    const r = await api.post(`/empresas/${ctx.empresaId}/alertas/${a.id}/testar`, { cliente: d.cliente });
    if (!r.ok) { toast(r.erro, true); return; }
    modal(`${r.cliente}`, el('div', {},
      el('p', {},
        r.dentro_do_alerta
          ? el('span', { class: 'etiqueta ok' }, 'Está dentro do alerta')
          : el('span', { class: 'etiqueta' }, 'Fora do alerta: a ZOE não vai avisar esta pessoa')),
      r.aviso ? el('p', { class: 'pequeno mudo' }, r.aviso) : null,
      cartao('Chaves do alerta', el('p', { class: 'pequeno', style: 'margin:0' }, r.chaves_do_alerta.join(' · ') || '—')),
      cartao('Valores encontrados no cadastro deste cliente',
        el('p', { class: 'pequeno', style: 'margin:0;word-break:break-word' }, r.valores_do_cliente.join(' · ') || '—'),
        el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' },
          'Para o alerta pegar, uma chave tem de ser igual a um destes valores — sem acento e sem diferenciar maiúscula.'))));
  });
}
