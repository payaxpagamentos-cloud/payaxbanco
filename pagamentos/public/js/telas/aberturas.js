/*
 * CRM da abertura de conta: funil por etapas, ficha do pedido (dados, documentos, checklist da análise,
 * proposta comercial com tarifas e limites, histórico de contatos) e a aprovação, que cria o cliente.
 */
import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, campo, lerForm, acao, selo, R, icone, numero, documento, telefone, dataHora, aviso, confirmar,
  toast, modal, dinheiro,
} from '../../comum/ui.js';
import { mostrarAcesso } from './clientes.js';
import { fichaPreco, formPreco } from './precos-comum.js';

const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val || '—'));
const TIPO_CONTA = { corrente: 'Conta corrente', pagamento: 'Conta de pagamento', poupanca: 'Poupança' };
const TIPO_PIX = { cnpj: 'CNPJ', email: 'E-mail', telefone: 'Celular', aleatoria: 'Chave aleatória' };
const BANCOS = { 237: 'Bradesco', '001': 'Banco do Brasil', 104: 'Caixa', 341: 'Itaú', '033': 'Santander', '077': 'Inter', 260: 'Nubank', 336: 'C6 Bank', 748: 'Sicredi', 756: 'Sicoob' };
const INTERACAO = { nota: 'Anotação', ligacao: 'Ligação', email: 'E-mail', whatsapp: 'WhatsApp', reuniao: 'Reunião', sistema: 'Sistema' };
const ICONE_INTERACAO = { nota: 'relatorio', ligacao: 'fone', email: 'info', whatsapp: 'fone', reuniao: 'pessoas', sistema: 'relogio' };
const SISTEMA = { nenhum: 'Não usa / emite pela PAY AX', ixc: 'IXC Provedor', outro: 'Outro sistema' };
const ENTREGA = { padrao: 'Padrão do convênio (rateio Bradesco, PIX se não der)', pix: 'Sempre PIX da PAY AX' };
const tamanho = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const reais = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
const diasDesde = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
const editar = () => pode('aberturas.editar');

