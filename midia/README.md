# Mídia Indoor

Sistema para **passar publicidade em TVs instaladas em comércios** (mídia indoor / DOOH), publicado em `/midia`.

Você instala uma TV na padaria, no mercado, na academia ou na clínica; o aparelho ligado nela abre o player e passa a
exibir, em loop, os anúncios das campanhas vendidas. O painel cuida do resto: cadastro dos pontos, aprovação dos
criativos, montagem automática da programação de cada tela, **prova de exibição**, faturamento dos anunciantes e
repasse da comissão aos lojistas.

Servidor próprio (Node.js + SQLite), sem depender dos outros sistemas do repositório. Tema claro por padrão, com o escuro no botão do topo.

| Perfil | O que vê |
|---|---|
| **Master** | Tudo: pontos, TVs, anunciantes, campanhas, criativos, programação, relatórios, faturamento, repasses, usuários, configurações e histórico. |
| **Operador** | O dia a dia: cadastros, campanhas, aprovação de criativos, pareamento de TVs, relatórios, faturamento e repasses. Não mexe em usuários, configurações nem exclui cadastros. |
| **Anunciante** (portal) | Só as campanhas dele: onde passaram, quantas inserções, quantas pessoas alcançou, a prova de exibição em CSV, os criativos e as faturas com PIX. |
| **Lojista** (portal do ponto) | Só o comércio dele: se a TV está no ar, o que está passando, o aviso da própria loja na faixa, o conteúdo da loja e o repasse a receber. |

## Como funciona, do começo ao fim

1. **Cadastre o ponto** (o comércio): endereço, categoria, horário de funcionamento, fluxo estimado de pessoas por dia
   e a comissão combinada com o lojista.
2. **Instale a TV** e abra `/midia/tv/` no aparelho. Ele mostra um código de 6 caracteres na tela.
3. **Pareie** em *TVs › Parear aparelho*: digite o código e diga onde a TV fica. Pronto — o aparelho já começa a exibir.
4. **Cadastre o anunciante**, envie os criativos (imagem ou vídeo) e **aprove** cada um. Nada vai ao ar sem aprovação.
5. **Crie a campanha**: período, dias da semana, faixa de horário, inserções por hora, prioridade, onde passa
   (toda a rede, uma categoria, uma cidade, pontos ou telas específicas) e como cobra. Envie para aprovação e aprove.
6. As TVs **baixam a programação sozinhas** em segundos e começam a exibir. Cada exibição é registrada.
7. No fim do mês, *Faturamento* fecha a competência: gera as faturas dos anunciantes (com PIX) e os repasses dos lojistas.

## Telas

### Painel da equipe
- **Visão geral**: TVs no ar, inserções de hoje, campanhas ativas, receita prevista do mês, inserções por dia,
  publicidade × institucional, campanhas e pontos que mais exibiram, e o que precisa de atenção.
- **TVs**: um cartão por tela com o estado (no ar, sem contato, aguardando pareamento), o que está no ar agora,
  pareamento, aviso na faixa e o detalhe de cada aparelho (programação atual, histórico de quedas, números do dia).
- **Pontos**: os comércios, com TVs no ar, público por dia, comissão, horário de funcionamento, repasses e o acesso do lojista.
- **Anunciantes**: cadastro, campanhas, faturas e o acesso ao portal (com senha provisória).
- **Campanhas**: lista com situação e entrega de hoje; no detalhe, criativos, onde passa, desempenho e as ações de
  situação (enviar, aprovar, recusar, pausar, retomar, encerrar).
- **Criativos**: grade com prévia de cada imagem/vídeo, fila de aprovação, validade e em quantas campanhas está.
- **Programação**: o loop de uma TV (linha do tempo proporcional, fatia de cada anunciante e inserções por hora),
  com simulação de **qualquer dia e hora**, mais a **ocupação de todas as TVs** — onde ainda cabe campanha.
- **Relatórios**: por campanha, por TV, por ponto e a **prova de exibição** linha por linha; tudo com CSV.
- **Faturamento**: prévia do mês (calculada do que foi exibido), fechamento, faturas com PIX copia e cola e QR Code.
- **Repasses aos pontos**: comissão de cada lojista sobre a receita das telas dele, com baixa de pagamento.
- **Diagnóstico**: TVs offline ou sem parear, campanhas sem criativo aprovado, criativos vencendo, pontos sem TV,
  faturas vencidas e PIX não configurado.
