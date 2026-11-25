# Chave de assinatura do pacote do Vai Mídia

`assinatura-privada.pem` assina o `vaimidia.zip`. O servidor só instala pelo painel um pacote assinado
por ela (confere com `midia/instalacao/assinatura-publica.pem`).

- Esta pasta fica FORA de `midia/`, então a chave nunca vai dentro do pacote.
- Guardada aqui por decisão do dono do sistema: o repositório é privado, e quem tem acesso a ele já
  pode alterar o código. Se o repositório um dia ficar público ou vazar, gere um par novo
  (ver `midia/instalacao/empacotar.sh`) e atualize o servidor uma vez pelo `atualizar.sh`.
- Para gerar o pacote: `midia/instalacao/empacotar.sh /caminho/de/saida/vaimidia.zip`
