/** Telas do painel da equipe (master e operador). */
import { visao } from './visao.js';
import { telasEquipe, pontos } from './rede.js';
import { anunciantes, campanhas, criativos, programacao } from './comercial.js';
import { relatorios, faturamento, repasses } from './financeiro.js';
import { usuarios, configuracoes, diagnostico, historico } from './admin.js';

export const TELAS_EQUIPE = {
  resumo: visao,
  telas: telasEquipe,
  pontos,
  anunciantes,
  campanhas,
  criativos,
  programacao,
  relatorios,
  faturamento,
  repasses,
  diagnostico,
  usuarios,
  configuracoes,
  historico,
};