- **Usuários**, **Configurações** e **Histórico** (auditoria de quem fez o quê).

### Portal do anunciante
Campanhas no ar, inserções e pessoas alcançadas no mês, desempenho por campanha, onde cada anúncio passou,
**prova de exibição com CSV**, envio de criativos (que a equipe aprova) e faturas com o PIX para pagar.

### Portal do lojista
As TVs da loja (no ar ou não, e o que está passando agora), o **aviso da loja na faixa da TV**
("Pão quentinho às 17h"), envio de conteúdo do estabelecimento e o repasse a receber, mês a mês.

## Como a programação de cada TV é montada

O servidor monta a grade **na hora**, para cada tela, e o player só baixa de novo quando ela muda:

1. Entram as campanhas **ativas** cujo período, dias da semana e faixa de horário batem com o momento, que têm alvo
   compatível com aquela tela (sem alvo = toda a rede) e ao menos um criativo **aprovado e no prazo**.
2. Cada campanha recebe inserções no loop **proporcionais às inserções por hora contratadas**, sempre com pelo menos
   uma por criativo (todos vão ao ar). Campanha com teto diário sai da grade daquela TV quando bate a meta.
3. Se o loop passar do **tempo máximo**, as campanhas de **menor prioridade** perdem inserções primeiro.
   Se ficar abaixo do **tempo mínimo**, o conteúdo institucional (da rede e do próprio ponto) completa.
4. As inserções são **espalhadas** pelo loop e, sempre que possível, dois anúncios do mesmo anunciante não ficam em sequência.
5. Tela em retrato prefere criativo em retrato; em paisagem, o contrário.

A tela *Programação* mostra exatamente esse resultado, inclusive simulando outro dia e horário.

## Prova de exibição, impactos e faturamento

- **Prova de exibição**: o player envia em lote tudo o que foi ao ar (mídia, campanha, instante e duração). Reenvio
  depois de uma queda de internet **não duplica**. O painel e o portal do anunciante mostram linha por linha, com CSV.
- **Impactos** (pessoas alcançadas, estimativa): fluxo de pessoas do ponto no dia × a fatia do tempo de tela que a
  campanha ocupou naquele dia. Uma campanha com 20% do loop de uma padaria de 500 pessoas/dia recebe 100 impactos.
- **Faturamento** do mês, por campanha:
  - **mensal**: o valor contratado, proporcional aos dias em que a campanha esteve no ar dentro do mês;
  - **CPM**: impactos do mês ÷ 1.000 × o CPM contratado;
  - **cortesia**: entra na fatura com valor zero, só para constar o que foi exibido.
  Campanha **sem nenhuma exibição no mês não é cobrada**. Fechar o mês de novo **não altera** fatura paga ou cancelada.
- **Repasse ao lojista**: a receita de cada campanha é dividida entre os pontos na proporção do tempo que ela ocupou
  em cada um; sobre a parte de cada ponto aplica-se a comissão combinada.
- A fatura sai com **PIX copia e cola** (BR Code do Banco Central) e QR Code, com a chave configurada em *Configurações*.

## O player (o que roda na TV)

Abra `https://SEU-DOMINIO/midia/tv/` no aparelho ligado à TV e deixe em tela cheia. Funciona em **TV box Android,
Fire TV Stick, Chromecast com Google TV, mini PC, Raspberry Pi** ou no navegador da própria smart TV.

- **Pareamento por código**: o aparelho não tem usuário nem senha. Mostra um código (sem letras parecidas, tipo `DT6KZ7`),
  a equipe confirma no painel e o aparelho guarda um token próprio. *Desparear* no painel invalida o token na hora.
- **Funciona sem internet**: os arquivos ficam no cache do navegador e a programação fica guardada. Caindo a internet,
  a TV continua exibindo o que tem e mostra um aviso discreto; a fila de exibições é enviada quando a conexão volta.
- **Imagem e vídeo** em tela cheia, com a próxima peça pré-carregada e transição suave. Vídeo roda até o fim; imagem,
  pelo tempo contratado. Vídeo entra sem som, a menos que a tela esteja configurada com som.
