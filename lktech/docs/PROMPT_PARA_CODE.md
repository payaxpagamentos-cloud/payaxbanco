# Instrução para o Code — LK TECH

Você recebeu um projeto funcional, não apenas um desenho. Leia o README e mantenha a identidade da imagem `docs/referencia-layout.png`.

## Objetivo

Preparar o site da LK TECH para o ambiente final do cliente, preservando o visual escuro com vidro, logo LK TECH em branco/laranja, foto do casal, carrossel de planos e a hierarquia da referência. O administrador deve alterar banners, preços, ofertas, textos e links sem programar.

## Primeiro execute

1. Verifique o Node.js da linha 24, versão 24.14 ou superior.
2. Copie `.env.example` para `.env`.
3. Rode `npm run check` e `npm test`.
4. Crie uma conta real: `npm run admin:create -- --email EMAIL_DO_ADMINISTRADOR`.
5. Inicie com `npm start` e confira `/` e `/admin`.

O frontend não precisa de build nem de instalar pacotes. Preserve a implementação existente; não substitua o painel por uma simulação em localStorage nem transforme tudo em uma imagem estática.

## Decisões já implementadas

- Conteúdo público e rascunho são documentos distintos no SQLite.
- Edições são salvas com revisão; versões concorrentes retornam HTTP 409.
- `/api/admin/publish` publica um rascunho salvo. A versão pública anterior entra no histórico.
- `/api/admin/preview` exige sessão de administrador.
- Banners podem ter imagens separadas para desktop e celular.
- Planos aceitam preço nulo e preço zero; não confundir os dois.
- O carrossel adapta os cartões visíveis à largura e aceita toque, teclado e controles.
- As rotações automáticas respeitam movimento reduzido, foco, hover e aba invisível.
- Atalhos de conta/fatura apontam para URLs externas fornecidas pelo cliente; não representam um ERP já integrado.
- Leads são armazenados no servidor; não há envio automático de e-mail ou mensagem.
- Cobertura depende de intervalos de CEP cadastrados. A confirmação de instalação ainda depende da viabilidade do endereço.

## Configuração final

Obtenha do responsável pela LK TECH: planos reais, preços, condições, WhatsApp, central do assinante, segunda via, domínio, texto de privacidade e regiões de cobertura. Use os campos do painel para os dados comerciais. Os exemplos do seed não são ofertas confirmadas.

Troque o logo reconstruído pelo master oficial, se ele for fornecido. O SVG atual está em curvas e pode ser editado. Os arquivos de imagem necessários já estão em `public/assets`.

Configure HTTPS, domínio canônico, `PUBLIC_ORIGIN`, supervisor de processo e volume persistente para todo o `DATA_DIR`. Banco, sessões e uploads precisam sobreviver a reinicializações e novos deploys. Não exponha o diretório de dados como pasta estática.

## Conferência de aceite

- Em 1440, 1024, 768, 390 e 360 px, não pode haver rolagem horizontal do documento.
- Foto, títulos e ações precisam continuar legíveis no celular; o menu abre e fecha por botão.
- Plano adicionado, removido, reordenado ou desativado precisa refletir no carrossel depois de salvar e publicar.
- Adicionar dois banners ativos deve habilitar controles e rotação, com pausa durante interação.
- Preço editado no rascunho não pode vazar para o público antes de publicar.
- Upload precisa persistir em disco e continuar acessível após reiniciar.
- Quem não entrou no painel não pode editar, publicar, visualizar leads nem abrir a API de prévia.
- Formulário, link de WhatsApp, CEP, atalhos da central e exportação CSV precisam funcionar com a configuração real.
- Não inclua senhas de teste, banco de desenvolvimento, chaves ou `.env` no versionamento.

## Extensões futuras

Se o cliente pedir integração direta ao IXC, implemente no backend com credenciais em variáveis de ambiente e endpoints específicos. Nunca envie tokens ao navegador. Para campanhas com picos altos ou várias réplicas, troque SQLite por um banco e um armazenamento de arquivos compartilhados. Essas integrações não são necessárias para editar banners e preços no painel atual.
