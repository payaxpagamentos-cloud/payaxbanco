'use strict';

/*
 * Permissões por perfil.
 *
 * Equipe PAY AX:
 *   admin      — tudo, inclusive usuários, contas bancárias, preços e credenciais.
 *   financeiro — opera o dinheiro: aprova e envia repasses, ajusta razão, concilia, vê margem.
 *   operacao   — cuida dos clientes e dos boletos (emite, baixa, sincroniza IXC), não move dinheiro.
 *   consulta   — só leitura.
 *
 * Cliente final (Área do Cliente):
 *   admin    — emite boletos e gerencia os próprios usuários.
 *   operador — emite boletos e consulta; não mexe em usuários.
 *   (Não existe "pedir repasse": o valor recebido vai sozinho para a conta do cliente.)
 *   consulta — só leitura.
 */
const EQUIPE = {
  admin: ['*'],
  financeiro: ['painel.ver', 'clientes.ver', 'clientes.editar', 'boletos.ver', 'boletos.emitir', 'boletos.baixar',
    'razao.ver', 'razao.ajustar', 'repasses.ver', 'repasses.aprovar', 'repasses.enviar', 'precos.ver', 'precos.editar',
    'relatorios.ver', 'relatorios.margem', 'conciliacao.ver', 'conciliacao.operar', 'auditoria.ver', 'conformidade.ver'],
  operacao: ['painel.ver', 'clientes.ver', 'clientes.editar', 'boletos.ver', 'boletos.emitir', 'boletos.baixar',
    'razao.ver', 'repasses.ver', 'precos.ver', 'relatorios.ver', 'conciliacao.ver', 'integracoes.ver', 'integracoes.ixc', 'acessos.gerenciar',
    'conformidade.ver'],
  consulta: ['painel.ver', 'clientes.ver', 'boletos.ver', 'razao.ver', 'repasses.ver', 'precos.ver', 'relatorios.ver', 'conciliacao.ver',
    'conformidade.ver'],
};
// conformidade.editar (registrar a situação das regras de acompanhamento): só o administrador, pelo '*'.
// lgpd.ver e lgpd.atender: só o administrador, pelo '*' — os pedidos trazem dados pessoais do titular.
// pld.ver e pld.analisar: só o administrador, pelo '*'. É sigilo de lei (Lei 9.613/1998, art. 11, II):
// alerta e comunicação ao Coaf não podem chegar a quem não precisa saber. Para dar acesso a alguém
// de compliance sem dar o resto, crie um perfil com só essas duas.

const CLIENTE = {
  admin: ['painel.ver', 'boletos.ver', 'boletos.emitir', 'boletos.baixar', 'razao.ver', 'repasses.ver',
    'relatorios.ver', 'cadastro.ver', 'cadastro.editar', 'usuarios.gerenciar', 'ixc.configurar'],
  operador: ['painel.ver', 'boletos.ver', 'boletos.emitir', 'boletos.baixar', 'razao.ver', 'repasses.ver', 'relatorios.ver', 'cadastro.ver'],
  consulta: ['painel.ver', 'boletos.ver', 'razao.ver', 'repasses.ver', 'relatorios.ver', 'cadastro.ver'],
};

/**
 * Permissões que a sessão leva para a tela. O perfil com '*' recebe todas E o próprio '*' —
 * sem ele, a tela escondia do administrador os botões que só ele pode usar (o servidor liberava,
 * mas o botão nem aparecia).
 */
const lista = (tabela, perfil) => (tabela[perfil]?.includes('*') ? ['*', ...todas(tabela)] : tabela[perfil] ?? []);
const todas = (tabela) => [...new Set(Object.values(tabela).flat().filter((p) => p !== '*'))];

const pode = (tabela, perfil, permissao) => {
  const p = tabela[perfil];
  return Boolean(p && (p.includes('*') || p.includes(permissao)));
};

module.exports = {
  EQUIPE,
  CLIENTE,
  permissoesEquipe: (perfil) => lista(EQUIPE, perfil),
  permissoesCliente: (perfil) => lista(CLIENTE, perfil),
  podeEquipe: (perfil, permissao) => pode(EQUIPE, perfil, permissao),
  podeCliente: (perfil, permissao) => pode(CLIENTE, perfil, permissao),
  TODAS_EQUIPE: todas(EQUIPE),
};
