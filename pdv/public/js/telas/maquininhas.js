import { api } from '../api.js';
import {
  el, limpar, dinheiro, campo, escolha, marcar, formModal, modal, confirmar, toast, acao, icone,
  ADQUIRENTES, MODOS_TERMINAL, STATUS_CARTAO, FORMAS_CURTAS, etiquetaDe, etiqueta, dataHora,
} from '../ui.js';

/** Maquininhas de cartão: cadastro, chave de integração e as últimas cobranças. */
export async function telaMaquininhas(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const lista = el('div', { class: 'cartao' });
  const cobrancas = el('div', { class: 'cartao' });
  const ajuda = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, lista, cobrancas, ajuda));

  async function carregar() {
    const [{ itens }, lojas, pdvs] = await Promise.all([
      api.get(`${base}/cadastros/terminais`),
      api.get(`${base}/cadastros/lojas`).then((x) => x.itens),
      api.get(`${base}/cadastros/pdvs`).then((x) => x.itens),
    ]);

    limpar(lista, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Maquininhas'),
      ctx.administra ? el('button', { class: 'btn primario', onclick: () => editar(null, lojas, pdvs) }, 'Nova maquininha') : null),
      itens.length ? el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Maquininha', 'Adquirente', 'Integração', 'Loja / PDV', 'Último contato', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, itens.map((t) => el('tr', {},
          el('td', {}, el('strong', {}, t.nome), t.serial ? el('div', { class: 'pequeno mudo' }, `série ${t.serial}`) : null),
          el('td', {}, ADQUIRENTES[t.adquirente] ?? t.adquirente, t.modelo ? el('div', { class: 'pequeno mudo' }, t.modelo) : null),
          el('td', {}, MODOS_TERMINAL[t.modo], t.modo !== 'manual' ? el('div', { class: 'pequeno mudo' }, t.chave_definida ? 'chave gerada' : 'sem chave') : null),
          el('td', { class: 'pequeno' }, [t.loja_nome, t.pdv_nome].filter(Boolean).join(' · ')),
          el('td', { class: 'pequeno mudo' }, t.ultimo_contato ? dataHora(t.ultimo_contato) : 'nunca'),
          el('td', { class: 'dir' }, el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
            t.ativo ? null : etiqueta('Desativada', ''),
            ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => editar(t, lojas, pdvs) }, icone('editar'), 'Editar') : null,
            ctx.administra && t.modo !== 'manual' ? el('button', { class: 'btn pequeno', onclick: () => novaChave(t) }, 'Nova chave') : null)))))) 
        : el('p', { class: 'mudo' }, 'Nenhuma maquininha cadastrada. Sem maquininha, o cartão só entra por lançamento manual.'));

    const { itens: transacoes } = await api.get(`${base}/cartao/cobrancas`);
    limpar(cobrancas, el('h2', {}, 'Últimas cobranças no cartão'),
      transacoes.length ? el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Quando', 'Maquininha', 'Forma', 'Valor', 'Situação', 'Comprovante'].map((t) => el('th', {}, t)))),
        el('tbody', {}, transacoes.map((x) => el('tr', {},
          el('td', {}, dataHora(x.criado_em)),
          el('td', {}, x.terminal_nome),
          el('td', {}, FORMAS_CURTAS[x.forma] + (x.parcelas > 1 ? ` ${x.parcelas}x` : '')),
          el('td', { class: 'num dir' }, dinheiro(x.valor_centavos)),
          el('td', {}, etiquetaDe(STATUS_CARTAO, x.status), x.mensagem ? el('div', { class: 'pequeno mudo' }, x.mensagem) : null),
          el('td', { class: 'pequeno mudo' }, [x.bandeira, x.nsu ? `NSU ${x.nsu}` : null, x.recebimento_id ? `recebimento ${x.recebimento_id}` : null].filter(Boolean).join(' · '))))))
        : el('p', { class: 'mudo' }, 'Nenhuma cobrança no cartão ainda.'));

    limpar(ajuda, el('h2', {}, 'Como a maquininha conversa com o PDV'),
      el('p', { class: 'mudo' }, 'Três jeitos, escolhidos em cada maquininha:'),
      el('table', { class: 'tabela' }, el('tbody', {},
        el('tr', {}, el('td', {}, el('strong', {}, 'Aplicativo na maquininha')),
          el('td', {}, 'O aplicativo instalado na maquininha (Stone, PagBank, Mercado Pago, Cielo etc.) busca a cobrança no PDV e devolve o resultado. Use a chave da maquininha no cabeçalho ', el('code', {}, 'X-Api-Key'), '.')),
        el('tr', {}, el('td', {}, el('strong', {}, 'Adquirente (webhook)')),
          el('td', {}, 'O PDV envia a cobrança para o endereço do adquirente/intermediador e recebe o retorno em ', el('code', {}, 'POST /api/integracao/terminal/resultado'), '.')),
        el('tr', {}, el('td', {}, el('strong', {}, 'Digitado pelo operador')),
          el('td', {}, 'Maquininha sem integração: o operador passa o cartão no aparelho e digita NSU e autorização no PDV.')))),
      el('pre', { class: 'codigo' }, `GET  /api/integracao/terminal/cobranca      → próxima cobrança (204 = nada)
POST /api/integracao/terminal/resultado     → { "referencia": "...", "status": "aprovada", "nsu": "123456" }
Cabeçalho: X-Api-Key: pdv_<prefixo>_<segredo>`));
  }

  function editar(t, lojas, pdvs) {
    const opcoesPdv = { '': 'Qualquer PDV', ...Object.fromEntries(pdvs.map((p) => [p.id, `${p.nome} · ${p.loja_nome}`])) };
    formModal(t ? `Maquininha ${t.nome}` : 'Nova maquininha', (form) => {
      const modo = escolha('Integração', 'modo', MODOS_TERMINAL, t?.modo ?? 'agente');
      const endereco = campo('Endereço do adquirente (webhook)', { name: 'endereco', value: t?.endereco ?? '', placeholder: 'https://api.adquirente.com.br/cobrancas' });
      const token = campo(t?.token_definido ? 'Token do adquirente (deixe vazio para manter)' : 'Token do adquirente', { name: 'token', type: 'password', autocomplete: 'new-password' });
      const mostrar = () => {
        const web = form.querySelector('[name=modo]').value === 'webhook';
        endereco.style.display = web ? '' : 'none';
        token.style.display = web ? '' : 'none';
      };
      setTimeout(mostrar, 0);
      form.addEventListener('change', mostrar);
      return [
        campo('Nome', { name: 'nome', required: true, maxlength: 80, value: t?.nome ?? '' }),
        el('div', { class: 'duas' },
          escolha('Adquirente', 'adquirente', ADQUIRENTES, t?.adquirente ?? 'outro'),
          escolha('Loja', 'loja_id', Object.fromEntries(lojas.map((l) => [l.id, l.nome])), t?.loja_id ?? lojas[0]?.id)),
        el('div', { class: 'duas' },
          campo('Modelo', { name: 'modelo', maxlength: 60, value: t?.modelo ?? '' }),
          campo('Número de série', { name: 'serial', maxlength: 60, value: t?.serial ?? '' })),
        el('div', { class: 'duas' }, modo, escolha('PDV', 'pdv_id', opcoesPdv, t?.pdv_id ?? '')),
        endereco, token,
        t ? marcar('Maquininha ativa', { name: 'ativo', checked: !!t.ativo }) : null,
      ];
    }, async (d) => {
      const corpo = { ...d, pdv_id: d.pdv_id || null, token: d.token || undefined };
      if (d.modo !== 'webhook') { corpo.endereco = null; delete corpo.token; }
      const r = t ? await api.patch(`${base}/cadastros/terminais/${t.id}`, corpo) : await api.post(`${base}/cadastros/terminais`, corpo);
      toast(t ? 'Maquininha salva.' : 'Maquininha cadastrada.');
      if (!t && r.chave) await mostrarChave(r.chave);
      await carregar();
    });
  }

  async function novaChave(t) {
    if (!await confirmar('Nova chave', `A chave atual de "${t.nome}" deixa de funcionar e a maquininha precisa ser configurada de novo. Continuar?`, 'Gerar nova chave')) return;
    const { chave } = await api.post(`${base}/cadastros/terminais/${t.id}/chave`, {});
    await mostrarChave(chave);
    await carregar();
  }

  const mostrarChave = (chave) => modal('Chave da maquininha', (fechar) => [
    el('p', { class: 'mudo' }, 'Guarde agora: por segurança, esta chave não aparece de novo. Configure-a no aplicativo da maquininha, no cabeçalho X-Api-Key.'),
    el('div', { class: 'chave' }, el('code', { class: 'mono' }, chave)),
    el('div', { class: 'linha entre', style: 'margin-top:12px' },
      el('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(chave); toast('Chave copiada.'); } }, 'Copiar'),
      el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Já guardei')),
  ]);

  await carregar();
}