// ---------------------------------------------------------------- Funil e lista
export default async function aberturas({ alvo, params, query, recarregar }) {
  if (params[0]) return ficha(alvo, params[0], recarregar);
  const visao = query.visao === 'lista' ? 'lista' : 'funil';
  const cabecalho = (sub) => el('div', { class: 'cabecalho-tela' },
    el('div', {}, el('h1', {}, 'Abertura de contas'), el('p', {}, sub)),
    editar() ? el('div', { class: 'acoes' }, el('button', { class: 'botao', onclick: () => novoContato() }, icone('mais'), 'Novo contato')) : null);
  const abas = el('div', { class: 'abas' },
    el('button', { class: visao === 'funil' ? 'ativa' : '', onclick: () => ir('#/aberturas') }, 'Funil'),
    el('button', { class: visao === 'lista' ? 'ativa' : '', onclick: () => ir('#/aberturas?visao=lista') }, 'Todos os pedidos'));

  if (visao === 'funil') {
    const f = await api.get('/aberturas/funil');
    const c = f.contagem;
    montar(alvo,
      cabecalho(`${numero(f.itens.length)} em andamento · ${numero(c.aprovada ?? 0)} conta(s) aberta(s) · ${numero(c.recusada ?? 0)} recusada(s)`),
      abas,
      el('div', { class: 'funil' }, f.etapas.map((etapa) => {
        const itens = f.itens.filter((x) => x.situacao === etapa.chave);
        return el('section', { class: 'funil-coluna', 'aria-label': etapa.rotulo },
          el('header', {}, el('span', {}, etapa.rotulo), el('span', { class: 'funil-qtd' }, String(itens.length))),
          itens.length ? itens.map(cartaoFunil) : el('p', { class: 'funil-vazio' }, 'Nenhum pedido'));
      })));
    return;
  }

  const filtros = { busca: query.busca ?? '', situacao: query.situacao ?? '', pagina: Number(query.pagina) || 1, visao: 'lista' };
  const lista = await api.get(`/aberturas${qs({ ...filtros, visao: undefined })}`);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/aberturas${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'busca', rotulo: 'Buscar', valor: filtros.busca, atributos: { placeholder: 'Razão social ou CNPJ' } }),
    campo({ nome: 'situacao', rotulo: 'Etapa', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(R.situacaoAbertura).map(([k, [t]]) => [k, t])] }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'));
  montar(alvo,
    cabecalho(`${numero(lista.total)} pedido(s)`),
    abas,
    form,
    tabela({
      colunas: [
        { titulo: 'Protocolo', conteudo: (s) => el('span', { class: 'num' }, s.protocolo) },
        { titulo: 'Empresa', conteudo: (s) => el('span', {}, el('span', { class: 'forte' }, s.razao_social), el('span', { class: 'sub' }, documento(s.cnpj))) },
        { titulo: 'Origem', conteudo: (s) => (s.origem === 'equipe' ? 'Equipe' : 'Site') },
        { titulo: 'Responsável', conteudo: (s) => s.responsavel_nome ?? '—' },
        { titulo: 'Recebido em', conteudo: (s) => dataHora(s.criado_em) },
        { titulo: 'Etapa', conteudo: (s) => selo(s.situacao, R.situacaoAbertura) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum pedido de abertura de conta ainda.',
      aoClicar: (s) => ir(`#/aberturas/${s.id}`),
      rodape: paginacao(lista, (p) => ir(`#/aberturas${qs({ ...filtros, pagina: p })}`)),
    }));
}

function cartaoFunil(x) {
  const dias = diasDesde(x.atualizado_em);
  return el('a', { class: 'funil-cartao', href: `#/aberturas/${x.id}` },
    el('strong', {}, x.nome_fantasia || x.razao_social),
    el('span', { class: 'sub' }, `${documento(x.cnpj)} · ${x.protocolo}`),
    el('span', { class: 'funil-linha' }, icone('pessoas'), x.responsavel_nome ?? 'Sem responsável'),
    el('span', { class: 'funil-rodape' },
      el('span', { class: `selo ${x.origem === 'equipe' ? 'neutra' : 'info'}` }, x.origem === 'equipe' ? 'Equipe' : 'Site'),
      x.tem_proposta ? el('span', { class: 'selo ok' }, 'Proposta') : null,
      x.pendencias ? el('span', { class: 'selo aviso', title: 'Pendências para aprovar' }, `${x.pendencias} pend.`) : el('span', { class: 'selo ok' }, 'Pronto'),
      el('span', { class: `funil-dias${dias >= 3 ? ' parado' : ''}`, title: 'Dias sem movimento' }, dias ? `${dias}d` : 'hoje')));
}

/** Contato da equipe (prospecção): CNPJ, razão social e com quem falar. O resto se completa na ficha. */
function novoContato() {
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'cnpj', rotulo: 'CNPJ', obrigatorio: true }),
      campo({ nome: 'razao_social', rotulo: 'Razão social', obrigatorio: true })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'nome', rotulo: 'Contato (nome)' }),
      campo({ nome: 'email', rotulo: 'E-mail do contato', tipo: 'email' }),
      campo({ nome: 'telefone', rotulo: 'Telefone do contato' })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'observacao', rotulo: 'Como chegou / observação', tipo: 'textarea' })));
  const botao = el('button', { class: 'botao' }, 'Criar contato');
  botao.addEventListener('click', () => acao(botao, async () => {
    const f = lerForm(form);
    const s = await api.post('/aberturas', { empresa: { cnpj: f.cnpj, razao_social: f.razao_social },
      financeiro: { nome: f.nome, email: f.email, telefone: f.telefone }, observacao: f.observacao });
    m.fechar();
    toast('Contato criado na prospecção.', 'ok');
    ir(`#/aberturas/${s.id}`);
  }));
  const m = modal({ titulo: 'Novo contato (prospecção)', corpo: form, acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

// ---------------------------------------------------------------- Ficha do pedido
async function ficha(alvo, id, recarregar) {
  const s = await api.get(`/aberturas/${id}`);
  const aberta = !['aprovada', 'recusada'].includes(s.situacao);
  const podeEditar = aberta && editar();
  const e = s.empresa;
  const etapas = Object.entries(R.situacaoAbertura).filter(([k]) => !['aprovada', 'recusada'].includes(k));

  const trilha = el('ol', { class: 'trilha' }, etapas.map(([k, [t]], i) => {
    const atual = etapas.findIndex(([x]) => x === s.situacao);
    const estado = !aberta ? 'feita' : i < atual ? 'feita' : i === atual ? 'atual' : '';
    return el('li', { class: estado },
      podeEditar && k !== s.situacao
        ? el('button', { type: 'button', title: `Mover para ${t}`, onclick: (ev) => acao(ev.currentTarget, async () => { await api.put(`/aberturas/${s.id}/etapa`, { etapa: k }); recarregar(); }) },
          el('span', { class: 'n' }, String(i + 1)), t)
        : el('span', { class: 'passo' }, el('span', { class: 'n' }, String(i + 1)), t));
  }));

  const prontos = aberta && !s.pendencias?.length;
  const pendencias = aberta
    ? (s.pendencias.length
      ? el('div', { class: 'aviso aviso-amarelo' }, icone('alerta'),
        el('div', {}, el('strong', {}, 'Para aprovar, falta:'), el('ul', { class: 'lista-pend' }, s.pendencias.map((p) => el('li', {}, p)))))
      : aviso('Tudo conferido e proposta definida: pronto para abrir a conta.', 'ok'))
    : s.situacao === 'recusada'
      ? aviso(`Recusado por ${s.analisado_por_nome ?? '—'} em ${dataHora(s.analisado_em)}: ${s.motivo}`, 'erro')
      : aviso(`Conta aberta por ${s.analisado_por_nome ?? '—'} em ${dataHora(s.analisado_em)}. Cliente criado em implantação com a proposta: complete o PLD (sócios) e ative quando estiver pronto.`, 'ok');

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {},
        el('a', { class: 'botao sutil', href: '#/aberturas' }, icone('voltar'), 'Abertura de contas'),
        el('h1', {}, e.nome_fantasia || s.razao_social),
        el('p', {}, `${s.razao_social} · ${documento(s.cnpj)} · ${s.protocolo} · ${s.origem === 'equipe' ? 'contato da equipe' : 'pedido pelo site'} em ${dataHora(s.criado_em)} · `,
          selo(s.situacao, R.situacaoAbertura))),
      el('div', { class: 'acoes' },
        aberta && pode('aberturas.aprovar') ? el('button', { class: 'botao sec', onclick: () => recusar(s, recarregar) }, icone('fechar'), 'Recusar') : null,
        aberta && pode('aberturas.aprovar') ? el('button', { class: 'botao', disabled: !prontos, title: prontos ? '' : 'Resolva as pendências primeiro',
          onclick: (ev) => aprovar(ev.currentTarget, s, recarregar) }, icone('ok'), 'Aprovar e abrir conta') : null,
        s.cliente_id ? el('a', { class: 'botao', href: `#/clientes/${s.cliente_id}` }, icone('pessoas'), 'Abrir cliente') : null)),
    trilha,
    pendencias,
    el('div', { class: 'crm-grade' },
      el('div', { class: 'crm-principal' },
        blocoProposta(s, recarregar),
        cartao('Empresa e recebimento', el('div', { class: 'grade duas crm-sem-borda' },
          el('div', { class: 'pares' },
            par('Razão social', e.razao_social), par('Nome fantasia', e.nome_fantasia), par('CNPJ', documento(e.cnpj)),
            par('E-mail', e.email), par('Telefone', e.telefone ? telefone(e.telefone) : ''),
            par('Endereço', [e.endereco, e.numero, e.complemento, e.bairro].filter(Boolean).join(', ')),
            par('Cidade', [e.cidade, e.uf].filter(Boolean).join('/')), par('CEP', e.cep)),
          el('div', { class: 'pares' },
            par('Banco', s.destino.banco ? `${s.destino.banco} · ${BANCOS[s.destino.banco] ?? 'ISPB ' + (s.destino.ispb || '—')}` : ''),
            par('Agência e conta', s.destino.conta ? `${[s.destino.agencia, s.destino.agencia_dv].filter(Boolean).join('-')} / ${[s.destino.conta, s.destino.conta_dv].filter(Boolean).join('-')}` : ''),
            par('Tipo de conta', TIPO_CONTA[s.destino.tipo] ?? s.destino.tipo),
            par('Chave PIX', s.destino.pix_chave ? el('span', { class: 'codigo' }, s.destino.pix_chave) : ''),
            par('Tipo de chave', TIPO_PIX[s.destino.pix_tipo] ?? s.destino.pix_tipo))),
          podeEditar ? el('button', { class: 'botao sec pequeno', onclick: () => editarDados(s, recarregar) }, icone('config'), 'Editar dados') : null),
        el('div', { class: 'grade duas' },
          cartao('Responsável legal', el('div', { class: 'pares' },
            par('Nome', s.representante.nome), par('CPF', s.representante.cpf ? documento(s.representante.cpf) : ''), par('Cargo', s.representante.cargo),
            par('E-mail', s.representante.email), par('Telefone', s.representante.telefone ? telefone(s.representante.telefone) : ''))),
          cartao('Responsável financeiro', el('div', { class: 'pares' },
            par('Nome', s.financeiro.nome), par('E-mail', s.financeiro.email), par('Telefone', s.financeiro.telefone ? telefone(s.financeiro.telefone) : ''),
            par('Acesso', 'Administrador da Área do Cliente quando a conta abrir')))),
        cartao('Documentos', s.arquivos.length
          ? tabela({
            colunas: [
              { titulo: 'Documento', conteudo: (a) => el('span', {}, el('span', { class: 'forte' }, a.rotulo), el('span', { class: 'sub' }, `${a.nome} · ${dataHora(a.enviado_em)}`)) },
              { titulo: 'Tamanho', dir: true, conteudo: (a) => tamanho(a.tamanho) },
              { titulo: 'SHA-256', conteudo: (a) => el('span', { class: 'codigo', title: a.sha256 }, `${a.sha256.slice(0, 12)}…`) },
              { titulo: '', dir: true, conteudo: (a) => el('button', { class: 'botao sec pequeno', onclick: (ev) => { ev.stopPropagation(); acao(null, () => api.baixar(`/aberturas/${s.id}/arquivo/${a.indice}`, a.nome)); } }, icone('baixar'), 'Baixar') },
            ],
            itens: s.arquivos,
          })
          : el('p', { class: 'sub' }, s.situacao === 'recusada' ? 'Documentos apagados no fim do prazo de guarda (LGPD).' : 'Nenhum documento anexado.'),
          podeEditar ? el('button', { class: 'botao sec pequeno', onclick: () => anexar(s, recarregar) }, icone('importar'), 'Anexar') : null)),
      el('div', { class: 'crm-lateral' },
        await blocoResponsavel(s, podeEditar, recarregar),
        blocoChecklist(s, podeEditar, recarregar),
        blocoHistorico(s, recarregar))));
}

