/** Inventário (mídia kit) e circuitos: o que a rede tem para vender e por quanto. */
import { api, qs, baixar } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, campo, escolha, marcar, area, lerForm, centavos, reaisCampo,
  inteiro, dinheiro, dataBr, etiqueta, CATEGORIAS, ORIENTACOES,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';
import { gerarProposta } from './proposta.js';

export async function inventario(ctx) {
  const corpo = el('div', { class: 'coluna' });

  const pintar = async () => {
    const d = await api.get('/painel/inventario');
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Pontos ativos', valor: inteiro(d.totais.pontos), ic: 'pontos', nota: `${d.totais.cidades} cidade(s)` }),
        indicador({ rotulo: 'Telas', valor: inteiro(d.totais.telas), ic: 'telas', cor: 'roxo' }),
        indicador({ rotulo: 'Passagens por dia', valor: inteiro(d.totais.publico_dia), ic: 'pessoas', cor: 'ciano', nota: `${inteiro(d.totais.publico_dia * 30)} por mês` }),
        indicador({ rotulo: 'Unidades atendidas', valor: inteiro(d.totais.unidades), ic: 'pontos', cor: 'laranja', nota: 'apartamentos, salas e lojas' })),

      cartao('Circuitos',
        el('p', { class: 'pequeno mudo', style: 'margin-top:-8px' },
          'O pacote que o comercial vende: um conjunto de telas por regra, com a audiência somada e o preço de tabela. '
          + 'Ao criar a campanha, escolher o circuito já define onde ela passa.'),
        d.circuitos.length
          ? tabela([
            [(c) => el('div', {}, el('div', {}, c.nome), c.descricao ? el('div', { class: 'pequeno mudo' }, c.descricao) : null), 'Circuito'],
            [(c) => inteiro(c.telas), 'Telas', 'num dir'],
            [(c) => inteiro(c.pontos), 'Pontos', 'num dir'],
            [(c) => `${c.paisagem}/${c.retrato}`, 'Paisagem/Retrato', 'num dir'],
            [(c) => inteiro(c.publico_mes), 'Público/mês', 'num dir'],
            [(c) => `${c.insercoes_hora}/h`, 'Inserções', 'num dir'],
            [(c) => (c.valor_mes_centavos ? dinheiro(c.valor_mes_centavos) : '—'), 'Tabela/mês', 'num dir'],
            [(c) => (c.cpm_centavos ? dinheiro(c.cpm_centavos) : '—'), 'CPM', 'num dir'],
            [(c) => (c.ativo ? etiqueta('Ativo', 'ok') : etiqueta('Inativo', '')), 'Situação'],
          ], d.circuitos, { aoClicar: (c) => abrirCircuito(c.id, pintar) })
          : vazio('Nenhum circuito. Crie pacotes como "Residencial Campinas" ou "Academias" para vender em bloco.'),
        el('button', { class: 'btn primario', style: 'margin-top:12px', onclick: () => editarCircuito(null, pintar) }, icone('mais'), 'Novo circuito')),

      cartao('Pontos e telas',
        el('div', { class: 'linha entre', style: 'margin-top:-8px;margin-bottom:10px' },
          el('span', { class: 'pequeno mudo' }, `Tabela: ${dinheiro(d.mensalidade_tela_centavos)} por tela/mês · CPM ${dinheiro(d.cpm_centavos)}`),
          el('button', { class: 'btn pequeno', onclick: (e) => acao(e.target, () => baixar('/painel/inventario?csv=1', 'inventario.csv')) }, icone('baixar'), 'Baixar CSV')),
        tabela([
          [(p) => el('div', {}, el('div', {}, p.nome), el('div', { class: 'pequeno mudo' }, `${p.bairro ? `${p.bairro}, ` : ''}${p.cidade}/${p.uf}`)), 'Ponto'],
          [(p) => CATEGORIAS[p.categoria] ?? p.categoria, 'Ambiente'],
          [(p) => (p.unidades ? inteiro(p.unidades) : '—'), 'Unidades', 'num dir'],
          [(p) => inteiro(p.telas), 'Telas', 'num dir'],
          [(p) => (p.posicoes.length ? p.posicoes.join(' · ') : '—'), 'Onde ficam'],
          [(p) => inteiro(p.publico_dia), 'Passagens/dia', 'num dir'],
          [(p) => dinheiro(p.tabela_centavos), 'Tabela/mês', 'num dir'],
        ], d.itens, { vazioTexto: 'Nenhum ponto ativo.' })));
  };

  limpar(ctx.conteudo, corpo);
  await pintar();
}

