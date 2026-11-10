'use strict';

/**
 * Permissões por perfil, verificadas no servidor em cada rota. Esconder um botão na tela não substitui esta tabela.
 * Escopos de técnico (só os próprios chamados, comissões e abastecimentos) são aplicados dentro das rotas.
 */
const PERFIS = {
  admin: 'Administrador',
  gestor: 'Gestor operacional',
  noc: 'NOC',
  frota: 'Gestor de frota',
  tecnico: 'Técnico',
  comissoes: 'Conferência de comissões',
  consulta: 'Consulta / TV',
};

const TODOS = Object.keys(PERFIS);
const P = {
  'painel.ver': TODOS,
  'rede.ver': ['admin', 'gestor', 'noc', 'tecnico', 'consulta'],
  'rede.editar': ['admin', 'gestor', 'noc'],
  'rede.portas': ['admin', 'gestor', 'noc', 'tecnico'],
  'noc.ver': ['admin', 'gestor', 'noc', 'consulta'],
  'noc.operar': ['admin', 'gestor', 'noc'],
  'noc.regras': ['admin', 'noc'],
  'chamados.ver': ['admin', 'gestor', 'noc', 'tecnico', 'consulta'],
  'chamados.criar': ['admin', 'gestor', 'noc'],
  'chamados.atribuir': ['admin', 'gestor'],
  'chamados.executar': ['admin', 'gestor', 'tecnico'],
  'chamados.validar': ['admin', 'gestor'],
  'chamados.checklists': ['admin', 'gestor'],
  'equipe.ver': ['admin', 'gestor', 'comissoes', 'frota'],
  'equipe.editar': ['admin', 'gestor'],
  'comissoes.ver': ['admin', 'gestor', 'comissoes', 'tecnico'],
  'comissoes.regras': ['admin', 'comissoes'],
  'comissoes.aprovar': ['admin', 'comissoes'],
  'comissoes.pagar': ['admin', 'comissoes'],
  'frota.ver': ['admin', 'gestor', 'frota', 'tecnico'],
  'frota.editar': ['admin', 'frota'],
  'frota.escalar': ['admin', 'gestor', 'frota'],
  'frota.documentos': ['admin', 'frota'],
  'manutencao.ver': ['admin', 'gestor', 'frota'],
  'manutencao.editar': ['admin', 'frota'],
  'combustivel.ver': ['admin', 'gestor', 'frota', 'tecnico'],
  'combustivel.lancar': ['admin', 'frota', 'tecnico'],
  'combustivel.corrigir': ['admin', 'frota'],
  'combustivel.comprovantes': ['admin', 'frota'],
  'rastreamento.ver': ['admin', 'gestor', 'frota'],
  'rastreamento.vincular': ['admin', 'frota'],
  // Tráfego e Anti-DDoS. Sessões dos assinantes têm login e MAC (dado pessoal): fora do perfil de consulta/TV.
  'trafego.ver': ['admin', 'gestor', 'noc', 'consulta'],
  'ddos.ver': ['admin', 'gestor', 'noc', 'consulta'],
  'ddos.operar': ['admin', 'noc'],
  'ddos.configurar': ['admin', 'noc'],
  'assinantes.ver': ['admin', 'gestor', 'noc'],
  'avisos.configurar': ['admin'],
  'integracoes.ver': ['admin', 'noc', 'frota', 'gestor'],
  'integracoes.editar': ['admin'],
  'usuarios.gerenciar': ['admin'],
  'auditoria.ver': ['admin'],
  'organizacao.editar': ['admin'],
};

const pode = (perfil, permissao) => Boolean(P[permissao]?.includes(perfil));
const permissoesDo = (perfil) => Object.keys(P).filter((k) => pode(perfil, k));

module.exports = { PERFIS, P, pode, permissoesDo };
