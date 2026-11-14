import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, selo, icone, modal, campo, lerForm, acao, toast, aviso, dinheiro, data, dataHora, documento
} from '../../comum/ui.js';

/*
 * PLD — prevenção à lavagem de dinheiro (Lei 9.613/1998).
 * Sigiloso (art. 11, II): só o administrador vê, e nada daqui aparece para o cliente.
 */

const SITUACAO = {
  novo: ['Novo', 'aviso'],
  em_analise: ['Em análise', 'info'],
  a_comunicar: ['Comunicar em 24 h', 'erro'],
  comunicado: ['Comunicado ao Coaf', 'ok'],
  arquivado: ['Arquivado', 'neutra'],
};
const ABAS = [['alertas', 'Alertas'], ['clientes', 'Conheça seu cliente'], ['comunicacoes', 'Comunicações'], ['parametros', 'Parâmetros']];
const analista = () => pode('pld.analisar') || pode('*');

export default async function pld({ alvo, query, recarregar }) {
  const aba = ABAS.some(([k]) => k === query.aba) ? query.aba : 'alertas';
  const d = await api.get('/pld');
  const r = d.resumo;
  const corpo = el('div', { style: 'margin-top:14px' });

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Prevenção à lavagem de dinheiro'),
        el('p', {}, `Monitoramento de operações atípicas, análise e comunicação ao Coaf (Lei 9.613/1998). Última análise: ${r.ultimo_monitoramento ? dataHora(r.ultimo_monitoramento) : 'ainda não rodou'}.`)),
      analista() ? el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const out = await api.post('/pld/monitorar', {});
          toast(out.novos ? `${out.novos} alerta(s) novo(s).` : 'Nenhum alerta novo.', out.novos ? 'aviso' : 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Analisar agora')) : null),

    aviso('Sigiloso. A lei proíbe dar ciência ao cliente de uma análise ou comunicação (art. 11, II): nada desta tela aparece na Área do Cliente, e só o administrador tem acesso.', 'aviso'),

    el('div', { class: 'grade kpis', style: 'margin-top:14px' },
      kpi({ rotulo: 'Alertas abertos', valor: String(r.abertos), apoio: r.atrasos.analise ? `${r.atrasos.analise} com prazo de análise vencido` : 'dentro do prazo', tom: r.atrasos.analise ? 'negativo' : '', ic: 'alerta' }),
      kpi({ rotulo: 'A comunicar ao Coaf', valor: String(r.alertas.a_comunicar), apoio: r.atrasos.comunicacao ? `${r.atrasos.comunicacao} passou das 24 horas` : 'prazo de 24 horas', tom: r.alertas.a_comunicar ? 'negativo' : '', ic: 'relogio' }),
      kpi({ rotulo: 'Cadastros incompletos', valor: `${r.kyc.incompletos} de ${r.kyc.clientes}`, apoio: 'sócios, representantes e revisão', tom: r.kyc.incompletos ? 'negativo' : '', ic: 'pessoas' }),
      kpi({ rotulo: 'Repasses suspensos', valor: String(r.suspensos), apoio: 'por ordem legal', ic: 'escudo' })),

    el('div', { class: 'abas', style: 'margin-top:16px', role: 'tablist' }, ABAS.map(([k, t]) =>
      el('button', { class: k === aba ? 'ativa' : '', role: 'tab', 'aria-selected': String(k === aba), onclick: () => ir(`#/pld${qs({ aba: k })}`) }, t))),
    corpo,
  );

  const telas = { alertas: abaAlertas, clientes: abaClientes, comunicacoes: abaComunicacoes, parametros: abaParametros };
  await telas[aba](corpo, { query, recarregar, regras: d.regras });
}

