# Artes dos anúncios da capa

Ponha aqui as artes reais que devem girar na tela do elevador, na capa do site — de preferência
peças de clientes que já foram ao ar na rede.

1. Copie os arquivos para esta pasta (JPG, PNG ou WEBP).
2. Liste os nomes em `site/index.html`, no `<body data-criativos="...">`, separados por vírgula:

   ```html
   <body data-criativos="pizzaria.jpg,imobiliaria.jpg,academia.jpg">
   ```

Até três arquivos, na ordem em que aparecem. **Proporção 9:8** é o que a metade de baixo da tela
mostra sem corte — por exemplo **1080 × 960**. Imagem em outra proporção não quebra nada: ela é
cortada pelo centro.

Sem nada listado (ou se o arquivo não carregar), a capa usa as peças de exemplo desenhadas em SVG,
que vivem dentro do próprio `index.html`.

Use só arte que a empresa tem direito de publicar: material aprovado pelo cliente ou criado por vocês.