async function blocoResponsavel(s, podeEditar, recarregar) {
  if (!podeEditar) return cartao('Responsável', el('p', {}, s.responsavel_nome ?? '—'));
  const equipe = await api.get('/aberturas/equipe');
  const sel = campo({ nome: 'usuario_id', rotulo: 'Quem cuida deste pedido', tipo: 'select', valor: s.responsavel_id ?? '',
    opcoes: [['', 'Ninguém ainda'], ...equipe.map((u) => [u.id, u.nome])] });
  sel.querySelector('select').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    acao(null, async () => { await api.put(`/aberturas/${s.id}/responsavel`, { usuario_id: ev.target.value }); toast('Responsável definido.'); recarregar(); });
  });
  return cartao('Responsável', sel);
}

function blocoChecklist(s, podeEditar, recarregar) {
  const feitos = s.checklist.filter((c) => c.feito).length;
  const consultar = el('button', { class: 'botao sec pequeno', onclick: (ev) => acao(ev.currentTarget, async () => {
    const d = await api.get(`/consultas/cnpj/${s.cnpj}`);
    modal({ titulo: 'CNPJ na Receita Federal', corpo: el('div', { class: 'pares', style: 'grid-template-columns:1fr' },
      par('Razão social', d.razao_social), par('Situação', d.situacao ?? '—'), par('Atividade', d.atividade ?? d.cnae_descricao ?? '—'),
      par('Abertura', d.abertura ?? d.data_abertura ?? '—'), par('Fonte', d.fonte === 'apibrasil' ? 'API Brasil' : 'Fonte pública')) });
  }) }, icone('busca'), 'Consultar Receita');
  return cartao(`Análise · ${feitos}/${s.checklist.length}`, el('div', { class: 'checklist' },
    s.checklist.map((c) => el('label', { class: `check${c.feito ? ' feito' : ''}` },
      el('input', { type: 'checkbox', checked: c.feito, disabled: !podeEditar,
        onchange: (ev) => acao(null, async () => { await api.put(`/aberturas/${s.id}/checklist/${c.chave}`, { feito: ev.target.checked }); recarregar(); }) }),
      el('span', {}, c.rotulo, c.feito ? el('small', {}, `${c.por} · ${dataHora(c.em)}`) : null)))), consultar);
}

