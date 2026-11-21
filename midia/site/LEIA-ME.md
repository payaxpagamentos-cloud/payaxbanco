# VAI MÍDIA - Site responsivo

Implementação do visual aprovado: fundo claro, navegação com efeito vidro, tipografia escura, verde-lima nos detalhes e campanhas com cores diferentes nas telas.

## Abrir o site

Extraia o ZIP e abra `index.html` no navegador. Não há dependências para instalar nem etapa de compilação. Também pode publicar a pasta em hospedagem estática.

Para testar com servidor local, dentro da pasta:

```bash
python3 -m http.server 8000
```

Abra `http://localhost:8000`.

## O que está incluído

- Página completa em HTML, CSS e JavaScript editáveis.
- Layout para computador, tablet e celular.
- Menu para celular, abas de formatos e perguntas frequentes.
- Planejador de campanha com validação, resumo, cópia e download do briefing.
- Portfólio comercial original em PDF, incluído no pacote e acessível pelo site.
- Fonte local, símbolo vetorial e referência visual aprovada.
- Respeito à preferência de redução de movimento, navegação por teclado e diálogo acessível.

## Configurar os contatos reais

O **WhatsApp** pode vir de dois lugares: do painel (*Configurações → WhatsApp da empresa*), que é onde a
equipe mexe no dia a dia, ou do arquivo abaixo, para quando o site roda sozinho. O do arquivo tem
prioridade.

Edite `js/config.js`:

```js
window.VAI_CONFIG = Object.freeze({
  companyName: 'VAI MÍDIA',
  whatsapp: '',
  email: '',
  instagramUrl: '',
  siteUrl: ''
});
```

Use somente dados oficiais. O WhatsApp deve conter país, DDD e número, sem espaços ou pontuação. Quando um número válido é preenchido, o briefing oferece a opção de abri-lo no WhatsApp; o visitante confirma o envio no próprio aplicativo. E-mail e Instagram aparecem no rodapé apenas quando configurados.

Não foi inventado um telefone, e-mail, perfil social ou domínio. O campo `siteUrl` deve receber o endereço oficial antes da publicação.

## Como funciona o formulário

O planejador continua montando o briefing no navegador — dá para baixar o TXT, copiar o resumo e mandar
no WhatsApp. **Além disso, o pedido vai para o sistema da VAI MÍDIA** (a pasta `midia/` deste repositório):
ele entra no **CRM como lead com origem "site"**, com o briefing na primeira anotação. Quem pede para
anunciar vira lead de anunciante; quem oferece o espaço, lead de ponto.

Por isso o formulário ganhou **nome, e-mail e WhatsApp**: sem um caminho de volta, o pedido chega e
ninguém consegue responder. A API aceita o envio com e-mail **ou** telefone, com limite por IP.

A mensagem de recebimento só aparece depois que o servidor confirma. Se o site for hospedado sozinho,
longe da API, nada quebra: o visitante segue com o resumo para baixar, copiar ou mandar no WhatsApp.

## Organização

```text
index.html
css/styles.css
js/config.js
js/app.js
assets/marca.svg
assets/layout-aprovado.png
assets/VAI_MIDIA_Portfolio_Comercial.pdf
assets/fonts/
documentacao/PROMPT_PARA_CODE.md
```

## Imagens e identidade

`assets/layout-aprovado.webp` é a arte aprovada no atendimento (convertida de PNG para WebP: 2 MB viraram
183 kB, com as mesmas dimensões, então os recortes `data-crop` continuam valendo). As fotografias são enquadradas a partir dessa referência no navegador, por `data-crop`, sem inserir os textos da interface como imagem: títulos, botões, navegação, abas e formulários são HTML real.

Para substituir por fotografias independentes em maior resolução, ajuste o `src`, as dimensões da fonte e o enquadramento em `js/app.js`. O arquivo de referência continua útil para conferir o resultado. As imagens são simulações; não devem ser apresentadas como prova de instalações ou clientes reais.

O símbolo da marca é um SVG editável. A tipografia do site é Open Sans, incluída localmente com sua licença. O pacote não depende de CDN ou de conexão externa para carregar o visual.

## Publicação

1. Configure os contatos e o endereço oficial.
2. Hospede todos os arquivos mantendo as pastas.
3. Para compartilhamento em redes sociais, coloque a URL pública absoluta da imagem em `og:image` no HTML. A configuração `siteUrl` também prepara esse metadado no navegador, mas os robôs de prévia normalmente exigem o valor já no HTML.
4. Confira os links, o PDF e o planejador no domínio final.

O envio deste pacote não publica nem registra um domínio.
