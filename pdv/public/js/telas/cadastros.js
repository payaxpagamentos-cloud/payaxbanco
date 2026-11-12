import { api, BASE } from '../api.js';
import { el, limpar, campo, escolha, marcar, formModal, modal, confirmar, toast, acao, icone, etiqueta, pessoa, dataHora, PERFIS } from '../ui.js';

const PERFIS_EMPRESA = { operador: PERFIS.operador, supervisor: PERFIS.supervisor, admin: PERFIS.admin };

/** Lojas, estações de caixa (PDVs) e quem usa o sistema na empresa. */
export async function telaCadastros(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const lojas = el('div', { class: 'cartao' });
  const pdvs = el('div', { class: 'cartao' });
  const usuarios = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, lojas, pdvs, usuarios));

  async function carregar() {
    const [l, p, u] = await Promise.all([
      api.get(`${base}/cadastros/lojas`),
      api.get(`${base}/cadastros/pdvs`),
      api.get(`${base}/cadastros/usuarios`),
    ]);

    limpar(lojas, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Lojas / pontos de atendimento'),
      ctx.administra ? el('button', { class: 'btn primario', onclick: () => editarLoja(null) }, 'Nova loja') : null),
      el('table', { class: 'tabela' }, el('tbody', {}, l.itens.map((x) => el('tr', {},
        el('td', {}, el('strong', {}, x.nome), x.endereco ? el('div', { class: 'pequeno mudo' }, x.endereco) : null),
        el('td', { class: 'pequeno mudo' }, x.ixc_filial_id ? `filial ${x.ixc_filial_id} no IXC` : ''),
        el('td', { class: 'dir' }, x.ativa ? null : etiqueta('Inativa', ''),
          ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => editarLoja(x) }, icone('editar'), 'Editar') : null))))));

    limpar(pdvs, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Estações de caixa (PDVs)'),
      ctx.administra ? el('button', { class: 'btn primario', onclick: () => editarPdv(null, l.itens) }, 'Novo PDV') : null),
      el('p', { class: 'mudo' }, 'Cada PDV é um ponto de atendimento no balcão: só um caixa fica aberto por PDV de cada vez. A tela do cliente é a que fica virada para quem paga: o cliente digita o CPF e passa o cartão na maquininha do PDV.'),
      el('table', { class: 'tabela' }, el('tbody', {}, p.itens.map((x) => el('tr', {},
        el('td', {}, el('strong', {}, x.nome), el('div', { class: 'pequeno mudo' }, x.loja_nome)),
        el('td', {}, x.caixa_aberto_id ? etiqueta('Caixa aberto', 'info') : el('span', { class: 'pequeno mudo' }, 'livre')),
        el('td', {}, x.autoatendimento ? etiqueta('Tela do cliente ligada', 'ok') : el('span', { class: 'pequeno mudo' }, 'sem tela do cliente'),
          el('div', { class: 'pequeno mudo' }, x.maquininha_nome ? `maquininha: ${x.maquininha_nome}` : 'sem maquininha ligada')),
        el('td', { class: 'dir' }, x.ativo ? null : etiqueta('Inativo', ''),
          el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
            ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => telaDoCliente(x) }, icone('pdv'), x.autoatendimento ? 'Tela do cliente' : 'Ligar tela do cliente') : null,
            ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => editarPdv(x, l.itens) }, icone('editar'), 'Editar') : null)))))));

    limpar(usuarios, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Quem usa o PDV'),
      ctx.administra ? el('button', { class: 'btn primario', onclick: () => editarUsuario(null, l.itens) }, 'Novo usuário') : null),
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Pessoa', 'Perfil', 'Loja', 'Último acesso', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, u.itens.map((x) => el('tr', {},
          el('td', {}, pessoa(x.nome, x.email)),
          el('td', {}, PERFIS[x.perfil] ?? x.perfil),
          el('td', { class: 'pequeno mudo' }, x.loja_nome ?? 'todas'),
          el('td', { class: 'pequeno mudo' }, x.ultimo_acesso ? dataHora(x.ultimo_acesso) : 'nunca'),
          el('td', { class: 'dir' }, x.ativo ? null : etiqueta('Inativo', ''),
            ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => editarUsuario(x, l.itens) }, icone('editar'), 'Editar') : null))))),
      el('p', { class: 'pequeno mudo' }, 'Operador recebe no balcão e cuida do próprio caixa. Supervisor confere, cancela recebimento e fecha caixa de qualquer operador. Administrador também configura o IXC e as maquininhas.'));
  }

  function editarLoja(loja) {
    formModal(loja ? `Loja ${loja.nome}` : 'Nova loja', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: loja?.nome ?? '' }),
      campo('Endereço', { name: 'endereco', maxlength: 200, value: loja?.endereco ?? '' }),
      campo('Filial no IXC (opcional)', { name: 'ixc_filial_id', maxlength: 20, value: loja?.ixc_filial_id ?? '' }),
      loja ? marcar('Loja ativa', { name: 'ativa', checked: !!loja.ativa }) : null,
    ], async (d) => {
      if (loja) await api.patch(`${base}/cadastros/lojas/${loja.id}`, d);
      else await api.post(`${base}/cadastros/lojas`, d);
      toast('Loja salva.');
      await carregar();
    });
  }

  function editarPdv(pdv, listaLojas) {
    formModal(pdv ? `PDV ${pdv.nome}` : 'Novo PDV', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 80, value: pdv?.nome ?? '', placeholder: 'ex.: Caixa 2' }),
      pdv ? null : escolha('Loja', 'loja_id', Object.fromEntries(listaLojas.map((l) => [l.id, l.nome])), listaLojas[0]?.id),
      pdv ? marcar('PDV ativo', { name: 'ativo', checked: !!pdv.ativo }) : null,
    ], async (d) => {
      if (pdv) await api.patch(`${base}/cadastros/pdvs/${pdv.id}`, { nome: d.nome, ativo: d.ativo });
      else await api.post(`${base}/cadastros/pdvs`, d);
      toast('PDV salvo.');
      await carregar();
    });
  }

  /** Liga (ou desliga) a tela do cliente do PDV e mostra a chave e o endereço para abrir no aparelho. */
  function telaDoCliente(pdv) {
    const endereco = `${location.origin}${BASE}/cliente/`;
    modal(`Tela do cliente · ${pdv.nome}`, (fechar) => {
      const partes = [
        el('p', { class: 'mudo' }, 'A tela do cliente fica virada para quem vai pagar: ele digita o CPF/CNPJ, escolhe as faturas e passa o cartão na maquininha deste PDV. Não recebe dinheiro e não entra no caixa do balcão.'),
        el('div', { class: 'chave' }, el('span', {}, 'Endereço da tela'), el('code', { class: 'mono' }, endereco)),
        pdv.maquininha_nome ? null : el('p', { class: 'aviso' }, 'Nenhuma maquininha ativa ligada a este PDV ou à loja: a tela vai consultar as faturas, mas não vai conseguir cobrar.'),
      ];
      const ligar = el('button', { class: 'btn primario' }, pdv.autoatendimento ? 'Gerar nova chave' : 'Ligar e gerar a chave');
      ligar.addEventListener('click', () => acao(ligar, async () => {
        if (pdv.autoatendimento && !await confirmar('Nova chave', 'A chave atual para de funcionar e a tela precisa ser ativada de novo. Continuar?', 'Gerar nova chave')) return;
        const r = await api.post(`${base}/cadastros/pdvs/${pdv.id}/autoatendimento`, {});
        fechar(null);
        await mostrarChave(r.chave, endereco);
        await carregar();
      }));
      const acoes = el('div', { class: 'linha entre', style: 'margin-top:12px;gap:8px' },
        el('button', { class: 'btn', onclick: () => fechar(null) }, 'Fechar'),
        el('div', { class: 'linha', style: 'gap:8px' },
          pdv.autoatendimento ? el('button', { class: 'btn perigo', onclick: () => acao(null, async () => {
            if (!await confirmar('Desligar a tela do cliente', `A tela do ${pdv.nome} para de funcionar na hora. Continuar?`, 'Desligar')) return;
            await api.del(`${base}/cadastros/pdvs/${pdv.id}/autoatendimento`);
            toast('Tela do cliente desligada.');
            fechar(null);
            await carregar();
          }) }, 'Desligar') : null,
          ligar));
      return [...partes.filter(Boolean), acoes];
    });
  }

  const mostrarChave = (chave, endereco) => modal('Chave da tela do cliente', (fechar) => [
    el('p', { class: 'mudo' }, 'Guarde agora: por segurança, esta chave não aparece de novo. No aparelho da tela do cliente, abra o endereço abaixo e cole a chave uma única vez.'),
    el('div', { class: 'chave' }, el('span', {}, 'Endereço'), el('code', { class: 'mono' }, endereco)),
    el('div', { class: 'chave' }, el('span', {}, 'Chave'), el('code', { class: 'mono' }, chave)),
    el('p', { class: 'pequeno mudo' }, 'Atalho: abrir o endereço com #' + 'a chave no fim já ativa a tela, sem digitar nada.'),
    el('div', { class: 'linha entre', style: 'margin-top:12px' },
      el('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(`${endereco}#${chave}`); toast('Endereço com a chave copiado.'); } }, 'Copiar endereço + chave'),
      el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Já guardei')),
  ]);

  function editarUsuario(usuario, listaLojas) {
    formModal(usuario ? usuario.nome : 'Novo usuário', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: usuario?.nome ?? '' }),
      usuario ? null : campo('E-mail', { name: 'email', type: 'email', required: true }),
      el('div', { class: 'duas' },
        escolha('Perfil', 'perfil', PERFIS_EMPRESA, usuario?.perfil ?? 'operador'),
        escolha('Loja', 'loja_id', { '': 'Todas as lojas', ...Object.fromEntries(listaLojas.map((l) => [l.id, l.nome])) }, usuario?.loja_id ?? '')),
      campo(usuario ? 'Nova senha (deixe vazio para manter)' : 'Senha (mínimo 8 caracteres)',
        { name: 'senha', type: 'password', required: !usuario, minlength: 8, autocomplete: 'new-password' }),
      usuario ? marcar('Usuário ativo', { name: 'ativo', checked: !!usuario.ativo }) : null,
    ], async (d) => {
      const corpo = { ...d, loja_id: d.loja_id || null };
      if (usuario && !d.senha) delete corpo.senha;
      if (usuario) await api.patch(`${base}/cadastros/usuarios/${usuario.id}`, corpo);
      else await api.post(`${base}/cadastros/usuarios`, corpo);
      toast('Usuário salvo.');
      await carregar();
    });
  }

  await carregar();
}