function blocoHistorico(s, recarregar) {
  const form = editar() ? el('form', { class: 'historico-form', onsubmit: (ev) => ev.preventDefault() },
    campo({ nome: 'tipo', rotulo: 'Registrar', tipo: 'select', valor: 'nota', opcoes: Object.entries(INTERACAO).filter(([k]) => k !== 'sistema') }),
    campo({ nome: 'texto', rotulo: 'O que foi conversado', tipo: 'textarea', atributos: { rows: 3, maxlength: 2000 } })) : null;
  const botao = form ? el('button', { class: 'botao pequeno', onclick: (ev) => acao(ev.currentTarget, async () => {
    const f = lerForm(form);
    if (!f.texto.trim()) { form.querySelector('textarea').focus(); return; }
    await api.post(`/aberturas/${s.id}/interacoes`, f);
    recarregar();
  }) }, 'Registrar') : null;
  return cartao('Histórico', el('div', {},
    form, botao ? el('div', { style: 'display:flex;justify-content:flex-end;margin:8px 0 4px' }, botao) : null,
    el('ol', { class: 'linha-tempo' }, s.interacoes.map((i) => el('li', { class: i.tipo },
      el('span', { class: 'ic' }, icone(ICONE_INTERACAO[i.tipo] ?? 'info')),
      el('div', {},
        el('div', { class: 'quem' }, el('strong', {}, INTERACAO[i.tipo] ?? i.tipo), ` · ${i.usuario_nome ?? 'Site'} · ${dataHora(i.criado_em)}`),
        el('div', { class: 'texto' }, i.texto)))))));
}

