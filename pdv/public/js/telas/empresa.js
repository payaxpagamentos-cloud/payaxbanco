import { telaPdv } from './pdv.js';
import { telaCaixa } from './caixa.js';
import { telaRecebimentos } from './recebimentos.js';
import { telaConferencia } from './conferencia.js';
import { telaMaquininhas } from './maquininhas.js';
import { telaCadastros } from './cadastros.js';
import { telaConfiguracoes } from './configuracoes.js';

/** Telas do painel de uma empresa. */
export const TELAS_EMPRESA = {
  pdv: telaPdv,
  caixa: telaCaixa,
  recebimentos: telaRecebimentos,
  conferencia: telaConferencia,
  maquininhas: telaMaquininhas,
  cadastros: telaCadastros,
  configuracoes: telaConfiguracoes,
};