async function abrirCircuito(id, recarregar) {
  const c = await api.get(`/painel/circuitos/${id}`);
  await modal(c.nome, (fechar) => [
    c.descricao ? el('p', { class: 'mudo', style: 'margin:0' }, c.descricao) : null,
    el('div', { class: 'grade', style: 'margin:16px 0' },
      indicador({ rotulo: 'Telas', valor: inteiro(c.telas), ic: 'telas', nota: `${c.paisagem} deitadas · ${c.retrato} em pé` }),
      indicador({ rotulo: 'Pontos', valor: inteiro(c.pontos), ic: 'pontos', cor: 'roxo', nota: `${c.cidades} cidade(s)` }),
      indicador({ rotulo: 'Público por mês', valor: inteiro(c.publico_mes), ic: 'pessoas', cor: 'ciano' }),
      indicador({ rotulo: 'Tabela', valor: c.valor_mes_centavos ? dinheiro(c.valor_mes_centavos) : '—', ic: 'dinheiro', cor: 'verde', nota: c.cpm_centavos ? `CPM ${dinheiro(c.cpm_centavos)}` : null })),
    el('h3', {}, 'Telas do circuito'),
    tabela([
      [(t) => el('div', {}, el('div', {}, t.local_nome), el('div', { class: 'pequeno mudo' }, `${t.nome}${t.posicao ? ` · ${t.posicao}` : ''}`)), 'Tela'],
      [(t) => CATEGORIAS[t.categoria] ?? t.categoria, 'Ambiente'],
      [(t) => `${t.cidade}/${t.uf}`, 'Cidade'],
      [(t) => ORIENTACOES[t.orientacao], 'Formato'],
      [(t) => inteiro(t.publico_dia), 'Passagens/dia', 'num dir'],
    ], c.lista, { vazioTexto: 'Nenhuma tela bate com as regras deste circuito.' }),
    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('div', { class: 'linha' },
        el('button', {
          class: 'btn primario', onclick: (e) => acao(e.target, async () => { fechar(); await gerarProposta(c.id, c.nome); }),
        }, icone('relatorios'), 'Gerar proposta'),
        el('button', { class: 'btn', onclick: () => { fechar(); editarCircuito(c, recarregar); } }, icone('editar'), 'Editar circuito')),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

/** Criação/edição do circuito, com as mesmas regras de alvo das campanhas. */
async function editarCircuito(c, recarregar) {
  const opcoes = await api.get('/painel/opcoes');
  const selecao = new Set((c?.alvos ?? []).map((a) => `${a.tipo}:${a.valor}`));
  return modal(c ? `Editar ${c.nome}` : 'Novo circuito', (fechar) => {
    const grupo = (titulo, tipo, lista) => el('fieldset', {}, el('legend', {}, titulo),
      el('div', { class: 'escolhas' }, lista.map(([valor, rotulo]) => el('label', {},
        el('input', {
          type: 'checkbox', checked: selecao.has(`${tipo}:${valor}`),
          onchange: (e) => (e.target.checked ? selecao.add(`${tipo}:${valor}`) : selecao.delete(`${tipo}:${valor}`)),
        }), rotulo))));
    const ok = el('button', { class: 'btn primario largo' }, 'Salvar');
    const f = el('form', { class: 'form' },
      campo('Nome do circuito', { name: 'nome', value: c?.nome ?? '', required: true, maxlength: 120, placeholder: 'Ex.: Residencial Campinas' }),
      area('Descrição (aparece na proposta)', { name: 'descricao', maxlength: 300 }, c?.descricao ?? ''),
      el('div', { class: 'tres' },
        campo('Tabela por mês (R$)', { name: 'valor', value: reaisCampo(c?.valor_mes_centavos), inputmode: 'decimal' }),
        campo('CPM (R$)', { name: 'cpm', value: reaisCampo(c?.cpm_centavos), inputmode: 'decimal' }),
        campo('Inserções por hora', { name: 'insercoes_hora', type: 'number', min: 1, max: 120, value: c?.insercoes_hora ?? 6 })),
      c ? marcar('Circuito ativo (aparece na venda)', { name: 'ativo', checked: Boolean(c.ativo) }) : null,
      el('p', { class: 'mudo', style: 'margin:0' }, 'Quais telas entram: marque ambientes, cidades, pontos ou telas. Vale qualquer combinação.'),
      grupo('Por ambiente', 'categoria', Object.entries(CATEGORIAS)),
      grupo('Por cidade', 'cidade', opcoes.cidades.map((x) => [x, x])),
      grupo('Pontos específicos', 'local', opcoes.locais.map((l) => [String(l.id), `${l.nome} — ${l.cidade}`])),
      grupo('Telas específicas', 'tela', opcoes.telas.map((t) => [String(t.id), `${t.local_nome} — ${t.nome}`])),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const corpo = {
          nome: d.nome,
          descricao: d.descricao,
          valor_mes_centavos: centavos(d.valor) ?? 0,
          cpm_centavos: centavos(d.cpm) ?? 0,
          insercoes_hora: Number(d.insercoes_hora),
          ...(c ? { ativo: d.ativo } : {}),
          alvos: [...selecao].map((x) => { const [tipo, ...resto] = x.split(':'); return { tipo, valor: resto.join(':') }; }),
        };
        if (c) await api.patch(`/painel/circuitos/${c.id}`, corpo);
        else await api.post('/painel/circuitos', corpo);
        toast(c ? 'Circuito atualizado.' : 'Circuito criado.');
        fechar();
        recarregar();
      });
    });
    return f;
  }, { largo: true });
}