// ---------------------------------------------------------------- Alertas
async function abaAlertas(alvo, { query, recarregar, regras }) {
  const filtro = query.situacao ?? 'abertos';
  const d = await api.get(`/pld/alertas${qs({ situacao: filtro === 'todos' ? '' : filtro })}`);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/pld${qs({ aba: 'alertas', ...lerForm(form) })}`); } },
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtro,
      opcoes: [['abertos', 'Abertos'], ['todos', 'Todos'], ...Object.entries(SITUACAO).map(([k, [t]]) => [k, t])] }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'));

  montar(alvo,
    form,
    tabela({
      colunas: [
        { titulo: '#', conteudo: (a) => a.id },
        { titulo: 'Regra', conteudo: (a) => el('span', {}, el('span', { class: 'forte' }, a.regra_titulo), el('span', { class: 'sub' }, a.cliente)) },
        { titulo: 'O que aconteceu', conteudo: (a) => a.descricao },
        { titulo: 'Valor', dir: true, conteudo: (a) => (a.valor_centavos ? dinheiro(a.valor_centavos) : '—') },
        { titulo: 'Situação', conteudo: (a) => el('span', {}, selo(a.situacao, SITUACAO),
          a.situacao === 'a_comunicar' ? el('span', { class: 'sub' }, `até ${dataHora(a.prazo_comunicacao)}`)
            : ['novo', 'em_analise'].includes(a.situacao) ? el('span', { class: 'sub' }, `analisar até ${data(a.prazo_analise)}`)
              : a.coaf_protocolo ? el('span', { class: 'sub' }, `protocolo ${a.coaf_protocolo}`) : null) },
      ],
      itens: d.itens,
      vazio: filtro === 'abertos' ? 'Nenhum alerta aberto.' : 'Nenhum alerta com esse filtro.',
      aoClicar: (a) => detalhe(a.id, recarregar),
    }),
    cartao('O que o sistema vigia', el('div', { class: 'regras' }, regras.map((x) =>
      el('div', { class: 'regra' }, el('div', { class: 'regra-topo' }, el('strong', {}, x.titulo)), el('p', { class: 'regra-exige' }, x.porque))))),
  );
}

async function detalhe(id, recarregar) {
  const a = await api.get(`/pld/alertas/${id}`);
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val ?? '—'));
  const texto = el('textarea', { rows: 4, maxlength: 4000, style: 'width:100%' });
  const protocolo = el('input', { maxlength: 80 });
  let m;
  const executar = (botao, rota, corpo, msg) => acao(botao, async () => {
    await api.post(`/pld/alertas/${id}/${rota}`, corpo());
    m.fechar(); toast(msg, 'ok'); recarregar();
  });

  const aberto = ['novo', 'em_analise'].includes(a.situacao);
  const acoes = [];
  if (analista() && aberto) {
    if (a.situacao === 'novo') {
      const b = el('button', { class: 'botao sec' }, 'Assumir análise');
      b.addEventListener('click', () => executar(b, 'assumir', () => ({}), 'Análise assumida.'));
      acoes.push(b);
    }
    const arq = el('button', { class: 'botao sec' }, 'Arquivar');
    arq.addEventListener('click', () => executar(arq, 'arquivar', () => ({ justificativa: texto.value }), 'Alerta arquivado com a justificativa.'));
    const com = el('button', { class: 'botao perigo' }, 'Comunicar ao Coaf');
    com.addEventListener('click', () => executar(com, 'comunicar', () => ({ fundamentacao: texto.value }), 'Decisão registrada: comunique no SISCOAF em até 24 horas.'));
    acoes.push(arq, com);
  }
  if (analista() && a.situacao === 'a_comunicar') {
    const reg = el('button', { class: 'botao' }, 'Registrar protocolo');
    reg.addEventListener('click', () => executar(reg, 'comunicado', () => ({ protocolo: protocolo.value }), 'Comunicação registrada.'));
    acoes.push(reg);
  }

  m = modal({
    titulo: `Alerta #${a.id} · ${a.regra_titulo}`,
    largo: true,
    corpo: [
      el('p', {}, a.descricao),
      a.regra_porque ? el('p', { class: 'regra-exige' }, `Por que isso merece atenção: ${a.regra_porque}`) : null,
      el('div', { class: 'pares', style: 'margin-top:12px' },
        par('Cliente', `${a.cliente} · ${documento(a.cliente_cnpj)}`),
        par('Valor', a.valor_centavos ? dinheiro(a.valor_centavos) : '—'),
        par('Situação', selo(a.situacao, SITUACAO)),
        par('Analisar até', data(a.prazo_analise)),
        par('Analista', a.analista),
        a.decidido_em ? par('Decidido', `${dataHora(a.decidido_em)} por ${a.decidido_por_nome ?? '—'}`) : null,
        a.prazo_comunicacao ? par('Comunicar até', dataHora(a.prazo_comunicacao)) : null,
        a.coaf_protocolo ? par('Protocolo SISCOAF', `${a.coaf_protocolo} · ${dataHora(a.comunicado_em)}`) : null),
      a.analise ? el('div', { style: 'margin-top:12px' }, el('strong', {}, a.situacao === 'arquivado' ? 'Justificativa' : 'Fundamentação'), el('p', { class: 'regra-obs' }, a.analise)) : null,
      analista() && aberto
        ? el('label', { class: 'campo-form', style: 'margin-top:12px' }, el('span', {}, 'Justificativa (para arquivar) ou fundamentação (para comunicar)'), texto,
          el('small', {}, 'Fica guardada por no mínimo 5 anos (art. 10, § 2º). Comunicar abre o prazo de 24 horas do art. 11, II.'))
        : null,
      analista() && a.situacao === 'a_comunicar'
        ? el('label', { class: 'campo-form', style: 'margin-top:12px' }, el('span', {}, 'Protocolo do SISCOAF'), protocolo,
          el('small', {}, 'Faça a comunicação no SISCOAF e registre aqui o protocolo.'))
        : null,
    ],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Fechar'), ...acoes],
  });
}

