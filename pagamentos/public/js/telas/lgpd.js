import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import { el, montar, cartao, tabela, kpi, selo, icone, modal, campo, lerForm, acao, toast, aviso, data, dataHora, documento } from '../../comum/ui.js';

/*
 * LGPD (Lei 13.709/2018): pedidos dos titulares, incidentes, inventário, retenção e encarregado.
 * Só o administrador: os pedidos trazem dados pessoais.
 */

const SIT_PEDIDO = {
  recebido: ['Recebido', 'aviso'], em_atendimento: ['Em atendimento', 'info'], atendido: ['Atendido', 'ok'], recusado: ['Recusado com motivo', 'neutra'],
};
const RISCO = { em_avaliacao: ['Em avaliação', 'aviso'], relevante: ['Risco relevante', 'erro'], nao_relevante: ['Sem risco relevante', 'neutra'] };
const ABAS = [['pedidos', 'Pedidos dos titulares'], ['incidentes', 'Incidentes'], ['inventario', 'Inventário'], ['retencao', 'Retenção'], ['encarregado', 'Encarregado']];
const atende = () => pode('lgpd.atender') || pode('*');

export default async function lgpd({ alvo, query, recarregar }) {
  const aba = ABAS.some(([k]) => k === query.aba) ? query.aba : 'pedidos';
  const d = await api.get('/lgpd');
  const r = d.resumo;
  const corpo = el('div', { style: 'margin-top:14px' });

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Proteção de dados (LGPD)'),
        el('p', {}, 'Pedidos dos titulares, incidentes de segurança, inventário dos dados, retenção e encarregado.')),
      el('div', { class: 'acoes' }, el('a', { class: 'botao sec', href: 'privacidade', target: '_blank', rel: 'noopener' }, icone('olho'), 'Ver o aviso público'))),

    !r.encarregado.nome ? aviso('Falta cadastrar o encarregado (LGPD, art. 41): o nome e o e-mail dele aparecem no aviso de privacidade.', 'erro') : null,

    el('div', { class: 'grade kpis', style: 'margin-top:14px' },
      kpi({ rotulo: 'Pedidos abertos', valor: String(r.pedidos.abertos), apoio: r.pedidos.vencidos ? `${r.pedidos.vencidos} fora do prazo de 15 dias` : 'prazo de 15 dias', tom: r.pedidos.vencidos ? 'negativo' : '', ic: 'pessoas' }),
      kpi({ rotulo: 'Incidentes abertos', valor: String(r.incidentes.abertos), apoio: r.incidentes.atrasados ? `${r.incidentes.atrasados} sem comunicação no prazo` : '3 dias úteis para comunicar', tom: r.incidentes.atrasados ? 'negativo' : '', ic: 'alerta' }),
      kpi({ rotulo: 'Guarda dos registros', valor: `${r.retencao.anos} anos`, apoio: r.retencao.ultima ? `última anonimização ${dataHora(r.retencao.ultima.em)}` : 'retenção ainda não rodou', ic: 'relogio' }),
      kpi({ rotulo: 'Encarregado', valor: r.encarregado.nome ?? '—', apoio: r.encarregado.email ?? 'não cadastrado', menor: true, tom: r.encarregado.nome ? '' : 'negativo', ic: 'escudo' })),

    el('div', { class: 'abas', style: 'margin-top:16px', role: 'tablist' }, ABAS.map(([k, t]) =>
      el('button', { class: k === aba ? 'ativa' : '', role: 'tab', 'aria-selected': String(k === aba), onclick: () => ir(`#/lgpd${qs({ aba: k })}`) }, t))),
    corpo,
  );

  const telas = { pedidos: abaPedidos, incidentes: abaIncidentes, inventario: abaInventario, retencao: abaRetencao, encarregado: abaEncarregado };
  await telas[aba](corpo, { d, recarregar });
}

// ---------------------------------------------------------------- Pedidos
async function abaPedidos(alvo, { recarregar }) {
  const lista = await api.get('/lgpd/pedidos');
  montar(alvo,
    aviso('Os titulares pedem pelo formulário do aviso de privacidade, que gera o protocolo. A resposta completa sai em até 15 dias (art. 19, II), e a identidade é conferida antes: confirmar a um desconhecido que um CPF paga um provedor já seria vazar dado.', 'info'),
    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Protocolo', conteudo: (p) => el('span', { class: 'num' }, p.protocolo) },
        { titulo: 'Pedido', conteudo: (p) => el('span', {}, el('span', { class: 'forte' }, p.tipo_nome), el('span', { class: 'sub' }, p.titular_nome)) },
        { titulo: 'Recebido', conteudo: (p) => dataHora(p.criado_em) },
        { titulo: 'Prazo', conteudo: (p) => el('span', { style: p.vencido ? 'color:#a52f2f;font-weight:600' : '' }, `${data(p.prazo)}${p.vencido ? ' — vencido' : ''}`) },
        { titulo: 'Situação', conteudo: (p) => selo(p.situacao, SIT_PEDIDO) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum pedido recebido.',
      aoClicar: (p) => detalhePedido(p.id, recarregar),
    })));
}

