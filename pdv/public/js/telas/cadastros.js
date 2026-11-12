import { api } from '../api.js';
import { el, limpar, campo, escolha, marcar, formModal, toast, icone, etiqueta, pessoa, dataHora, PERFIS } from '../ui.js';

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
      el('p', { class: 'mudo' }, 'Cada PDV é um ponto de atendimento no balcão: só um caixa fica aberto por PDV de cada vez.'),
      el('table', { class: 'tabela' }, el('tbody', {}, p.itens.map((x) => el('tr', {},
        el('td', {}, el('strong', {}, x.nome), el('div', { class: 'pequeno mudo' }, x.loja_nome)),
        el('td', {}, x.caixa_aberto_id ? etiqueta('Caixa aberto', 'info') : el('span', { class: 'pequeno mudo' }, 'livre')),
        el('td', { class: 'dir' }, x.ativo ? null : etiqueta('Inativo', ''),
          ctx.administra ? el('button', { class: 'btn pequeno', onclick: () => editarPdv(x, l.itens) }, icone('editar'), 'Editar') : null))))));

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
