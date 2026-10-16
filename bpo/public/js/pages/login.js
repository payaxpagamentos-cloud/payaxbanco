import { $, raw } from '../ui.js';
import { telaEntrada } from './entrada.js';

/** Login da equipe da Ativa BPO Financeiro. */
export default function login(alvo, aoEntrar) {
  telaEntrada(alvo, {
    tituloPagina: 'Entrar · Ativa BPO Financeiro',
    titulo: 'Bem-vindo de volta',
    subtitulo: 'Acesse com seu e-mail e senha da equipe.',
    chamada: 'BPO Financeiro',
    texto: 'O financeiro dos seus clientes, organizado e em dia.',
    itens: [['pagar', 'Contas a pagar e a receber'], ['conciliar', 'Conciliação bancária'], ['fluxo', 'Fluxo de caixa e DRE'], ['check', 'Aprovação de pagamentos'], ['tarefas', 'Fechamento mensal da carteira']],
    rota: '/auth/login',
    rota2fa: '/auth/2fa/login',
    aviso: 'Acesso restrito à equipe Ativa. Todas as ações ficam registradas.',
    troca: raw('É cliente? Acesse o <a href="/portal/">Portal do Cliente</a>.'),
    aoEntrar: () => { $('#app').innerHTML = ''; aoEntrar(); },
  });
}
