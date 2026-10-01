/*
 * Peças da vitrine exibida no painel lateral das telas de login (Banqueiro e Internet Banking).
 * Cada peça: foto (em public/img/), ponto de foco da foto, cor de destaque e textos.
 * Peças só com `imagem` e `alt` (sem título) mostram a arte inteira, sem texto por cima.
 * Créditos e licenças das fotos: public/img/propagandas/CREDITOS.md.
 */
export const PROPAGANDAS = [
  {
    imagem: 'propagandas/pix-celular.jpg', foco: '60% 30%', cor: '#2EE6A6',
    selo: 'PIX 24 horas', titulo: 'Pague e receba em segundos, ', destaque: 'a qualquer hora.',
    texto: 'Envie PIX para qualquer banco e receba por QR Code direto na sua conta PAY AX.',
  },
  {
    imagem: 'propagandas/contas-laptop.jpg', foco: '45% 30%', cor: '#FF8A3D',
    selo: 'Pagamentos', titulo: 'Contas em dia, ', destaque: 'sem sair de casa.',
    texto: 'Pague boletos, água, luz e telefone pelo Internet Banking, com comprovante na hora.',
  },
  {
    imagem: 'propagandas/empresa-cafe.jpg', foco: '50% 25%', cor: '#FFC83D',
    selo: 'Conta PJ', titulo: 'Seu negócio ', destaque: 'recebendo melhor.',
    texto: 'Receba de clientes por PIX e acompanhe saldo, extrato e pagamentos em tempo real.',
  },
  { imagem: 'payax-marca.jpg', alt: 'PAY AX — O futuro em cada transação.' },
  {
    imagem: 'propagandas/cidade-sao-paulo.jpg', foco: '50% 40%', cor: '#FF6FA5',
    selo: 'Onde você estiver', titulo: 'O banco que acompanha ', destaque: 'o ritmo da cidade.',
    texto: 'Saldo, extrato e transferências no computador, de casa ou do trabalho.',
  },
  {
    imagem: 'propagandas/credito-escritorio.jpg', foco: '55% 30%', cor: '#B69CFF',
    selo: 'Crédito', titulo: 'Crédito sob medida ', destaque: 'para os seus planos.',
    texto: 'Fale com seu gerente PAY AX e conheça as condições de empréstimo com parcelas fixas.',
  },
  {
    imagem: 'propagandas/rua-pedestres.jpg', foco: '40% 50%', cor: '#5CE1FF',
    selo: 'Segurança', titulo: 'Sua senha protegida ', destaque: 'em cada acesso.',
    texto: 'Teclado virtual que muda a cada entrada e senha de transação para cada operação.',
  },
];
