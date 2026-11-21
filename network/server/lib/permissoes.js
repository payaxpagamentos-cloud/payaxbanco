'use strict';

/**
 * Permissões por perfil, verificadas no servidor em cada rota. Esconder um botão na tela não substitui esta tabela.
 * Escopos de técnico (só os próprios chamados, comissões e abastecimentos) são aplicados dentro das rotas.
 *
 * Esta tabela é a única verdade sobre perfis: o banco guarda o perfil como texto livre e a rota valida contra as
 * chaves daqui, então um módulo novo acrescenta um perfil sem mexer no esquema.
 */
const PERFIS = {
  admin: 'Administrador',
  gestor: 'Gestor operacional',
  noc: 'NOC',
  frota: 'Gestor de frota',
  tecnico: 'Técnico',
  comissoes: 'Conferência de comissões',
  financeiro: 'Financeiro',
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
  // Assinantes e planos. O técnico não consulta a base de assinantes: no chamado dele vêm só os dados daquele atendimento.
  'assinantes.ver': ['admin', 'financeiro', 'gestor', 'noc'],
  'assinantes.editar': ['admin', 'financeiro'],
  'planos.editar': ['admin', 'financeiro'],
  'contratos.ver': ['admin', 'financeiro', 'gestor', 'noc'],
  'contratos.editar': ['admin', 'financeiro'],
  // Ativar, suspender, reativar e cancelar contrato: mexe no serviço e na receita.
  'contratos.ciclo': ['admin', 'financeiro'],
  'faturamento.ver': ['admin', 'financeiro', 'gestor'],
  'faturamento.faturar': ['admin', 'financeiro'],
  'faturamento.baixar': ['admin', 'financeiro'],
  // Estornar baixa e cancelar fatura desfazem dinheiro já registrado: só o administrador.
  'faturamento.estornar': ['admin'],
  'cobranca.ver': ['admin', 'financeiro', 'gestor'],
  'cobranca.regras': ['admin', 'financeiro'],
  'cobranca.executar': ['admin', 'financeiro'],
  'bloqueios.aplicar': ['admin', 'financeiro'],
  'bloqueios.liberar': ['admin', 'financeiro'],
  /*
   * Panorama: o mapa mostra nome, endereço e telefone de toda a carteira numa tela só. É a visão mais
   * sensível do sistema, e por isso NÃO acompanha 'rede.ver': o técnico enxerga a planta óptica, não a
   * base de assinantes — no chamado dele vêm só os dados daquele atendimento.
   */
  'panorama.ver': ['admin', 'gestor', 'noc', 'financeiro'],
  // Desenhar área, medir impacto e abrir incidente a partir dela é operação de rede.
  'panorama.area': ['admin', 'gestor', 'noc'],
  /*
   * Contabilidade. Ver o balancete e a DRE é ver o resultado inteiro da empresa, por isso fica no
   * administrador, no gestor e no financeiro. Lançar e fechar competência mexem no que vai ao contador:
   * só administrador e financeiro. Reabrir mês fechado desfaz o que já foi entregue: só administrador.
   */
  'contabil.ver': ['admin', 'gestor', 'financeiro'],
  'contabil.lancar': ['admin', 'financeiro'],
  'contabil.plano': ['admin', 'financeiro'],
  'contabil.fechar': ['admin', 'financeiro'],
  'contabil.reabrir': ['admin'],
  'integracoes.ver': ['admin', 'noc', 'frota', 'gestor'],
  'integracoes.editar': ['admin'],
  'usuarios.gerenciar': ['admin'],
  'auditoria.ver': ['admin'],
  'organizacao.editar': ['admin'],
};

const pode = (perfil, permissao) => Boolean(P[permissao]?.includes(perfil));
const permissoesDo = (perfil) => Object.keys(P).filter((k) => pode(perfil, k));

module.exports = { PERFIS, P, pode, permissoesDo };
