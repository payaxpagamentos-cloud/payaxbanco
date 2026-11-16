import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, campo, lerForm, acao, selo, R, icone, numero, documento, telefone, dataHora, aviso, confirmar, toast,
} from '../../comum/ui.js';
import { mostrarAcesso } from './clientes.js';

const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val ?? '—'));
const TIPO_CONTA = { corrente: 'Conta corrente', pagamento: 'Conta de pagamento', poupanca: 'Poupança' };
const TIPO_PIX = { cnpj: 'CNPJ', email: 'E-mail', telefone: 'Celular', aleatoria: 'Chave aleatória', cpf: 'CPF' };
const tamanho = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Pedidos de abertura de conta feitos no site (payax.com.br/abrir-conta), para a equipe analisar. */
export default async function aberturas({ alvo, params, query, recarregar }) {
  if (params[0]) return detalhe(alvo, params[0], recarregar);

  const filtros = { busca: query.busca ?? '', situacao: query.situacao ?? '', pagina: Number(query.pagina) || 1 };
  const lista = await api.get(`/aberturas${qs(filtros)}`);
  const pendentes = (lista.contagem.nova ?? 0) + (lista.contagem.em_analise ?? 0);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/aberturas${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'busca', rotulo: 'Buscar', valor: filtros.busca, atributos: { placeholder: 'Razão social ou CNPJ' } }),
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(R.situacaoAbertura).map(([k, [t]]) => [k, t])] }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'));

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Abertura de contas'),
        el('p', {}, pendentes ? `${numero(pendentes)} pedido(s) esperando análise` : 'Pedidos feitos pelo site em "Abra sua conta"'))),
    aviso('A conta só abre depois da análise: confira o contrato social, quem assina pela empresa e se a conta de recebimento é da própria empresa. Aprovado, o cliente é criado "em implantação" e o responsável financeiro recebe o acesso.'),
    form,
    tabela({
      colunas: [
        { titulo: 'Protocolo', conteudo: (s) => el('span', { class: 'num' }, s.protocolo) },
        { titulo: 'Empresa', conteudo: (s) => el('span', {}, el('span', { class: 'forte' }, s.razao_social), el('span', { class: 'sub' }, documento(s.cnpj))) },
        { titulo: 'Responsável financeiro', conteudo: (s) => s.financeiro?.nome ?? '—' },
        { titulo: 'Recebido em', conteudo: (s) => dataHora(s.criado_em) },
        { titulo: 'Situação', conteudo: (s) => selo(s.situacao, R.situacaoAbertura) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum pedido de abertura de conta ainda.',
      aoClicar: (s) => ir(`#/aberturas/${s.id}`),
      rodape: paginacao(lista, (p) => ir(`#/aberturas${qs({ ...filtros, pagina: p })}`)),
    }),
  );
}

function destinoDe(e) {
  const ag = [e.destino_agencia, e.destino_agencia_dv].filter(Boolean).join('-');
  const conta = [e.destino_conta, e.destino_conta_dv].filter(Boolean).join('-');
  return [
    e.destino_banco ? par('Banco', `${e.destino_banco} · ISPB ${e.destino_ispb}`) : par('Conta bancária', 'não informada'),
    e.destino_banco ? par('Agência e conta', `${ag} / ${conta} · ${TIPO_CONTA[e.destino_tipo] ?? e.destino_tipo}`) : null,
    e.destino_banco ? par('Titular da conta', `${e.destino_titular} · ${documento(e.destino_documento)}`) : null,
    par('Chave PIX', e.pix_chave ? el('span', { class: 'codigo' }, e.pix_chave) : 'não informada'),
    e.pix_chave ? par('Tipo de chave', TIPO_PIX[e.pix_tipo] ?? e.pix_tipo) : null,
  ];
}

