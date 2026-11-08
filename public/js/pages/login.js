import { $, html } from '../ui.js';
import { telaEntrada } from './entrada.js';

/** Login da equipe da Ativa BPO Financeiro. */
export default function login(alvo, aoEntrar) {
  telaEntrada(alvo, {
    tituloPagina: 'Entrar · Ativa BPO Financeiro',
    titulo: 'Entre em sua conta',
    selo: 'BPO financeiro da sua carteira, ao vivo',
    linha1: 'Mais controle para o financeiro dos seus clientes',
    destaque: 'crescer.',
    descricao: 'Contas a pagar e a receber, conciliação, fluxo de caixa, DRE e aprovações de todas as empresas em um só painel, atualizados ao longo do dia.',
    rota: '/auth/login',
    rota2fa: '/auth/2fa/login',
    aviso: 'Conexão segura · acesso só para a equipe',
    troca: html`É cliente? Acesse o <a href="#" data-endereco="portal">Portal do Cliente</a>.`,
    aoEntrar: () => { $('#app').innerHTML = ''; aoEntrar(); },
  });
}