async function detalhePedido(id, recarregar) {
  const p = await api.get(`/lgpd/pedidos/${id}`);
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val ?? '—'));
  const como = el('input', { maxlength: 300, placeholder: 'Ex.: confirmou pelo e-mail que consta nos boletos' });
  const resposta = el('textarea', { rows: 5, maxlength: 4000, style: 'width:100%' });
  const relatorio = el('pre', { class: 'codigo', style: 'max-height:240px;overflow:auto;white-space:pre-wrap', hidden: true });
  let m;
  const acoes = [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Fechar')];

  if (atende() && p.situacao === 'recebido') {
    const b = el('button', { class: 'botao' }, 'Identidade conferida');
    b.addEventListener('click', () => acao(b, async () => {
      await api.post(`/lgpd/pedidos/${id}/identidade`, { como: como.value });
      m.fechar(); toast('Identidade registrada. Agora responda ao titular.', 'ok'); recarregar();
    }));
    acoes.push(b);
  }
  if (atende() && p.situacao === 'em_atendimento') {
    const gerar = el('button', { class: 'botao sec' }, icone('baixar'), 'Dados que guardamos');
    gerar.addEventListener('click', () => acao(gerar, async () => {
      const r = await api.get(`/lgpd/pedidos/${id}/dados`);
      relatorio.hidden = false;
      relatorio.textContent = JSON.stringify(r, null, 2);
      const blob = new Blob([relatorio.textContent], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `dados-${p.protocolo}.json` });
      document.body.append(a); a.click(); a.remove();
    }));
    const recusar = el('button', { class: 'botao sec' }, 'Recusar com motivo');
    recusar.addEventListener('click', () => acao(recusar, async () => {
      await api.post(`/lgpd/pedidos/${id}/responder`, { resultado: 'recusado', resposta: resposta.value });
      m.fechar(); toast('Resposta registrada.', 'ok'); recarregar();
    }));
    const atender = el('button', { class: 'botao' }, 'Marcar como atendido');
    atender.addEventListener('click', () => acao(atender, async () => {
      await api.post(`/lgpd/pedidos/${id}/responder`, { resultado: 'atendido', resposta: resposta.value });
      m.fechar(); toast('Pedido atendido.', 'ok'); recarregar();
    }));
    acoes.push(gerar, recusar, atender);
  }

  m = modal({
    titulo: `Pedido ${p.protocolo}`,
    largo: true,
    corpo: [
      el('div', { class: 'pares' },
        par('Pedido', p.tipo_nome),
        par('Situação', selo(p.situacao, SIT_PEDIDO)),
        par('Titular', `${p.titular_nome} · ${documento(p.titular_documento)}`),
        par('E-mail', p.titular_email),
        par('Recebido', dataHora(p.criado_em)),
        par('Prazo', data(p.prazo)),
        p.identidade_verificada_em ? par('Identidade', `${p.identidade_como} — ${dataHora(p.identidade_verificada_em)} por ${p.atendente ?? '—'}`) : null),
      p.mensagem ? el('div', { style: 'margin-top:12px' }, el('strong', {}, 'Mensagem do titular'), el('p', { class: 'regra-obs' }, p.mensagem)) : null,
      p.resposta ? el('div', { style: 'margin-top:12px' }, el('strong', {}, `Resposta (${dataHora(p.respondido_em)})`), el('p', { class: 'regra-obs' }, p.resposta)) : null,
      atende() && p.situacao === 'recebido'
        ? el('label', { class: 'campo-form', style: 'margin-top:12px' }, el('span', {}, 'Como a identidade foi conferida'), como,
          el('small', {}, 'Só responda depois de ter certeza de que quem pediu é o titular.'))
        : null,
      atende() && p.situacao === 'em_atendimento'
        ? el('label', { class: 'campo-form', style: 'margin-top:12px' }, el('span', {}, 'Resposta ao titular (envie por e-mail e registre aqui)'), resposta,
          el('small', {}, 'Pedido de eliminação de dado que a lei manda guardar: recuse explicando o prazo de guarda (arts. 16, I, e 18, § 4º).'))
        : null,
      relatorio,
    ],
    acoes,
  });
}

