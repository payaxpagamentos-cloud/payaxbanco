'use strict';

const { agora } = require('../db');

/*
 * Checklists iniciais por tipo de serviço (a organização cria versões novas na tela de Chamados).
 * São a estrutura do atendimento, não dados de exemplo: não há valores, pessoas ou endereços.
 */
const CHECKLISTS_PADRAO = {
  instalacao: [
    { chave: 'porta', rotulo: 'Porta da CTO identificada', tipo: 'texto', obrigatorio: true },
    { chave: 'potencia_final', rotulo: 'Potência recebida na ONU', tipo: 'numero', unidade: 'dBm', obrigatorio: true },
    { chave: 'teste_final', rotulo: 'Teste de navegação concluído com o cliente', tipo: 'confirmacao', obrigatorio: true },
    { chave: 'foto', rotulo: 'Foto da instalação', tipo: 'foto', obrigatorio: true },
  ],
  reparo: [
    { chave: 'potencia_antes', rotulo: 'Potência antes do reparo', tipo: 'numero', unidade: 'dBm', obrigatorio: true },
    { chave: 'potencia_depois', rotulo: 'Potência depois do reparo', tipo: 'numero', unidade: 'dBm', obrigatorio: true },
    { chave: 'causa', rotulo: 'Causa encontrada', tipo: 'texto', obrigatorio: true },
    { chave: 'foto', rotulo: 'Foto do ponto reparado', tipo: 'foto', obrigatorio: true },
  ],
  fusao: [
    { chave: 'fibras_fundidas', rotulo: 'Fibras fundidas', tipo: 'numero', unidade: 'fibras', obrigatorio: true },
    { chave: 'teste_otdr', rotulo: 'Teste de continuidade/OTDR registrado', tipo: 'confirmacao', obrigatorio: true },
    { chave: 'foto', rotulo: 'Foto da bandeja', tipo: 'foto', obrigatorio: true },
  ],
  manutencao_rede: [
    { chave: 'servico', rotulo: 'Serviço executado', tipo: 'texto', obrigatorio: true },
    { chave: 'foto', rotulo: 'Foto do local', tipo: 'foto', obrigatorio: false },
  ],
  vistoria: [
    { chave: 'situacao', rotulo: 'Situação encontrada', tipo: 'texto', obrigatorio: true },
    { chave: 'foto', rotulo: 'Foto do ativo', tipo: 'foto', obrigatorio: true },
  ],
  retirada: [
    { chave: 'equipamento', rotulo: 'Equipamento recolhido', tipo: 'texto', obrigatorio: true },
    { chave: 'porta_liberada', rotulo: 'Porta liberada na CTO', tipo: 'confirmacao', obrigatorio: true },
  ],
  outro: [{ chave: 'descricao', rotulo: 'Descrição do que foi feito', tipo: 'texto', obrigatorio: true }],
};

/*
 * Regra inicial de disponibilidade de equipamento ativo (amostra 1 = respondeu, 0 = não respondeu), com confirmação
 * em 2 amostras. Limiares de potência óptica, latência e perda dependem de equipamento e política: são criados pelo NOC.
 */
const REGRAS_PADRAO = [
  { nome: 'Equipamento sem resposta', metrica: 'disponibilidade', comparacao: 'menor', limiar: 1, limiar_recuperacao: 1, confirmacoes: 2, severidade: 'critica' },
];

function criarOrganizacao(db, { nome, fuso = 'America/Sao_Paulo', demonstracao = false }) {
  const t = agora();
  const id = Number(db.prepare('INSERT INTO organizacoes (nome, fuso, demonstracao, criada_em) VALUES (?, ?, ?, ?)').run(nome, fuso, demonstracao ? 1 : 0, t).lastInsertRowid);
  const ck = db.prepare('INSERT INTO checklist_modelos (organizacao_id, tipo_servico, versao, itens, criado_em) VALUES (?, ?, 1, ?, ?)');
  for (const [tipo, itens] of Object.entries(CHECKLISTS_PADRAO)) ck.run(id, tipo, JSON.stringify(itens), t);
  const rg = db.prepare(`INSERT INTO regras_monitoramento (organizacao_id, nome, metrica, comparacao, limiar, limiar_recuperacao, confirmacoes, severidade, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of REGRAS_PADRAO) rg.run(id, r.nome, r.metrica, r.comparacao, r.limiar, r.limiar_recuperacao, r.confirmacoes, r.severidade, t, t);
  return id;
}

module.exports = { criarOrganizacao, CHECKLISTS_PADRAO };
