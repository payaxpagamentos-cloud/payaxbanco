# LK TECH — site com painel gerencial

Projeto funcional para enviar ao Code. O visual segue a referência aprovada em `docs/referencia-layout.png`: azul-marinho, laranja, vidro, foto de casal e carrossel de planos. Inclui site responsivo, painel protegido, API e persistência em SQLite.

## Começar

Requisito: **Node.js 24.14 ou superior da linha 24**. O projeto não depende de pacotes npm externos e não exige etapa de build.

```bash
cp .env.example .env
npm run admin:create -- --email seu-email@empresa.com.br
npm start
```

O comando pede uma senha de pelo menos 12 caracteres, com entrada oculta. Não existe senha padrão. No Windows, copie `.env.example` para `.env` pelo explorador ou com `Copy-Item .env.example .env`.

- Site local: `http://localhost:3000`
- Painel: `http://localhost:3000/admin`

Para o Code, comece por **[docs/PROMPT_PARA_CODE.md](docs/PROMPT_PARA_CODE.md)**.

## O que funciona

- Site responsivo para computador, tablet e celular, com CSS de vidro real (`backdrop-filter`).
- Banners com imagem para computador e para celular, título, trecho em laranja, botões, ordenação, ativação e rotação automática configurável. Os controles aparecem quando há mais de um banner ativo.
- Carrossel de planos com rolagem por toque, teclado, botões, indicadores e quantidade de cartões adaptada à tela. A rotação automática é opcional.
- Planos: nome, preço, período, descrição, condições, benefícios, destaque, ativação e ordem. Preço vazio mostra “Valores sob consulta”. Zero é tratado como um preço válido.
- Edição de slogan, textos, perguntas frequentes, título/descrição da página, contatos e links.
- Upload e galeria de imagens PNG, JPG e WebP até 8 MB. Os arquivos ficam no servidor, não no navegador do administrador.
- Login com senha protegida por scrypt, sessão em cookie HttpOnly e troca de senha.
- Rascunho, prévia autenticada, publicação explícita, controle de edição concorrente e histórico das últimas 30 versões publicadas.
- Consulta de cobertura por intervalos de CEP configurados no painel. Sem cadastro, encaminha para confirmação com a equipe; não afirma cobertura inexistente.
- Formulário de interesse com autorização de contato. Pedidos são gravados no banco, listados no painel, podem mudar de situação e ser exportados como CSV.
- Link para WhatsApp com mensagem do plano selecionado, quando o número estiver configurado.

## Uso do painel

1. Entre em `/admin` com a conta criada pelo comando inicial.
2. Edite em **Banners**, **Planos e preços**, **Textos e perguntas**, **Marca e contatos** ou **Cobertura**.
3. Clique em **Salvar rascunho**.
4. Abra **Ver prévia** para conferir o rascunho. Essa prévia exige login e não altera o site público.
5. Clique em **Publicar**. As mudanças estarão disponíveis na próxima carga do site público.

Use as setas no painel para ordenar banners, planos e perguntas. A exclusão de um item afeta o rascunho; a publicação anterior continua disponível no histórico.

## Proteção do layout

Nada que o administrador altere no painel muda a estrutura ou o desenho do site:

- **Limite de caracteres por campo**, do tamanho do espaço no desenho (ex.: nome do plano 12, título do banner 24, botões 20). O painel mostra o contador e não deixa digitar além; o servidor recusa ao salvar se o limite for ultrapassado. Os limites ficam em um único arquivo, `public/limites.js`, usado pelo painel e pelo servidor.
- **Campos de uma linha** não guardam quebras de linha. Só o título do Atendimento (2 linhas) e as respostas das perguntas aceitam quebras.
- **Quantidade máxima**: 8 banners, 12 planos, 4 benefícios por plano, 12 perguntas. Preço até R$ 9.999,99.
- **Cores e logo fixos**: o laranja, o azul-marinho e o logo da empresa não são editáveis no painel.
- **Site independente**: não abre nem se liga a nenhum outro sistema (PABX, Network etc.).
- **Imagens do banner** sempre preenchem o mesmo espaço (recorte automático), em qualquer formato. O painel mostra a medida e a qualidade de cada imagem (computador: 1920 × 1080, JPG ou WebP; celular: 1080 × 1440) e recusa o envio de imagem menor que o mínimo (1600 × 900 e 720 × 960).
- **Banners empilhados**: a altura do banner não muda quando ele troca.
- **Cartões de plano** com a mesma altura, linha do preço e botão alinhados em todos; com poucos planos, o carrossel fica centralizado.
- **Camada de segurança no CSS** (fim de `public/site.css`): mesmo que um texto antigo ultrapasse o espaço, ele é cortado com "…" ou quebra dentro da caixa, sem rolagem lateral.

## Conteúdo que precisa ser preenchido

Os planos iniciais são **exemplos visuais sem preços**: 500, 700, 900 e 100 Mega. O quarto item permite experimentar o carrossel já na primeira execução. Substitua pelos planos reais e revise a observação da seção.

Em **Marca e contatos**, configure:

- WhatsApp: apenas números, com DDI e DDD.
- URL HTTPS da Área do Cliente, segunda via e suporte que a empresa já utiliza.
- Telefone, e-mail, endereço e link da política de privacidade, quando aplicáveis.

