import { api, ir, pode, usuario } from '../app.js';
import {
  el, montar, cartao, tabela, campo, lerForm, modal, confirmar, toast, acao, aviso, selo, copiar, autoPreencher,
  dinheiro, numero, dataHora, data, documento, telefone, hojeIso, somarDias, R, icone
} from '../../comum/ui.js';

/** Dados da empresa, acessos e a integração com o IXC. */
export default async function cadastro({ alvo, query, recarregar, ir: navegar }) {
  const aba = query.aba ?? 'dados';
  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Cadastro e acessos'),
      el('p', {}, 'Os dados da sua empresa, quem acessa este painel e a ligação com o seu IXC.'))),
    el('div', { class: 'abas' },
      el('button', { class: aba === 'dados' ? 'ativa' : '', onclick: () => navegar('#/cadastro?aba=dados') }, 'Dados da empresa'),
      pode('usuarios.gerenciar') ? el('button', { class: aba === 'usuarios' ? 'ativa' : '', onclick: () => navegar('#/cadastro?aba=usuarios') }, 'Acessos') : null,
      el('button', { class: aba === 'ixc' ? 'ativa' : '', onclick: () => navegar('#/cadastro?aba=ixc') }, 'IXC')),
    el('div', { id: 'corpo' }));
  const corpo = alvo.querySelector('#corpo');
  if (aba === 'usuarios' && pode('usuarios.gerenciar')) await abaUsuarios(corpo, recarregar);
  else if (aba === 'ixc') await abaIxc(corpo, recarregar);
  else await abaDados(corpo, recarregar);
}

async function abaDados(alvo, recarregar) {
  const c = await api.get('/cadastro');
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
  const editavel = pode('cadastro.editar');

  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'nome_fantasia', rotulo: 'Nome fantasia', valor: c.nome_fantasia ?? '' }),
      campo({ nome: 'responsavel', rotulo: 'Responsável', valor: c.responsavel ?? '' }),
      campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', valor: c.email ?? '' }),
      campo({ nome: 'telefone', rotulo: 'Telefone', valor: c.telefone ?? '' })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'cep', rotulo: 'CEP', valor: c.cep ?? '' }),
      campo({ nome: 'endereco', rotulo: 'Endereço', valor: c.endereco ?? '' }),
      campo({ nome: 'numero', rotulo: 'Número', valor: c.numero ?? '' }),
      campo({ nome: 'bairro', rotulo: 'Bairro', valor: c.bairro ?? '' }),
      campo({ nome: 'cidade', rotulo: 'Cidade', valor: c.cidade ?? '' }),
      campo({ nome: 'uf', rotulo: 'UF', valor: c.uf ?? '', atributos: { maxlength: 2 } })));
  autoPreencher(form, api, { tipo: 'cep', campo: 'cep', mapa: {
    endereco: 'endereco', bairro: 'bairro', cidade: 'cidade', uf: 'uf',
  } });
  const botao = el('button', { class: 'botao' }, 'Salvar alterações');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.patch('/cadastro', lerForm(form));
    toast('Cadastro atualizado.', 'ok');
    recarregar();
  }));

  montar(alvo, 
    cartao('Identificação', el('div', { class: 'pares' },
      par('Sua conta PayAx', el('strong', {}, c.conta_payax ?? '—')),
      par('Razão social', c.razao_social),
      par('CNPJ', documento(c.cnpj)),
      par('Situação', selo(c.situacao, R.situacaoCliente)),
      par('Limite por boleto', dinheiro(c.limite_boleto_centavos)))),

    el('div', { style: 'margin-top:14px' }, cartao('Conta para receber os repasses',
      el('div', {},
        el('div', { class: 'pares' },
          par('Chave PIX', c.pix ? `${c.pix.chave} (${c.pix.tipo})` : el('span', { style: 'color:var(--vermelho)' }, 'não cadastrada')),
          par('Titular', c.pix?.titular ?? c.razao_social),
          par('Repasse automático', c.repasse_automatico ? 'Sim, a cada dia útil' : 'Não (sob demanda)'),
          par('Retenção', `D+${c.retencao_dias} dia(s) útil(eis) após o pagamento`)),
        el('div', { style: 'margin-top:12px' },
          aviso('Por segurança, a chave PIX de destino só é alterada pela equipe PayAx. Fale com o seu gerente de conta.', 'info'))))),

    editavel
      ? el('div', { style: 'margin-top:14px' }, cartao('Contato e endereço', form, botao))
      : el('div', { style: 'margin-top:14px' }, cartao('Contato e endereço', el('div', { class: 'pares' },
        par('Responsável', c.responsavel ?? '—'), par('E-mail', c.email ?? '—'), par('Telefone', telefone(c.telefone)),
        par('Endereço', [c.endereco, c.numero].filter(Boolean).join(', ') || '—'),
        par('Cidade', [c.cidade, c.uf].filter(Boolean).join('/') || '—')))),
  );
}