- **Faixa de baixo** com relógio, a legenda fixa da tela e o aviso do lojista (quando houver).
- **Troca de programação na virada do loop**, para nunca cortar um anúncio no meio.
- Atalhos para quem instala: **i** mostra o diagnóstico do aparelho (TV, ponto, versão da grade, fila, conexão),
  **f** entra em tela cheia e **r** recarrega.

### API das TVs (para outro player)

Quem quiser usar outro aparelho ou software pode falar direto com a API (`<endereço>/api/player`):

| Rota | O que faz |
|---|---|
| `POST /registrar` | Gera o código de pareamento (manda aparelho, resolução e versão). |
| `GET /pareamento?codigo=` | Consulta até a equipe confirmar; devolve o **token do aparelho**. |
| `GET /programacao` | A grade atual: itens em ordem, duração, versão e a configuração da tela. |
| `POST /batida` | Diz que está vivo e o que está no ar; a resposta avisa se a grade mudou. |
| `POST /exibicoes` | Prova de exibição em lote (até 500 por vez, sem duplicar). |
| `GET /midia/:id` | O arquivo, com cache longo e download parcial (vídeo). |

As rotas usam `Authorization: Bearer <token do aparelho>`.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run demo      # opcional: 6 pontos, 9 TVs, 5 anunciantes, campanhas e 31 dias de exibições
npm start         # painel em http://localhost:3600/midia/ e player em http://localhost:3600/midia/tv/
npm test          # 28 testes de aceite
```

A demonstração cria também estes acessos: `operador@midia.com.br` / `operador-demo-2026`,
`anunciante@midia.com.br` / `anunciante-demo-2026` e `lojista@midia.com.br` / `lojista-demo-2026`.
O master é o configurado em `MIDIA_ADMIN_EMAIL` (padrão `master@midia.com.br` / `master123`).
As TVs da demonstração aparecem como *sem contato* até um player de verdade se parear.

Configuração: veja [`.env.exemplo`](.env.exemplo). Em produção com Docker:

```bash
docker build -t midia-indoor midia/
docker run -p 3600:3600 -v midia-dados:/app/data \
  -e NODE_ENV=production -e MIDIA_SECRET=... -e MIDIA_ADMIN_SENHA=... midia-indoor
```

O banco e os arquivos das mídias ficam em `/app/data` — monte um volume persistente aí.

## Configurações da plataforma

Nome que aparece no painel e nas TVs; duração padrão de imagem; inserções por hora sugeridas; tempo **mínimo** e
**máximo** do loop; intervalo da batida das TVs e quanto tempo sem contato conta como offline; se o lojista pode
escrever o aviso da própria TV; preços de tabela (mensalidade por TV e CPM); comissão sugerida ao lojista; dia de
vencimento das faturas; por quantos dias a prova de exibição detalhada é guardada (o resumo por dia, que alimenta
relatórios e faturamento, **nunca** é apagado); e os dados do PIX.

## Segurança

- Senhas com **scrypt**; sessões do painel por token assinado (HMAC), com validade de 12 horas.
- Cada perfil só enxerga o que é dele: o anunciante nunca vê dados de outro anunciante, o lojista nunca vê outro ponto,
  e o token de uma TV não abre o painel (nem o contrário).
- Arquivos das mídias ficam **fora da pasta pública**, com nome aleatório, e o tipo é reconhecido pelo conteúdo do
  arquivo — não pelo nome nem pelo cabeçalho enviado.
- Limite de tentativas de login por IP, cabeçalhos de segurança e CSP restrita.
- **Histórico** registra quem criou, alterou, aprovou, pareou, faturou e pagou.

## O que depende de terceiros (não incluído)

- **Compra do aparelho e da TV** e a internet do ponto. O player roda no navegador; não há instalação de app.
- **Ligar e desligar a TV sozinha** (CEC/RS-232) depende do modelo do aparelho; o normal é configurar o próprio
  aparelho para ligar com a energia e nunca descansar a tela.
- **Aviso por WhatsApp/e-mail** de fatura ou de TV caída: hoje o painel mostra em Diagnóstico e na Visão geral.
- **Medição real de público** (câmera com contagem de pessoas): os impactos usam o fluxo estimado cadastrado no ponto.
