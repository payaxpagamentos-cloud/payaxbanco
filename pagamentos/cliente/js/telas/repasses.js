import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, kpi, campo, lerForm, modal, confirmar, toast, acao, aviso, selo,
  dinheiro, numero, dataHora, data, R, icone
} from '../../comum/ui.js';

/** Transferência do saldo para a conta do cliente. */
export default async function repasses({ alvo, query, recarregar }) {
  const d = await api.get(`/repasses${qs({ pagina: Number(query.pagina) || 1 })}`);
  const disp = d.disponivel;

  const caixa = el('div', { class: 'saldo' },
    el('div', {},
      el('div', { class: 'titulo' }, 'Disponível para transferir'),
      el('div', { class: 'valor' }, dinheiro(disp.sacavel_centavos))),
    el('div', { class: 'linhas' },
      el('div', { class: 'linha' }, el('span', {}, 'A liberar'), el('strong', {}, dinheiro(disp.a_liberar_centavos))),
      el('div', { class: 'linha' }, el('span', {}, 'Em trânsito'), el('strong', {}, dinheiro(disp.em_transito_centavos))),
      disp.taxa_repasse_centavos
        ? el('div', { class: 'linha' }, el('span', {}, 'Tarifa por transferência'), el('strong', {}, dinheiro(disp.taxa_repasse_centavos)))
        : null),
    el('div', { class: 'acoes' },
      pode('repasses.solicitar')
        ? el('button', { class: 'botao', disabled: disp.sacavel_centavos <= disp.taxa_repasse_centavos, onclick: () => solicitar(disp, recarregar) }, icone('pix'), 'Transferir agora')
        : null));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Repasses'),
      el('p', {}, 'O saldo liberado vai por PIX para a conta cadastrada da sua empresa.'))),
    caixa,
    !pode('repasses.solicitar') ? el('div', { style: 'margin-top:14px' }, aviso('O seu perfil consulta os repasses, mas não pode solicitá-los.', 'info')) : null,
    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Solicitado', conteudo: (r) => dataHora(r.criado_em) },
        { titulo: 'Valor transferido', dir: true, conteudo: (r) => el('span', {}, el('strong', {}, dinheiro(r.valor_liquido_centavos)),
          r.taxa_centavos ? el('span', { class: 'sub' }, `tarifa ${dinheiro(r.taxa_centavos)}`) : null) },
        { titulo: 'Chave PIX', conteudo: (r) => el('span', {}, r.pix_chave, el('span', { class: 'sub' }, r.titular_nome ?? '')) },
        { titulo: 'Situação', conteudo: (r) => el('span', {}, selo(r.situacao, R.situacaoRepasse),
          r.end_to_end ? el('span', { class: 'sub num' }, r.end_to_end) : r.erro ? el('span', { class: 'sub' }, r.erro) : null) },
        { titulo: 'Confirmado', conteudo: (r) => (r.confirmado_em ? dataHora(r.confirmado_em) : '—') },
      ],
      itens: d.itens,
      vazio: 'Nenhuma transferência ainda.',
      rodape: paginacao(d, (p) => ir(`#/repasses${qs({ pagina: p })}`)),
    })),
  );
}

function solicitar(disp, recarregar) {
  const maximo = disp.sacavel_centavos;
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'valor', rotulo: 'Valor a transferir (R$)', tipo: 'dinheiro', valor: (maximo / 100).toFixed(2).replace('.', ','),
        ajuda: `Disponível: ${dinheiro(maximo)}` })));
  const resumo = el('p', { style: 'color:var(--texto-2);font-size:13px' });
  const atualizar = () => {
    const txt = String(lerForm(form).valor ?? '').replace(/\./g, '').replace(',', '.');
    const c = Math.round(Number(txt) * 100);
    resumo.textContent = Number.isFinite(c) && c > 0
      ? `Sai do seu saldo ${dinheiro(c)}${disp.taxa_repasse_centavos ? `, com tarifa de ${dinheiro(disp.taxa_repasse_centavos)} — você recebe ${dinheiro(c - disp.taxa_repasse_centavos)}.` : ' — é o que você recebe.'}`
      : '';
  };
  form.addEventListener('input', atualizar);
  atualizar();

  const botao = el('button', { class: 'botao' }, icone('pix'), 'Confirmar transferência');
  botao.addEventListener('click', () => acao(botao, async () => {
    const r = await api.post('/repasses', lerForm(form));
    m.fechar();
    toast(r.situacao === 'aguardando_aprovacao'
      ? 'Pedido registrado. Acima do seu limite, a PAY AX confere antes de enviar.'
      : 'Transferência solicitada.', 'ok');
    recarregar();
  }));
  const m = modal({
    titulo: 'Transferir para a minha conta',
    corpo: [aviso('O PIX vai para a chave cadastrada da sua empresa. Para trocar a chave, fale com o seu gerente de conta — por segurança, só a PAY AX altera o destino.', 'info'), form, resumo],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao],
  });
}