// ---------------------------------------------------------------- Proposta comercial
function blocoProposta(s, recarregar) {
  const p = s.proposta;
  const podeDefinir = !['aprovada', 'recusada'].includes(s.situacao) && pode('precos.editar');
  const botao = podeDefinir ? el('button', { class: `botao ${p ? 'sec ' : ''}pequeno`, onclick: () => definirProposta(s, recarregar) },
    icone(p ? 'config' : 'mais'), p ? 'Alterar proposta' : 'Definir proposta') : null;
  if (!p) {
    return cartao('Proposta comercial', el('p', { class: 'sub' },
      'Tarifas, limites e condições que valem para o cliente quando a conta abrir. Defina antes de aprovar.'), botao);
  }
  return cartao('Proposta comercial', el('div', {},
    fichaPreco(p.preco),
    el('h3', { class: 'crm-sub' }, 'Limites e condições'),
    el('div', { class: 'pares cols-3' },
      par('Limite por boleto', dinheiro(p.limite_boleto_centavos)),
      par('Limite de emissão no mês', p.limite_mensal_centavos ? dinheiro(p.limite_mensal_centavos) : 'sem limite'),
      par('Como recebe', ENTREGA[p.entrega] ?? p.entrega),
      par('Faturamento mensal informado', p.faturamento_mensal_centavos ? dinheiro(p.faturamento_mensal_centavos) : ''),
      par('Boletos por mês (estimado)', p.boletos_mes !== null ? numero(p.boletos_mes) : ''),
      par('Sistema de gestão', SISTEMA[p.sistema] ?? p.sistema)),
    p.observacao ? el('p', { class: 'crm-obs' }, p.observacao) : null,
    el('p', { class: 'sub', style: 'margin-top:10px' }, `Definida por ${p.definida_por} em ${dataHora(p.definida_em)}.`)), botao);
}