async function detalhe(alvo, id, recarregar) {
  const s = await api.get(`/aberturas/${id}`);
  const e = s.empresa ?? {};
  const r = s.representante ?? {};
  const f = s.financeiro ?? {};
  const aberta = ['nova', 'em_analise'].includes(s.situacao);
  const decide = pode('aberturas.aprovar');
  const endereco = [e.endereco, e.numero, e.complemento, e.bairro].filter(Boolean).join(', ');

  const abrirDocumento = (a) => acao(null, () => api.baixar(`/aberturas/${s.id}/arquivo/${a.indice}`, a.nome));

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {},
        el('a', { class: 'botao sutil', href: '#/aberturas' }, icone('voltar'), 'Abertura de contas'),
        el('h1', {}, s.razao_social),
        el('p', {}, `${documento(s.cnpj)} · protocolo ${s.protocolo} · recebido em ${dataHora(s.criado_em)} · `, selo(s.situacao, R.situacaoAbertura))),
      el('div', { class: 'acoes' },
        s.situacao === 'nova' ? el('button', { class: 'botao sec', onclick: (ev) => acao(ev.currentTarget, async () => {
          await api.post(`/aberturas/${s.id}/analisar`); toast('Pedido marcado em análise.'); recarregar();
        }) }, icone('relogio'), 'Assumir análise') : null,
        aberta && decide ? el('button', { class: 'botao sec', onclick: () => recusar(s, recarregar) }, icone('fechar'), 'Recusar') : null,
        aberta && decide ? el('button', { class: 'botao', onclick: (ev) => aprovar(ev.currentTarget, s, recarregar) }, icone('ok'), 'Aprovar e criar cliente') : null,
        s.cliente_id ? el('a', { class: 'botao', href: `#/clientes/${s.cliente_id}` }, icone('pessoas'), 'Abrir cliente') : null)),
    s.situacao === 'recusada' ? aviso(`Recusado por ${s.analisado_por_nome ?? '—'} em ${dataHora(s.analisado_em)}: ${s.motivo}`, 'erro') : null,
    s.situacao === 'aprovada' ? aviso(`Aprovado por ${s.analisado_por_nome ?? '—'} em ${dataHora(s.analisado_em)}. Cliente criado em implantação: complete o conheça seu cliente (PLD) e a tabela de preços antes de ativar.`, 'ok') : null,
    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Empresa', el('div', { class: 'pares' },
        par('Razão social', e.razao_social), par('Nome fantasia', e.nome_fantasia || '—'), par('CNPJ', documento(e.cnpj)),
        par('E-mail', e.email), par('Telefone', telefone(e.telefone)),
        par('Endereço', endereco || '—'), par('Cidade', [e.cidade, e.uf].filter(Boolean).join('/') || '—'), par('CEP', e.cep ? String(e.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2') : '—'))),
      cartao('Onde receber os valores', el('div', { class: 'pares' }, destinoDe(e)))),
    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Responsável legal', el('div', { class: 'pares' },
        par('Nome', r.nome), par('CPF', documento(r.cpf)), par('Cargo', r.cargo || '—'), par('E-mail', r.email), par('Telefone', telefone(r.telefone)))),
      cartao('Responsável financeiro', el('div', { class: 'pares' },
        par('Nome', f.nome), par('E-mail', f.email), par('Telefone', telefone(f.telefone)),
        par('Acesso', 'Recebe o acesso de administrador à Área do Cliente quando o pedido for aprovado')))),
    el('div', { style: 'margin-top:14px' },
      cartao('Documentos enviados', s.arquivos.length
        ? tabela({
          colunas: [
            { titulo: 'Documento', conteudo: (a) => el('span', {}, el('span', { class: 'forte' }, a.rotulo), el('span', { class: 'sub' }, a.nome)) },
            { titulo: 'Tamanho', dir: true, conteudo: (a) => tamanho(a.tamanho) },
            { titulo: 'Conferência (SHA-256)', conteudo: (a) => el('span', { class: 'codigo', title: a.sha256 }, `${a.sha256.slice(0, 16)}…`) },
            { titulo: '', dir: true, conteudo: (a) => el('button', { class: 'botao sec pequeno', onclick: (ev) => { ev.stopPropagation(); abrirDocumento(a); } }, icone('baixar'), 'Baixar') },
          ],
          itens: s.arquivos,
        })
        : el('p', {}, 'Documentos apagados no fim do prazo de guarda (LGPD).'))),
  );
}

async function aprovar(botao, s, recarregar) {
  const ok = await confirmar({
    titulo: 'Aprovar abertura de conta',
    texto: `Criar o cliente ${s.razao_social} "em implantação" e o acesso de ${s.financeiro?.nome} (${s.financeiro?.email}) à Área do Cliente? Confirme antes que conferiu o contrato social e que a conta de recebimento é da própria empresa.`,
    confirmarTexto: 'Aprovar e criar cliente',
  });
  if (!ok) return;
  await acao(botao, async () => {
    const out = await api.post(`/aberturas/${s.id}/aprovar`);
    toast('Cliente criado em implantação.', 'ok');
    if (out.acesso) {
      const c = await api.get(`/clientes/${out.cliente_id}`);
      mostrarAcesso(c, { nome: out.acesso.nome, email: out.acesso.email, senha: out.acesso.senha_provisoria }, 'Conta aprovada: acesso criado');
    } else if (out.aviso_acesso) toast(out.aviso_acesso, 'aviso');
    recarregar();
  });
}

async function recusar(s, recarregar) {
  const r = await confirmar({ titulo: 'Recusar pedido', texto: `Recusar o pedido de ${s.razao_social}? Informe o motivo (fica no registro).`,
    confirmarTexto: 'Recusar', perigo: true, campoMotivo: true });
  if (!r) return;
  await acao(null, async () => {
    await api.post(`/aberturas/${s.id}/recusar`, { motivo: r.motivo });
    toast('Pedido recusado.');
    recarregar();
  });
}