// ---------------------------------------------------------------- Incidentes
async function abaIncidentes(alvo, { recarregar }) {
  const lista = await api.get('/lgpd/incidentes');
  const novo = el('button', { class: 'botao' }, icone('mais'), 'Registrar incidente');
  novo.addEventListener('click', () => registrarIncidente(recarregar));
  montar(alvo,
    aviso('Incidente que possa causar risco ou dano relevante aos titulares é comunicado à ANPD e aos titulares em 3 dias úteis da descoberta (LGPD, art. 48; Resolução CD/ANPD nº 15/2024). Na dúvida sobre o risco, registre já: o prazo corre da descoberta.', 'aviso'),
    atende() ? el('div', { style: 'margin:14px 0' }, novo) : null,
    tabela({
      colunas: [
        { titulo: '#', conteudo: (i) => i.id },
        { titulo: 'Descoberto', conteudo: (i) => data(i.descoberto_em) },
        { titulo: 'O que aconteceu', conteudo: (i) => el('span', {}, i.descricao, el('span', { class: 'sub' }, i.dados_afetados)) },
        { titulo: 'Risco', conteudo: (i) => selo(i.risco, RISCO) },
        { titulo: 'Comunicação', conteudo: (i) => (i.anpd_comunicada_em
          ? `ANPD ${dataHora(i.anpd_comunicada_em)}${i.titulares_comunicados_em ? ' · titulares avisados' : ''}`
          : el('span', { style: i.comunicacao_atrasada ? 'color:#a52f2f;font-weight:600' : '' }, `prazo ${data(i.prazo_comunicacao)}${i.comunicacao_atrasada ? ' — vencido' : ''}`)) },
        { titulo: 'Situação', conteudo: (i) => (i.encerrado_em ? `encerrado ${data(i.encerrado_em)}` : 'aberto') },
      ],
      itens: lista.itens,
      vazio: 'Nenhum incidente registrado.',
      aoClicar: atende() ? (i) => atualizarIncidente(i, recarregar) : null,
    }));
}

function registrarIncidente(recarregar) {
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'descoberto_em', rotulo: 'Descoberto em', tipo: 'date', valor: new Date().toISOString().slice(0, 10), obrigatorio: true }),
    campo({ nome: 'descricao', rotulo: 'O que aconteceu', tipo: 'textarea', obrigatorio: true, atributos: { rows: 3, maxlength: 4000 } }),
    campo({ nome: 'dados_afetados', rotulo: 'Quais dados foram afetados', obrigatorio: true, atributos: { maxlength: 1000 } }),
    campo({ nome: 'titulares_estimados', rotulo: 'Quantos titulares (estimativa)', tipo: 'number' }),
    campo({ nome: 'risco', rotulo: 'Risco aos titulares', tipo: 'select', valor: 'em_avaliacao', opcoes: Object.entries(RISCO).map(([k, [t]]) => [k, t]) }),
    campo({ nome: 'medidas', rotulo: 'Medidas tomadas', tipo: 'textarea', atributos: { rows: 3, maxlength: 4000 } }));
  const salvar = el('button', { class: 'botao' }, 'Registrar');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.post('/lgpd/incidentes', lerForm(form)); m.fechar(); toast('Incidente registrado. O prazo de comunicação está correndo.', 'aviso'); recarregar();
  }));
  const m = modal({ titulo: 'Registrar incidente de segurança', corpo: form, acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), salvar] });
}

function atualizarIncidente(i, recarregar) {
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'risco', rotulo: 'Risco aos titulares', tipo: 'select', valor: i.risco, opcoes: Object.entries(RISCO).map(([k, [t]]) => [k, t]) }),
    campo({ nome: 'medidas', rotulo: 'Medidas tomadas', tipo: 'textarea', valor: i.medidas ?? '', atributos: { rows: 3, maxlength: 4000 } }),
    campo({ nome: 'anpd_protocolo', rotulo: 'Protocolo da comunicação à ANPD', valor: i.anpd_protocolo ?? '' }),
    campo({ nome: 'titulares_comunicados', rotulo: 'Titulares avisados?', tipo: 'select', valor: i.titulares_comunicados_em ? 'true' : 'false', opcoes: [['false', 'Ainda não'], ['true', 'Sim']] }),
    campo({ nome: 'encerrar', rotulo: 'Encerrar o incidente?', tipo: 'select', valor: 'false', opcoes: [['false', 'Não'], ['true', 'Sim']] }));
  const salvar = el('button', { class: 'botao' }, 'Salvar');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.patch(`/lgpd/incidentes/${i.id}`, lerForm(form)); m.fechar(); toast('Incidente atualizado.', 'ok'); recarregar();
  }));
  const m = modal({ titulo: `Incidente #${i.id}`, corpo: [el('p', {}, i.descricao), form], acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), salvar] });
}