async function definirProposta(s, recarregar) {
  const p = s.proposta;
  const base = p?.preco ?? (await api.get('/contas/precos-padrao')).vigente;
  const form = formPreco(base);
  // A vigência é o dia em que a conta abrir; a observação da tabela fica na proposta.
  form.querySelector('[name="vigencia_inicio"]')?.closest('.campo-form')?.remove();
  form.append(
    el('h3', { style: 'font-size:13px;font-weight:650;margin:18px 0 8px' }, 'Limites e condições'),
    el('div', { class: 'linha-form cols-3' },
      campo({ nome: 'limite_boleto', rotulo: 'Limite por boleto', tipo: 'dinheiro', valor: reais(p?.limite_boleto_centavos ?? 5000000), obrigatorio: true }),
      campo({ nome: 'limite_mensal', rotulo: 'Limite de emissão no mês', tipo: 'dinheiro', valor: reais(p?.limite_mensal_centavos), ajuda: 'Vazio = sem limite mensal' }),
      campo({ nome: 'entrega', rotulo: 'Como recebe', tipo: 'select', valor: p?.entrega ?? 'padrao', opcoes: Object.entries(ENTREGA) })),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' },
      campo({ nome: 'faturamento_mensal', rotulo: 'Faturamento mensal informado', tipo: 'dinheiro', valor: reais(p?.faturamento_mensal_centavos), ajuda: 'Para o PLD: volume compatível' }),
      campo({ nome: 'boletos_mes', rotulo: 'Boletos por mês (estimado)', valor: p?.boletos_mes ?? '', atributos: { inputmode: 'numeric' } }),
      campo({ nome: 'sistema', rotulo: 'Sistema de gestão', tipo: 'select', valor: p?.sistema ?? 'nenhum', opcoes: Object.entries(SISTEMA) })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'observacao_proposta', rotulo: 'Condições combinadas', tipo: 'textarea', valor: p?.observacao ?? '',
      atributos: { maxlength: 500, placeholder: 'Ex.: 3 primeiros meses sem tarifa de emissão; revisão em 6 meses.' } })));
  const botao = el('button', { class: 'botao' }, 'Salvar proposta');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.put(`/aberturas/${s.id}/proposta`, lerForm(form));
    m.fechar();
    toast('Proposta salva.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'Proposta comercial: tarifas e limites', corpo: form, largo: true,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

// ---------------------------------------------------------------- Dados e documentos
function editarDados(s, recarregar) {
  const g = (grupo, nome, rotulo, extra = {}) => campo({ nome: `${grupo}.${nome}`, rotulo, valor: s[grupo]?.[nome] ?? '', ...extra });
  const titulo = (t) => el('h3', { style: 'font-size:13px;font-weight:650;margin:16px 0 8px' }, t);
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    titulo('Empresa'),
    el('div', { class: 'linha-form cols-3' }, g('empresa', 'cnpj', 'CNPJ', { obrigatorio: true }), g('empresa', 'razao_social', 'Razão social', { obrigatorio: true }), g('empresa', 'nome_fantasia', 'Nome fantasia')),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' }, g('empresa', 'email', 'E-mail'), g('empresa', 'telefone', 'Telefone'), g('empresa', 'cep', 'CEP')),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' }, g('empresa', 'endereco', 'Endereço'), g('empresa', 'numero', 'Número'), g('empresa', 'complemento', 'Complemento')),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' }, g('empresa', 'bairro', 'Bairro'), g('empresa', 'cidade', 'Cidade'), g('empresa', 'uf', 'UF')),
    titulo('Responsável legal'),
    el('div', { class: 'linha-form cols-3' }, g('representante', 'nome', 'Nome'), g('representante', 'cpf', 'CPF'), g('representante', 'cargo', 'Cargo')),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' }, g('representante', 'email', 'E-mail'), g('representante', 'telefone', 'Telefone')),
    titulo('Responsável financeiro'),
    el('div', { class: 'linha-form cols-3' }, g('financeiro', 'nome', 'Nome'), g('financeiro', 'email', 'E-mail'), g('financeiro', 'telefone', 'Telefone')),
    titulo('Conta bancária e chave PIX (da própria empresa)'),
    el('div', { class: 'linha-form cols-4' },
      g('destino', 'banco', 'Banco (código)', { atributos: { placeholder: '237' } }), g('destino', 'ispb', 'ISPB (outros bancos)'),
      g('destino', 'tipo', 'Tipo', { tipo: 'select', opcoes: Object.entries(TIPO_CONTA) }), g('destino', 'agencia', 'Agência')),
    el('div', { class: 'linha-form cols-4', style: 'margin-top:12px' },
      g('destino', 'agencia_dv', 'Dígito da agência'), g('destino', 'conta', 'Conta'), g('destino', 'conta_dv', 'Dígito da conta'),
      g('destino', 'pix_tipo', 'Tipo de chave', { tipo: 'select', opcoes: Object.entries(TIPO_PIX) })),
    el('div', { style: 'margin-top:12px' }, g('destino', 'pix_chave', 'Chave PIX')));
  const botao = el('button', { class: 'botao' }, 'Salvar dados');
  botao.addEventListener('click', () => acao(botao, async () => {
    const plano = lerForm(form);
    const corpo = {};
    for (const [k, v] of Object.entries(plano)) { const [grupo, nome] = k.split('.'); (corpo[grupo] ??= {})[nome] = v; }
    await api.put(`/aberturas/${s.id}/dados`, corpo);
    m.fechar();
    toast('Dados salvos.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'Dados do pedido', corpo: form, largo: true, acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function anexar(s, recarregar) {
  const arquivo = el('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png' });
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'tipo', rotulo: 'Documento', tipo: 'select', valor: 'contrato_social',
      opcoes: [['contrato_social', 'Contrato social (ou alteração consolidada)'], ['documento_responsavel', 'Documento do responsável legal']] }),
    el('label', { class: 'campo-form', style: 'margin-top:12px' }, el('span', {}, 'Arquivo (PDF, JPG ou PNG, até 8 MB)'), arquivo));
  const botao = el('button', { class: 'botao' }, 'Anexar');
  botao.addEventListener('click', () => acao(botao, async () => {
    const f = arquivo.files[0];
    if (!f) throw new Error('Escolha o arquivo.');
    if (f.size > 8 * 1024 * 1024) throw new Error('O arquivo passa de 8 MB.');
    const conteudo = await new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = falha; r.readAsDataURL(f); });
    await api.post(`/aberturas/${s.id}/documentos`, { tipo: lerForm(form).tipo, nome: f.name, conteudo });
    m.fechar();
    toast('Documento anexado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'Anexar documento', corpo: form, acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

// ---------------------------------------------------------------- Decisão
async function aprovar(botao, s, recarregar) {
  const ok = await confirmar({
    titulo: 'Aprovar e abrir a conta',
    texto: `Criar o cliente ${s.razao_social} "em implantação", com a proposta (tarifas e limites), e o acesso de ${s.financeiro?.nome} (${s.financeiro?.email}) à Área do Cliente?`,
    confirmarTexto: 'Aprovar e abrir conta',
  });
  if (!ok) return;
  await acao(botao, async () => {
    const out = await api.post(`/aberturas/${s.id}/aprovar`);
    toast('Conta aberta: cliente criado em implantação.', 'ok');
    if (out.acesso) {
      const c = await api.get(`/clientes/${out.cliente_id}`);
      mostrarAcesso(c, { nome: out.acesso.nome, email: out.acesso.email, senha: out.acesso.senha_provisoria }, 'Conta aberta: acesso criado');
    } else if (out.aviso_acesso) toast(out.aviso_acesso, 'aviso');
    recarregar();
  });
}

async function recusar(s, recarregar) {
  const r = await confirmar({ titulo: 'Recusar pedido', texto: `Recusar o pedido de ${s.razao_social}? Informe o motivo (fica no histórico).`,
    confirmarTexto: 'Recusar', perigo: true, campoMotivo: true });
  if (!r) return;
  await acao(null, async () => {
    await api.post(`/aberturas/${s.id}/recusar`, { motivo: r.motivo });
    toast('Pedido recusado.');
    recarregar();
  });
}
