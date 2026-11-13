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
 * Cliente final (Internet Bank):
 *   admin    — emite, pede repasse, gerencia os próprios usuários.
 *   operador — emite boletos e consulta; não pede repasse nem mexe em usuários.
 *   consulta — só leitura.
 */
const EQUIPE = {
  admin: ['*'],
  financeiro: ['painel.ver', 'clientes.ver', 'clientes.editar', 'boletos.ver', 'boletos.emitir', 'boletos.baixar',
    'razao.ver', 'razao.ajustar', 'repasses.ver', 'repasses.aprovar', 'repasses.enviar', 'precos.ver', 'precos.editar',
    'relatorios.ver', 'relatorios.margem', 'conciliacao.ver', 'conciliacao.operar', 'auditoria.ver'],
  operacao: ['painel.ver', 'clientes.ver', 'clientes.editar', 'boletos.ver', 'boletos.emitir', 'boletos.baixar',
    'razao.ver', 'repasses.ver', 'precos.ver', 'relatorios.ver', 'conciliacao.ver', 'integracoes.ver', 'integracoes.ixc', 'acessos.gerenciar'],
  consulta: ['painel.ver', 'clientes.ver', 'boletos.ver', 'razao.ver', 'repasses.ver', 'precos.ver', 'relatorios.ver', 'conciliacao.ver'],
};

const CLIENTE = {
  admin: ['painel.ver', 'boletos.ver', 'boletos.emitir', 'boletos.baixar', 'razao.ver', 'repasses.ver', 'repasses.solicitar',
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
