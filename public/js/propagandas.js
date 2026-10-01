/*
 * Peças da vitrine exibida no painel lateral das telas de login (Banqueiro e Internet Banking).
 * Para trocar uma campanha, edite os textos abaixo. Para usar uma arte pronta da agência,
 * coloque o arquivo em public/img/propagandas/ e informe { imagem: 'propagandas/arquivo.jpg', alt: '...' }.
 */
export const PROPAGANDAS = [
  { imagem: 'payax-marca.jpg', alt: 'PAY AX — O futuro em cada transação.' },
  {
    selo: 'PIX 24 horas', icone: 'pix',
    titulo: 'Pague e receba em segundos, a qualquer hora.',
    texto: 'Envie PIX para qualquer banco e receba por QR Code direto na sua conta PAY AX.',
  },
  {
    selo: 'Pagamentos', icone: 'barras',
    titulo: 'Contas em dia, sem sair de casa.',
    texto: 'Pague boletos, água, luz e telefone pelo Internet Banking, com comprovante na hora.',
  },
  {
    selo: 'Segurança', icone: 'auditoria',
    titulo: 'Sua senha protegida em cada acesso.',
    texto: 'Teclado virtual que muda a cada entrada e senha de transação para confirmar cada operação.',
  },
  {
    selo: 'Crédito', icone: 'emprestimos',
    titulo: 'Crédito sob medida para você e sua empresa.',
    texto: 'Fale com seu gerente PAY AX e conheça as condições de empréstimo com parcelas fixas.',
  },
  {
    selo: 'Conta PJ', icone: 'contas',
    titulo: 'Sua empresa recebendo melhor.',
    texto: 'Receba de clientes por PIX e acompanhe saldo, extrato e pagamentos em tempo real.',
  },
];