async function abaUsuarios(alvo, recarregar) {
  const itens = await api.get('/usuarios');
  const eu = usuario();
  montar(alvo, cartao('Quem acessa o Internet Bank', tabela({
    colunas: [
      { titulo: 'Nome', conteudo: (u) => el('span', {}, el('span', { class: 'forte' }, u.nome, u.id === eu.id ? ' (você)' : ''), el('span', { class: 'sub' }, u.email)) },
      { titulo: 'Perfil', conteudo: (u) => R.perfilCliente[u.perfil] ?? u.perfil },
      { titulo: 'Último acesso', conteudo: (u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca entrou') },
      { titulo: 'Situação', conteudo: (u) => selo(u.ativo ? 'ativo' : 'suspenso', { ativo: ['Ativo', 'ok'], suspenso: ['Inativo', 'neutra'] }) },
      { titulo: '', dir: true, conteudo: (u) => el('button', { class: 'botao sutil pequeno', onclick: () => editar(u, recarregar) }, 'Editar') },
    ],
    itens,
    vazio: 'Nenhum acesso.',
  }), el('button', { class: 'botao', onclick: () => editar(null, recarregar) }, icone('mais'), 'Novo acesso')));
}

function editar(u, recarregar) {
  const novo = !u;
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'nome', rotulo: 'Nome', valor: u?.nome ?? '', obrigatorio: true }),
    novo ? campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true }) : null,
    campo({ nome: 'perfil', rotulo: 'Perfil', tipo: 'select', valor: u?.perfil ?? 'operador', opcoes: Object.entries(R.perfilCliente) }),
    novo ? null : campo({ nome: 'ativo', rotulo: 'Situação', tipo: 'select', valor: String(u.ativo), opcoes: [['1', 'Ativo'], ['0', 'Inativo']] }),
    novo ? null : campo({ nome: 'redefinir_senha', rotulo: 'Redefinir senha', tipo: 'select', valor: '0', opcoes: [['0', 'Não'], ['1', 'Sim, gerar nova senha provisória']] }));
  const botao = el('button', { class: 'botao' }, novo ? 'Criar acesso' : 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    const out = novo ? await api.post('/usuarios', lerForm(form)) : await api.patch(`/usuarios/${u.id}`, lerForm(form));
    m.fechar();
    if (out.senha_provisoria) {
      modal({ titulo: 'Senha provisória', corpo: [el('p', {}, 'Entregue esta senha à pessoa. Ela será trocada no primeiro acesso.'),
        el('div', { class: 'codigo' }, out.senha_provisoria)],
      acoes: [el('button', { class: 'botao', onclick: () => copiar(out.senha_provisoria) }, icone('copiar'), 'Copiar')] });
    } else {
      toast('Acesso atualizado.', 'ok');
    }
    recarregar();
  }));
  const m = modal({ titulo: novo ? 'Novo acesso' : `Editar ${u.nome}`, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

async function abaIxc(alvo, recarregar) {
  const d = await api.get('/ixc');
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
  montar(alvo, 
    cartao('Integração com o IXC',
      el('div', {},
        d.configurada
          ? el('div', { class: 'pares' },
            par('Estado', selo(d.estado, R.estadoIntegracao)),
            par('Endereço', d.config.url ?? '—'),
            par('Tipo do boleto', R.tipoBoleto[d.config.tipo_padrao] ?? '—'),
            par('Importação automática', d.config.importacao_automatica ? 'Ligada (todo dia)' : 'Desligada'))
          : aviso('O seu IXC ainda não está ligado à PayAx. Peça ao seu gerente de conta para configurar o endereço e o token — depois disso, os títulos em aberto viram boletos aqui com um clique.', 'info'),
        d.ultimo_erro ? el('div', { style: 'margin-top:10px' }, aviso(d.ultimo_erro, 'erro')) : null),
      d.configurada ? el('div', { style: 'display:flex;gap:8px' },
        pode('ixc.configurar') ? el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/ixc/testar', {});
          toast(`IXC respondeu · ${numero(r.clientes)} cliente(s) na base.`, 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Testar conexão') : null,
        pode('boletos.emitir') ? el('button', { class: 'botao', onclick: () => importar(recarregar) }, icone('importar'), 'Importar títulos') : null) : null),

    el('div', { style: 'margin-top:14px' }, cartao('Últimas importações e baixas', tabela({
      colunas: [
        { titulo: 'Quando', conteudo: (s) => dataHora(s.inicio) },
        { titulo: 'Tipo', conteudo: (s) => ({ importacao: 'Importação', baixa: 'Baixa no IXC', teste: 'Teste' }[s.tipo] ?? s.tipo) },
        { titulo: 'Lidos', dir: true, conteudo: (s) => numero(s.lidos) },
        { titulo: 'Boletos criados', dir: true, conteudo: (s) => numero(s.criados) },
        { titulo: 'Ignorados', dir: true, conteudo: (s) => numero(s.ignorados) },
        { titulo: 'Erros', dir: true, conteudo: (s) => el('span', { style: s.erros ? 'color:var(--vermelho);font-weight:600' : '' }, numero(s.erros)) },
      ],
      itens: d.sincronismos,
      vazio: 'Nenhuma importação ainda.',
    }))),
  );
}

function importar(recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'de', rotulo: 'Vencimento de', tipo: 'date', valor: hojeIso() }),
    campo({ nome: 'ate', rotulo: 'até', tipo: 'date', valor: somarDias(hojeIso(), 10) }));
  const botao = el('button', { class: 'botao' }, icone('importar'), 'Importar e emitir');
  botao.addEventListener('click', () => acao(botao, async () => {
    const r = await api.post('/ixc/importar', lerForm(form));
    m.fechar();
    toast(`${r.criados} boleto(s) emitido(s) · ${r.ignorados} já existiam · ${r.erros} erro(s).`, r.erros ? 'erro' : 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'Importar títulos do IXC',
    corpo: [aviso('Cada título em aberto no IXC com vencimento no período vira um boleto. Títulos já importados são ignorados.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}