// ---------------------------------------------------------------- Inventário
function abaInventario(alvo, { d }) {
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
  montar(alvo,
    aviso('Registro das operações de tratamento (LGPD, art. 37). É a mesma fonte do aviso de privacidade público: mudar o que o sistema trata é mudar o inventário, no código, e o aviso acompanha.', 'info'),
    ...d.inventario.map((x) => el('div', { style: 'margin-top:14px' }, cartao(x.titulo, el('div', { class: 'pares' },
      par('Titulares', x.titulares),
      par('Dados', x.dados.join('; ')),
      par('Finalidade', x.finalidade),
      par('Base legal', x.base_legal),
      par('Compartilhamento', x.compartilhamento.join('; ')),
      par('Guarda', x.retencao),
      par('Papel da PAY AX', x.papel))))));
}

// ---------------------------------------------------------------- Retenção
function abaRetencao(alvo, { d, recarregar }) {
  const u = d.resumo.retencao.ultima;
  const rodar = el('button', { class: 'botao sec' }, icone('atualizar'), 'Aplicar retenção agora');
  rodar.addEventListener('click', () => acao(rodar, async () => {
    const r = await api.post('/lgpd/retencao', {});
    toast(`${r.boletos} título(s) anonimizado(s), ${r.ips} IP(s) apagado(s).`, 'ok'); recarregar();
  }));
  const linha = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, String(val)));
  montar(alvo,
    cartao('Política de guarda', el('div', {},
      el('p', { class: 'regra-exige' }, `Registros financeiros (boletos, pagamentos, lançamentos, avisos do banco, arquivos CNAB, alertas de PLD encerrados e pedidos de titular respondidos): ${d.resumo.retencao.anos} anos depois de concluídos — Lei 9.613/1998, art. 10, § 2º, e prazos fiscais. Depois, o pagador é anonimizado e os arquivos são apagados. Título em aberto nunca é tocado.`),
      el('p', { class: 'regra-exige' }, 'Endereço IP da auditoria: 6 meses (Marco Civil da Internet, art. 15), depois é apagado; o registro da operação continua. Cache de consulta de CEP/CNPJ: apagado ao vencer.'),
      el('p', { class: 'regra-exige' }, 'Cópias de segurança: o sistema mantém as mais recentes e apaga as antigas. Cópia guardada fora do servidor precisa seguir a mesma regra.'))),
    el('div', { style: 'margin-top:14px' }, cartao('Última execução', u
      ? el('div', { class: 'pares' },
        linha('Quando', dataHora(u.em)), linha('Corte', data(u.corte)), linha('Títulos anonimizados', u.boletos),
        linha('Lançamentos', u.lancamentos), linha('Avisos do banco', u.eventos), linha('Alertas de PLD', u.pld),
        linha('Pedidos de titular', u.pedidos), linha('IPs apagados', u.ips), linha('Cache apagado', u.cache), linha('Arquivos CNAB apagados', u.arquivos))
      : el('p', { class: 'vazio' }, 'Ainda não rodou. Roda sozinha uma vez por dia.'),
    atende() ? rodar : null)));
}

// ---------------------------------------------------------------- Encarregado
function abaEncarregado(alvo, { d, recarregar }) {
  const e = d.resumo.encarregado;
  const c = d.resumo.controlador;
  const form = el('form', { class: 'linha-form', onsubmit: (ev) => ev.preventDefault() },
    campo({ nome: 'nome', rotulo: 'Nome do encarregado', valor: e.nome ?? '', obrigatorio: true }),
    campo({ nome: 'email', rotulo: 'E-mail para os titulares', tipo: 'email', valor: e.email ?? '', obrigatorio: true }),
    campo({ nome: 'telefone', rotulo: 'Telefone (opcional)', valor: e.telefone ?? '' }));
  const salvar = el('button', { class: 'botao' }, 'Salvar e publicar');
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.put('/lgpd/encarregado', lerForm(form)); toast('Encarregado publicado no aviso de privacidade.', 'ok'); recarregar();
  }));
  montar(alvo,
    aviso('A identidade e o contato do encarregado são divulgados publicamente, no aviso de privacidade (LGPD, art. 41, § 1º). Ele recebe as reclamações dos titulares e as comunicações da ANPD.', 'info'),
    el('div', { style: 'margin-top:14px' }, cartao('Encarregado', [form, atende() ? el('div', { style: 'margin-top:12px' }, salvar) : null])),
    el('div', { style: 'margin-top:14px' }, cartao('Controladora', el('p', {}, `${c.nome}${c.documento ? ` — CNPJ ${documento(c.documento)}` : ''}. Vem do cadastro da conta bancária (Contas e preços).`))));
}