Sem WhatsApp, os botões comerciais abrem o formulário de interesse. Os atalhos de conta e segunda via abrem as URLs configuradas; se estiverem vazias, oferecem contato. **Não há integração autenticada com IXC, faturamento ou abertura de chamados incluída** — esses fluxos usam os links oficiais cadastrados pela empresa.

## Arquivos

```text
public/              Site, painel, JavaScript, CSS e imagens
server/index.mjs     Servidor HTTP e rotas da API
server/store.mjs     SQLite, rascunhos, publicação e histórico
server/auth.mjs      Senhas e sessões
server/validation.mjs Validação de conteúdo
server/seed.mjs       Conteúdo inicial
scripts/             Criação de administrador, checks e backup
tests/               Testes de integração
docs/                Referência e orientação para o Code
```

`public/assets/logo.svg` e `logo-dark.svg` são reconstruções vetoriais para desenvolvimento, com letras em curvas, sem dependência de fonte. O logo **não é alterado pelo painel**: para trocar pelo arquivo oficial da marca, substitua `public/assets/logo.svg` no servidor. A foto do banner foi criada para este projeto e está incluída localmente.

## Testar

```bash
npm run check
npm test
```

Os testes verificam login, bloqueio de acesso sem sessão, origem/CSRF, rascunho versus publicação, conflitos de versão, upload, rejeição de SVG ativo, consulta de cobertura, captação de contato, CSV, persistência e encerramento de sessões após troca de senha. Eles usam uma pasta temporária, sem alterar os dados do site.

## Publicar em um servidor

Este projeto precisa de **servidor Node com disco persistente**. Não basta enviar a pasta `public` para uma hospedagem estática.

1. Envie o projeto para o servidor e mantenha o Node da linha 24 atualizado.
2. Crie `.env` a partir do exemplo e defina `NODE_ENV=production`, `PUBLIC_ORIGIN=https://seu-dominio-real` e `DATA_DIR` em disco persistente.
3. Coloque HTTPS em um proxy reverso e encaminhe para a porta do Node. Se o proxy for confiável, use `TRUST_PROXY=true`.
4. Crie seu administrador no servidor. Contas de teste e bancos locais não acompanham este pacote.
5. Execute `npm start` com um supervisor de processos ou use o Dockerfile incluído.

Em produção, `PUBLIC_ORIGIN` precisa ter o domínio HTTPS exato, sem barra final. A proteção de origem e o cookie Secure dependem dessa configuração. Para domínios com e sem `www`, escolha um domínio canônico e redirecione o outro no proxy.

Exemplo de proxy Nginx, dentro do bloco HTTPS do domínio:

```nginx
client_max_body_size 9m;
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Com Docker, monte um volume persistente em `/app/data`, configure `PUBLIC_ORIGIN` e crie o administrador dentro do contêiner com `docker exec -it <container> npm run admin:create -- --email seu-email@empresa.com.br`. O Dockerfile já usa um usuário sem privilégios de root. Não mantenha múltiplas réplicas usando o mesmo SQLite; para escalar horizontalmente, migre a persistência para um serviço compartilhado.

## Domínio oficial: lktechprovedor.com.br

- No `.env` do servidor: `NODE_ENV=production`, `PUBLIC_ORIGIN=https://lktechprovedor.com.br` e `TRUST_PROXY=true` (atrás do proxy HTTPS).
- Quem entra por `www.lktechprovedor.com.br` é redirecionado (301) para `https://lktechprovedor.com.br`.
- A página entrega o endereço oficial ao Google e às redes sociais (`canonical` e `og:`), e o servidor responde `/robots.txt` (painel e API fora da busca) e `/sitemap.xml`.
- Hospedagem: VPS (Hostinger) com Ubuntu 24.04. A instalação é feita por um único comando; o passo a passo completo, incluindo o apontamento do domínio sem derrubar o e-mail, está em **[implantacao/LEIA-ME.md](implantacao/LEIA-ME.md)**.

## Backup e recuperação

```bash
npm run backup
```

O comando cria uma cópia consistente do banco e copia as imagens para `backups/`. Guarde a pasta de backup em local protegido: ela contém os dados administrativos e pedidos de contato. Para recuperar, pare o servidor, substitua o conteúdo de `DATA_DIR` pelo backup e inicie novamente.

Para redefinir uma senha administrativamente:

```bash
npm run admin:create -- --email seu-email@empresa.com.br --reset
```

O comando redefine apenas essa conta e encerra suas sessões. Para provisionamento automatizado, o script aceita a variável temporária `LK_ADMIN_PASSWORD`; não a deixe gravada em arquivos versionados.

## Base técnica

HTML, CSS e JavaScript nativos no frontend; Node.js 24 e SQLite no backend. Sem chaves externas, CDN obrigatória ou dependência de localStorage para o conteúdo. A API não usa cache para as configurações. O módulo SQLite vem do Node; sua API pode evoluir entre versões principais, por isso o projeto fixa a linha 24 e inclui testes.

Documentação oficial: [SQLite do Node.js 24](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) e [Crypto do Node.js 24](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