// ---------------------------------------------------------------- Conheça seu cliente
const linhas = (lista, comDoc) => (lista ?? []).map((p) => [p.nome, comDoc ? (p.documento ?? '') : null, p.qualificacao ?? ''].filter((x) => x !== null).join(' | ')).join('\n');
const lerLinhas = (txt, comDoc) => String(txt ?? '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0])
  .map((p) => (comDoc ? { nome: p[0], documento: p[1] || null, qualificacao: p[2] || null } : { nome: p[0], qualificacao: p[1] || null }));

async function abaClientes(alvo, { recarregar }) {
  const d = await api.get('/pld/clientes');
  montar(alvo,
    tabela({
      colunas: [
        { titulo: 'Cliente', conteudo: (c) => el('span', {}, el('span', { class: 'forte' }, c.cliente), el('span', { class: 'sub' }, documento(c.cnpj))) },
        { titulo: 'Sócios', dir: true, conteudo: (c) => String(c.socios.length) },
        { titulo: 'Representantes', dir: true, conteudo: (c) => String(c.representantes.length) },
        { titulo: 'Revisado', conteudo: (c) => (c.revisado_em ? `${data(c.revisado_em)}${c.revisado_por ? ` · ${c.revisado_por}` : ''}` : '—') },
        { titulo: 'Situação', conteudo: (c) => el('span', {},
          c.completo ? selo('ok', { ok: ['Completo', 'ok'] }) : selo('p', { p: ['Pendente', 'erro'] }),
          c.pendencias.length ? el('span', { class: 'sub' }, c.pendencias.join(' · ')) : null,
          c.bloqueio_repasse ? el('span', { class: 'sub', style: 'color:#a52f2f' }, `Repasse suspenso: ${c.bloqueio_repasse}`) : null) },
      ],
      itens: d.itens,
      vazio: 'Nenhum cliente.',
      aoClicar: analista() ? (c) => editarCliente(c, recarregar) : null,
    }));
}

function editarCliente(c, recarregar) {
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'socios', rotulo: 'Sócios (um por linha: nome | qualificação)', tipo: 'textarea', valor: linhas(c.socios, false), atributos: { rows: 4 } }),
    campo({ nome: 'representantes', rotulo: 'Representantes (um por linha: nome | CPF | cargo)', tipo: 'textarea', valor: linhas(c.representantes, true), atributos: { rows: 3 } }),
    campo({ nome: 'situacao_receita', rotulo: 'Situação do CNPJ na Receita', valor: c.situacao_receita ?? '' }));
  const buscar = el('button', { class: 'botao sec', type: 'button' }, icone('busca'), 'Buscar sócios na Receita');
  buscar.addEventListener('click', () => acao(buscar, async () => {
    const r = await api.get(`/pld/clientes/${c.id}/receita`);
    form.querySelector('[name=socios]').value = linhas(r.socios, false);
    if (r.situacao) form.querySelector('[name=situacao_receita]').value = r.situacao;
    toast(r.socios.length ? `${r.socios.length} sócio(s) encontrados. Confira e salve.` : 'A Receita não devolveu sócios: preencha à mão.', r.socios.length ? 'ok' : 'aviso');
  }));
  const salvar = el('button', { class: 'botao' }, 'Salvar e marcar como revisado');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    const f = lerForm(form);
    await api.put(`/pld/clientes/${c.id}`, { socios: lerLinhas(f.socios, false), representantes: lerLinhas(f.representantes, true), situacao_receita: f.situacao_receita });
    m.fechar(); toast('Cadastro revisado.', 'ok'); recarregar();
  }));
  const ordem = el('button', { class: 'botao sec' }, c.bloqueio_repasse ? 'Liberar repasses' : 'Suspender repasses por ordem legal');
  ordem.addEventListener('click', () => { m.fechar(); ordemLegal(c, recarregar); });

  const m = modal({
    titulo: `Conheça seu cliente · ${c.cliente}`,
    largo: true,
    corpo: [
      el('p', { class: 'regra-exige' }, 'A lei pede identificar quem representa a empresa e os proprietários (Lei 9.613/1998, art. 10, § 1º), e manter o cadastro atualizado. Salvar marca a revisão com a data de hoje.'),
      el('div', { style: 'margin:8px 0' }, buscar),
      form,
    ],
    acoes: [ordem, el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), salvar],
  });
}