/** Agências: quem compra a mídia para os anunciantes, com a comissão sobre a veiculação. */
export async function agencias(corpo) {
  const pintar = async () => {
    const d = await api.get('/painel/agencias');
    limpar(corpo,
      el('div', { class: 'linha entre', style: 'margin-bottom:14px' },
        el('p', { class: 'mudo', style: 'margin:0' }, 'A comissão da agência sai do bruto da campanha: a fatura mostra bruto, comissão e líquido.'),
        el('button', { class: 'btn primario', onclick: () => editarAgencia(null, pintar) }, icone('mais'), 'Nova agência')),
      tabela([
        [(a) => el('div', {}, el('div', {}, a.nome), el('div', { class: 'pequeno mudo' }, a.contato ?? a.email ?? '—')), 'Agência'],
        [(a) => a.documento ?? '—', 'CNPJ'],
        [(a) => `${(a.comissao_percentual / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`, 'Comissão', 'num dir'],
        [(a) => inteiro(a.campanhas_ativas), 'Campanhas no ar', 'num dir'],
        [(a) => (a.status === 'ativa' ? etiqueta('Ativa', 'ok') : etiqueta('Inativa', '')), 'Situação'],
        [(a) => el('div', { class: 'acoes' }, el('button', { class: 'icone-btn', title: 'Editar', onclick: () => editarAgencia(a, pintar) }, icone('editar'))), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nenhuma agência. Campanhas vendidas direto ao anunciante não precisam de agência.' }));
  };
  await pintar();
}

const editarAgencia = (a, recarregar) => formModal(a ? `Editar ${a.nome}` : 'Nova agência', () => [
  campo('Nome', { name: 'nome', value: a?.nome ?? '', required: true, maxlength: 120 }),
  el('div', { class: 'duas' },
    campo('CNPJ', { name: 'documento', value: a?.documento ?? '', maxlength: 20 }),
    campo('Comissão padrão (%)', { name: 'comissao', value: a ? (a.comissao_percentual / 100) : 20, type: 'number', min: 0, max: 100, step: 0.5 })),
  el('div', { class: 'duas' },
    campo('Pessoa de contato', { name: 'contato', value: a?.contato ?? '', maxlength: 120 }),
    campo('E-mail', { name: 'email', type: 'email', value: a?.email ?? '', maxlength: 160 })),
  el('div', { class: 'duas' },
    campo('Telefone', { name: 'telefone', value: a?.telefone ?? '', maxlength: 20 }),
    a ? escolha('Situação', 'status', { ativa: 'Ativa', inativa: 'Inativa' }, a.status) : null),
], async (d) => {
  const corpo = { ...d, comissao_percentual: d.comissao };
  delete corpo.comissao;
  if (a) await api.patch(`/painel/agencias/${a.id}`, corpo);
  else await api.post('/painel/agencias', corpo);
  toast(a ? 'Agência atualizada.' : 'Agência cadastrada.');
  recarregar();
});
