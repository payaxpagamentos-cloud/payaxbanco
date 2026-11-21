/** Telas do painel da equipe (master e operador). */
import { visao } from './visao.js';
import { telasEquipe, pontos, comunicados } from './rede.js';
import { anunciantes, campanhas, criativos, programacao } from './comercial.js';
import { relatorios, faturamento, contasAReceber, contasAPagar, fluxoCaixa } from './financeiro.js';
import { inventario } from './inventario.js';
import { usuarios, configuracoes, diagnostico, historico } from './admin.js';

export const TELAS_EQUIPE = {
  resumo: visao,
  telas: telasEquipe,
  pontos,
  comunicados,
  anunciantes,
  campanhas,
  criativos,
  programacao,
  inventario,
  relatorios,
  faturamento,
  caixa: fluxoCaixa,
  receber: contasAReceber,
  pagar: contasAPagar,
  diagnostico,
  usuarios,
  configuracoes,
  historico,
};