function ordemLegal(c, recarregar) {
  const liberar = Boolean(c.bloqueio_repasse);
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    liberar ? null : aviso('É a única exceção ao repasse imediato. Use só com ordem judicial ou determinação legal de indisponibilidade de ativos. O valor fica retido e aparece à parte na Conformidade.', 'aviso'),
    campo({ nome: 'motivo', rotulo: liberar ? 'Motivo da liberação' : 'Motivo', obrigatorio: true, atributos: { maxlength: 300 } }),
    liberar ? null : campo({ nome: 'documento', rotulo: 'Número do ofício ou processo', obrigatorio: true, atributos: { maxlength: 120 } }));
  const ok = el('button', { class: liberar ? 'botao' : 'botao perigo' }, liberar ? 'Liberar repasses' : 'Suspender repasses');
  ok.addEventListener('click', () => acao(ok, async () => {
    await api.post(`/pld/clientes/${c.id}/${liberar ? 'liberar' : 'suspender'}-repasse`, lerForm(form));
    m.fechar(); toast(liberar ? 'Repasses liberados.' : 'Repasses suspensos.', 'ok'); recarregar();
  }));
  const m = modal({ titulo: `${liberar ? 'Liberar' : 'Suspender'} repasses · ${c.cliente}`, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), ok] });
}

// ---------------------------------------------------------------- Comunicações
async function abaComunicacoes(alvo, { recarregar }) {
  const [comunicados, decl] = await Promise.all([api.get('/pld/alertas?situacao=comunicado'), api.get('/pld/declaracoes')]);
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'ano', rotulo: 'Ano', tipo: 'number', valor: String(new Date().getFullYear() - 1) }),
    campo({ nome: 'protocolo', rotulo: 'Protocolo do SISCOAF' }),
    campo({ nome: 'enviado_em', rotulo: 'Enviado em', tipo: 'date' }));
  const registrar = el('button', { class: 'botao', type: 'button' }, 'Registrar declaração');
  registrar.addEventListener('click', () => acao(registrar, async () => {
    await api.post('/pld/declaracoes', lerForm(form)); toast('Declaração registrada.', 'ok'); recarregar();
  }));

  montar(alvo,
    cartao('Comunicações feitas ao Coaf', tabela({
      colunas: [
        { titulo: '#', conteudo: (a) => a.id },
        { titulo: 'Cliente', conteudo: (a) => a.cliente },
        { titulo: 'Regra', conteudo: (a) => a.regra_titulo },
        { titulo: 'Protocolo', conteudo: (a) => a.coaf_protocolo },
      ],
      itens: comunicados.itens,
      vazio: 'Nenhuma comunicação feita.',
    })),
    el('div', { style: 'margin-top:14px' }, cartao('Declaração anual de não ocorrência', [
      el('p', { class: 'regra-exige' }, 'Num ano sem nenhuma comunicação, a lei pede declarar a não ocorrência ao Coaf (art. 11, III). Envie pelo SISCOAF e registre aqui o protocolo.'),
      tabela({
        colunas: [
          { titulo: 'Ano', conteudo: (x) => String(x.ano) },
          { titulo: 'Enviada em', conteudo: (x) => data(x.enviado_em) },
          { titulo: 'Protocolo', conteudo: (x) => x.protocolo },
          { titulo: 'Registrada por', conteudo: (x) => x.registrado_por_nome ?? '—' },
        ],
        itens: decl.itens,
        vazio: 'Nenhuma declaração registrada.',
      }),
      analista() ? el('div', { style: 'margin-top:12px' }, form, el('div', { style: 'margin-top:8px' }, registrar)) : null,
    ])),
  );
}

// ---------------------------------------------------------------- Parâmetros
async function abaParametros(alvo, { recarregar }) {
  const lista = await api.get('/pld/parametros');
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    lista.map((p) => campo({ nome: p.chave, rotulo: p.rotulo, tipo: p.dinheiro ? 'dinheiro' : 'number',
      valor: p.dinheiro ? (p.valor / 100).toFixed(2).replace('.', ',') : String(p.valor),
      ajuda: `padrão: ${p.dinheiro ? dinheiro(p.padrao) : p.padrao}`, atributos: analista() ? {} : { disabled: true } })));
  const salvar = el('button', { class: 'botao', type: 'button' }, 'Salvar parâmetros');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.put('/pld/parametros', lerForm(form)); toast('Parâmetros salvos. Valem a partir da próxima análise.', 'ok'); recarregar();
  }));
  montar(alvo,
    aviso('Os limites devem sair da política de PLD da empresa, compatíveis com o porte da operação (Lei 9.613/1998, art. 10, III). Mudar aqui não apaga alertas já gerados.', 'info'),
    el('div', { style: 'margin-top:14px' }, cartao('Limites das regras', [form, analista() ? el('div', { style: 'margin-top:12px' }, salvar) : null])));
}
