# Rastreador de Veículos

Plataforma de rastreamento veicular, publicada em `/rastreador`, com dois níveis de acesso: a **central de rastreamento** (master),
que cuida das empresas clientes e do estoque de equipamentos, e as **empresas** (frotas, locadoras ou pessoas físicas), que acompanham os
próprios veículos.

| Perfil | O que vê |
|---|---|
| **Master** | A plataforma inteira: empresas, rastreadores (estoque e instalados), mapa de todas as frotas, usuários, diagnóstico, configurações, integrações e atividades. Entra no painel de qualquer empresa pela lista de Empresas. |
| **Suporte** | Como o master, sem usuários, configurações, financeiro e atividades; não exclui empresas nem rastreadores. |
| **Cliente** (administrador da empresa) | O painel da própria empresa: mapa ao vivo, histórico, alertas, veículos, motoristas, cercas, manutenção, relatórios, comandos (bloqueio), configurações e integrações. |
| **Operador** | O painel da empresa para monitorar: consulta tudo e trata os alertas, sem alterar cadastros nem enviar comandos. |

Sistema independente: servidor, banco de dados (SQLite), usuários e login próprios. Mapa vetorial moderno, no estilo dos aplicativos de
navegação (MapLibre com os estilos gratuitos do OpenFreeMap: "Liberty" no tema claro e "Dark" no escuro); sem WebGL no navegador, usa a
camada de ruas da Esri (os servidores do OpenStreetMap não são usados). Outro estilo (MapTiler, Stadia…) entra pelo `.env` (`RASTREADOR_MAPA_ESTILO`).
Todos os mapas têm o botão **Satélite / Mapa**. O padrão é o **Mapa** de ruas (reto e exato; a foto de satélite sai inclinada em bairros com prédios altos). O **Satélite** é o híbrido, como o dos aplicativos de mapa: foto aérea (Esri World Imagery)
com os nomes de bairros, ruas e lugares (com os ícones) por cima; o Mapa de ruas tem visual moderno (fundo claro, ruas brancas, avenidas em
amarelo, prédios planos). Zoom até 20; a escolha fica lembrada no navegador. O **campo de busca** no mapa encontra rua e número, bairro ou lugar
(Photon/OpenStreetMap, `RASTREADOR_GEOCODER_URL`), e o painel do veículo mostra o **endereço** de onde ele está. Para uso comercial com licença, troque o satélite por um provedor com chave (`RASTREADOR_SATELITE_*`). Tema claro por padrão,
com o escuro no botão do topo. O visual segue a referência aprovada: menu azul-marinho com detalhe verde-menta, destaques em azul,
ciano e menta e, nos dashboards, um bloco com gradiente fluido e órbita animada. O botão **Pausar efeitos** (no topo) para as
animações contínuas, e a preferência "reduzir movimento" do sistema já as deixa paradas.

## Rastreador J16 4G (Indica Planos)

O equipamento usado é o **J16 4G** (etiqueta "IMEI: 8665570…", "4G SA"), que fala o protocolo **GT06** pela rede 4G. O sistema já vem
preparado para ele: posições 4G (0xA0), estado e alarmes (0x13, 0x16, 0xA4, 0xA5), tensão (0x94), fuso informado no login e os comandos do
modelo, usados sempre que o rastreador está cadastrado com o modelo "J16 4G":

| Ação no painel | Texto enviado ao J16 |
|---|---|
| Bloquear / Desbloquear | `RELAY,1#` / `RELAY,0#` |
| Consultar estado | `STATUS#` (bateria, GPRS, sinal, GPS, ACC, relé) |
| Consultar configuração | `PARAM#` |
| Pedir posição / Reiniciar | `WHERE#` / `RESET#` |
| Personalizado | qualquer texto do manual (ex.: `SZCS#SOURCE_OFF_TYPE=0`, `VERSION#`) |

**Passo a passo**
1. Master → **Rastreadores → Novo rastreador**: IMEI da etiqueta (o sistema confere o dígito verificador), modelo **J16 4G**, empresa.
2. Empresa → **Veículos → Novo veículo**: placa e o rastreador.
3. SMS para o número do chip do J16, um por vez (resposta "SET OK"):
   ```
   SZCS#IMEI=866557088453933#TERIID=866557088453933#
   APN,indica.br,indica,indica#            (chip Vivo da Indica; Algar: APN,indica.algar.br,algar,1212#)
   SERVER,1,SEU-DOMINIO,5023,0#            (com IP: SERVER,0,IP-DO-SERVIDOR,5023,0#)
   TIMER,30,3600#
   GMT,W,0,0#
   SZCS#GPS_DISSLP=1
   SZCS#SLPDISCONNECT=0
   STATUS#
   ```
   Atenção: depois do `SERVER`, o J16 passa a enviar para este sistema e deixa de aparecer na plataforma da Indica (`smartconn.mine.nu:4998`).
4. **Instalação**: positivo e negativo na bateria (12/24 V; o J16 não tem bateria interna), fio da **ignição no pós-chave** (sem ele o
   rastreador fica em espera) e o **relé no fio da bomba de combustível** para o bloqueio. Tampa bem fechada, LED para cima, longe de metal.
   Chip **M2M** com plano de dados.
5. Sem o aparelho em mãos, dá para testar com o simulador, que se conecta como o J16 e responde aos comandos:
   `npm run simular -- 866557088453933 SEU-SERVIDOR 5023`.

## Mapas do Google (opcional)

Com a chave do Google no `.env` (`RASTREADOR_GOOGLE_MAPS_CHAVE`), o botão **Satélite / Mapa** passa a mostrar o satélite (com os nomes por
cima) e as ruas do próprio Google, em alta resolução, com o logo e os créditos que o Google exige. O endereço dos veículos e a busca passam a
usar a **Geocoding API** do Google (mais exata, inclusive no número). Sem a chave, ou se o Google falhar, ficam os serviços gratuitos.

1. No [Google Cloud Console](https://console.cloud.google.com/): crie um projeto e ative o **faturamento** (o Google tem cota mensal gratuita
   e cobra pelas imagens acima dela; confira a tabela de preços da Map Tiles API).
2. Em **APIs e serviços → Biblioteca**, ative a **Map Tiles API** e a **Geocoding API**.
3. Em **APIs e serviços → Credenciais → Criar credenciais → Chave de API**. Em "Restrições de API", deixe só a **Map Tiles API** e a **Geocoding API**.
   Crie também um **alerta de orçamento** em Faturamento.
4. No servidor, acrescente ao `.env` a linha `RASTREADOR_GOOGLE_MAPS_CHAVE=SUA_CHAVE` e rode `pm2 restart rastreador`.

### Só para ver como fica: chave de demonstração do Google (sem faturamento)

A "chave de demonstração do Maps" do Google não libera a Map Tiles API nem a Geocoding API; ela serve para o Google Maps no
navegador (Maps JavaScript API). Coloque-a no `.env` como `RASTREADOR_GOOGLE_MAPS_JS_CHAVE=SUA_CHAVE` (e não na
`RASTREADOR_GOOGLE_MAPS_CHAVE`) e rode `pm2 restart rastreador`: o Mapa e o Satélite passam a ser os do Google. O endereço continua
pelo serviço gratuito. A chave fica visível no navegador; no Google Cloud, restrinja-a a "Sites" com o endereço do painel. A chave de
demonstração tem limite de uso: se o Google recusar, o mapa volta sozinho ao gratuito até a aba ser fechada.

## Como os veículos chegam ao sistema

| Origem | Como liga | Comandos |
|---|---|---|
| **Rastreador GT06** e compatíveis (GT06N, J16, ST-901, Concox…) | TCP direto na porta `RASTREADOR_GT06_PORTA` (padrão 5023). Login pelo IMEI, posições (0x12/0x22), estado (0x13: ignição, corte, alarme) e alarmes (0x16/0x26: pânico, corte de energia, violação). | Bloquear, desbloquear, pedir posição, reiniciar ou texto livre, entregues na hora se o equipamento estiver conectado (senão, quando conectar). A resposta do equipamento confirma. |
| **Celular** com o app **Traccar Client** (Android/iPhone) e rastreadores com protocolo **OsmAnd** | HTTP em `/rastreador/api/osmand` (parâmetros `id, lat, lon, timestamp, speed, bearing…` ou o JSON do Traccar Client novo). | Não recebe. |
| **Outro sistema** (gateway de outro protocolo, Traccar, outra plataforma) | API de integração com a chave da empresa: `POST /api/integracao/posicoes`. | O sistema busca em `GET /api/integracao/comandos` e responde em `POST /api/integracao/comandos/:id`. |

Equipamento que envia sem estar cadastrado aparece em **Rastreadores → Equipamentos não cadastrados**, com o botão para cadastrar.

## Telas

### Empresa
- **Dashboard**: faixa **Segurança agora** (em Modo Roubo, estacionados, bloqueados, bloqueio programado e liberações), veículos em
  movimento, parados ligados, sem sinal, km rodados hoje, alertas pendentes, **custo do mês** e **nota média** dos motoristas, gráfico da frota
  agora, km por dia (14 dias), últimos alertas, mais rodados na semana, alertas por tipo, manutenções vencidas/próximas e CNH vencendo em 30 dias.
- **Mapa ao vivo**: lista com busca e filtro por situação ao lado do mapa (atualiza a cada 10 s); veículo girado pelo curso e colorido pela
  situação; painel do veículo com velocidade, ignição, comunicação, motorista e hodômetro e as ações, com a segurança primeiro: **Modo Roubo,
  Estacionar/Desarmar, Bloquear/Desbloquear** (pela velocidade segura), **Pedir posição, Equipamento, Histórico e Compartilhar**. As cercas
  aparecem no mapa. Os atalhos também ficam em cada linha de **Veículos** e, para o master, na faixa do veículo no **Mapa geral**.
- **Histórico**: trajeto de até 7 dias com início, fim, paradas numeradas e alertas no mapa; viagens (clique destaca o trecho) e paradas;
  **reprodução** do trajeto com velocidade de 1× a 64×.
- **Alertas**: pendentes, tratados ou todos, por tipo, veículo e período; tratar um ou todos (com observação); CSV. Os alertas que podem ser
  roubo (sumiço suspeito, estacionado violado, pânico, bateria desconectada, violação, vibração, saída de cerca...) têm o botão **Modo Roubo**.
- **Segurança**, em seções:
  - **Roubo**: o Modo Roubo com **bloqueio inteligente** (o corte só sai abaixo da velocidade segura, 20 km/h, ou com a ignição desligada) e o
    rastreador mandando posição a cada 10 s; linha do tempo ao vivo; **kit de ocorrência** (link ao vivo para a polícia, relatório em PDF e o
    PDF pelo WhatsApp); forçar o corte (com a placa) e encerrar (com ou sem desbloqueio).
  - **Estacionados**: o veículo fica vigiado (ignição ligada ou saída do raio viram alerta "estacionado violado" no painel e no WhatsApp);
    opcional por veículo, armar sozinho à noite ao desligar.
  - **Bloqueio programado**: horário de bloqueio por veículo (ex.: 23h às 6h, segunda a sexta), com o corte pela velocidade segura e o
    desbloqueio sozinho no fim; link do app do motorista.
  - **Liberações**: o gestor digita o código de 6 números que o motorista gerou no app, confere quem pediu e libera por 1 a 12 h; no fim,
    o bloqueio volta sozinho (aviso no WhatsApp 15 min antes).
- **Frota**, em seções:
  - **Veículos**: placa (antiga ou Mercosul), tipo, marca/modelo, limite de velocidade, consumo médio (km/l), estacionar automático à noite,
    rastreador e motorista; ajuste do hodômetro; links de localização ativos; exclusão (com todo o histórico) ou desativação.
    **Cadastrar celular como rastreador** gera o identificador para o app.
  - **Motoristas**: CPF, telefone (com link do WhatsApp), CNH com validade e o **acesso ao app do motorista** (senha de 4 a 6 números).
  - **Nota e ranking**: nota de 0 a 100 por motorista e por veículo (excesso de velocidade, uso fora do horário, motor ligado parado e
    variações bruscas), com o detalhe de cada desconto e PDF.
  - **Custos**: combustível (km ÷ consumo × preço) e motor ligado parado, em reais, por veículo e no total, com o custo por km.
  - **Manutenção** e **Equipamentos**: sinal 4G, bateria e comunicação de cada rastreador; a **ficha do J16** com consultas (estado,
    configuração, link do mapa, reiniciar) e, para a equipe da plataforma, os ajustes (intervalos, curvas, alarmes, anti-jammer, números
    de emergência, ignição virtual, LEDs, sono, fuso, sentido do relé, servidor, APN e padrão de fábrica).
- **Cercas**: círculo (centro e raio) ou polígono desenhados no mapa; alerta de entrada e/ou saída; vigência por horário; ação ao sair
  (só avisar ou **acionar o Modo Roubo**); modelos prontos (casa, garagem, cliente, área proibida); para todos os veículos ou só os escolhidos.
- **Manutenção**: planos por km (pelo hodômetro do rastreador) e/ou por dias, com situação em dia/próxima/vencida; registro do que foi feito
  (data, km, custo) e histórico.
- **Relatórios**: resumo por veículo no período (distância, motor ligado, velocidade máxima, dias com uso, excessos, alertas), viagens de um
  veículo (até 31 dias), CSV e impressão. **Programados**: PDF pelo WhatsApp, diário, semanal, quinzenal ou mensal, com o histórico de envios.
- **Comandos**: o que foi enviado, a situação (aguardando envio, enviado, confirmado, falhou, expirado, cancelado) e a resposta do equipamento.
- **Configurações**: alerta de ignição, horário e dias de uso permitidos, tempo para o alerta de sem comunicação, preço do combustível e litros
  por hora parado, contato, plano contratado e usuários da empresa (administrador e operador). **Notificações**: os contatos do WhatsApp,
  quais avisos cada um recebe e o horário de silêncio (os de segurança chegam sempre).
- **Assistente**: botão fixo no canto de todas as telas. Responde perguntas sobre a frota ("onde estava o RTS1A23 ontem às 15h?", "quem
  dirigiu pior este mês?", "quanto gastei de combustível?") com os dados da própria empresa. Só consulta: não bloqueia nem muda nada.

### App do motorista (`/motorista/`)
Para o celular (pode ser instalado na tela inicial). O motorista entra com o CPF e a senha numérica (cadastrada em Frota → Motoristas) e:
- **Assume o veículo pelo QR code**: cada veículo tem um QR (Frota → Veículos, botão do QR, para imprimir e colar). A câmera do celular abre o
  link e o veículo passa para o motorista; a nota e o custo contam para quem estava com o veículo em cada trecho. "Devolver" encerra.
- **SOS**: segurar o botão por 2 segundos manda o alerta de pânico com a localização do celular (painel e WhatsApp), com o atalho para ligar 190.
- **Pedir liberação** do bloqueio programado: código de 6 números (vale 10 min) que o gestor aplica em Segurança → Liberações.
- **Checklist de saída** (8 itens, com observação e fotos): aparece em Frota → Checklists; item com problema avisa a empresa pelo WhatsApp.
- **Abastecimento** (litros, valor, km, posto e foto do cupom): aparece em Frota → Custos e passa a dar o **consumo real** do veículo.
- **Reportar avaria** (gravidade e fotos): vira um chamado em Frota → Manutenção (aberta, em andamento, resolvida) e avisa pelo WhatsApp.
- **Minha nota**: a nota da semana ou do mês, as dicas do que mais pesou e onde perdeu pontos; a posição no ranking aparece se a empresa
  ligar em Configurações → Geral.
- **Avisos no celular**: liberação aplicada, bloqueio começando em 15 minutos, liberação acabando e liberação encerrada. No iPhone, só com
  o app adicionado à Tela de Início.

As fotos chegam reduzidas pelo próprio celular (cerca de 200 KB) e ficam em `data/fotos` (ou `RASTREADOR_FOTOS`).
- **Integrações**: chaves de API e o guia de como ligar GT06, celular e outros sistemas.

### Master
- **Dashboard**: **Modo Roubo em andamento em todas as empresas**, empresas, veículos online, rastreadores (instalados e em estoque), mensagens
  recebidas hoje e por dia, conexões GT06, faturamento mensal (veículos ativos × mensalidade) e equipamentos não cadastrados.
- **Mapa geral**: todos os veículos de todas as empresas.
- **Empresas**: cadastro com o plano da empresa (limite de veículos e mensalidade por veículo, sem valor padrão), editar, bloquear (os usuários não entram e as posições deixam de ser gravadas),
  excluir (os rastreadores voltam ao estoque). Clicar abre o painel da empresa.
- **Financeiro** (só o master): valor mensal de cada cliente (mensalidade por veículo × veículos ativos), uso do plano, participação
  no faturamento, ticket médio, valor das empresas bloqueadas (fora do total), edição rápida do plano e planilha CSV.
- **Rastreadores**: estoque e instalados (IMEI, modelo, protocolo, chip e operadora, empresa, veículo, última comunicação, conectado agora),
  com a ficha do equipamento.
- **Permissões e usuários**.
- **Configurações** em seções: **Parâmetros** (nome da plataforma, tempos, retenção, alerta padrão de sem comunicação e os de segurança:
  velocidade segura, raio do estacionado, tempo do sumiço, validade do código e aviso antes de acabar a liberação), **Comandos GT06**
  (os textos do seu fabricante), **WhatsApp** (conexão com a Evolution, mensagem de teste, contatos da central e a fila de envio),
  **Assistente IA** (limite de perguntas por dia por empresa e o uso do mês), **Integrações**, **Diagnóstico** (servidor GT06, recepção,
  veículos mudos, comandos parados, empresas no limite) e **Atividades**.

## Alertas

| Alerta | Quando |
|---|---|
| Excesso de velocidade | Passou do limite do veículo (avisa de novo só depois de voltar abaixo dele). |
| Entrada / saída da cerca | Mudou de dentro para fora (ou o contrário) de uma cerca ativa. A primeira posição só registra onde o veículo está. |
| Ignição ligada / desligada | Se ligado em Configurações da empresa. |
| Uso fora do horário | Ligou (ou andou, sem sinal de ignição) fora do horário e dos dias permitidos; uma vez por vez que liga. |
| Pânico, bateria desconectada, bateria baixa, violação | Enviados pelo próprio rastreador (o mesmo alarme repetido em 2 min não duplica). |
| Sem comunicação | O veículo não comunicou no tempo configurado na empresa (uma vez até voltar a comunicar). |
| Sumiço suspeito | Estava andando ou ligado e ficou mais de 5 min (ajustável) sem comunicar: sinal típico de bloqueador ou equipamento arrancado. |
| Voltou a comunicar | Depois de um sumiço suspeito, com o tempo sumido. |
| Estacionado violado | Veículo estacionado ligou a ignição ou saiu do raio. |
| Vibração / deslocamento | Alarmes do próprio J16 (quando ligados na ficha do equipamento). |

Os alertas vão pelo WhatsApp para os contatos que pediram cada tipo (Configurações → Notificações), com uma fila que tenta de novo se a
Evolution falhar.

## Cálculos

- **Hodômetro** e **km por dia**: soma das distâncias entre posições (com o veículo andando ou num deslocamento de mais de 50 m: a oscilação
  do GPS parado não conta). **Horímetro**: tempo entre posições com a ignição ligada (no máximo 10 min por intervalo).
- **Saltos do GPS**: posição que exigiria mais de 250 km/h (ajustável) desde a anterior é descartada.
- **Viagens**: começam quando o veículo anda (5 km/h ou mais) e terminam com a ignição desligada ou parado por 5 min (ajustável);
  viagens de menos de 100 m são ignoradas.
- **Situação no mapa**: sem sinal quando não comunica há mais de 10 min (ajustável); em movimento a partir de 3 km/h; parado ligado ou parado.
- Posições antigas reenviadas pela memória do equipamento entram no histórico, mas não mudam a posição atual nem geram alertas.
- **Limpeza automática** (uma vez por dia): posições, alertas tratados e uso diário mais antigos que a retenção (Master → Parâmetros);
  mensagens do WhatsApp já enviadas ou que falharam depois de 90 dias (o PDF anexo sai em 1 dia); auditoria e envios de relatórios
  depois de 1 ano; equipamentos desconhecidos sem contato há 90 dias. Checklists, abastecimentos, avarias e fotos ficam guardados.

## Link de localização compartilhada

Pelo mapa ao vivo, **Compartilhar** gera um link (1 hora a 7 dias) com a posição do veículo atualizando sozinha, sem login e sem histórico,
para mandar a um cliente ou à família (com o botão do WhatsApp). Só o hash do código fica guardado; o link pode ser cancelado em Veículos.

## API de integração

Chave da empresa (Integrações → Nova chave) no cabeçalho `X-Api-Key`. Base: `https://SEU-DOMINIO/rastreador/api/integracao`.

| Método e caminho | Para quê |
|---|---|
| `GET /veiculos` | Frota com a última posição, situação, ignição, bloqueio, hodômetro e motorista. |
| `GET /veiculos/:placa/posicoes?de=&ate=` | Posições (ISO 8601, até 7 dias, até 20.000). |
| `GET /alertas?desde=` | Alertas desde a data (padrão: últimas 24 h). |
| `POST /posicoes` | Uma ou uma lista (até 500) de `{ imei, lat, lng, velocidade_kmh?, curso?, ignicao?, tensao?, evento?, gps_em? }`. Só rastreadores da empresa. |
| `GET /comandos` | Comandos pendentes dos rastreadores do tipo "API" (passam a "enviado"). |
| `POST /comandos/:id` | Resultado: `{ sucesso, resposta? }`. Bloqueio confirmado marca o veículo como bloqueado. |

## Rodar

```bash
cd rastreador
npm install
npm run seed     # opcional: 3 empresas de exemplo com 3 dias de trajetos
npm start        # http://localhost:3400/  (ou RASTREADOR_BASE_PATH=/rastreador → http://localhost:3400/rastreador/) e GT06 na porta 5023
npm test
```

Master inicial: `master@rastreador.com.br` / `master123` (troque com `RASTREADOR_ADMIN_EMAIL` e `RASTREADOR_ADMIN_SENHA`; em produção a senha é obrigatória).
Contas de exemplo do `seed` (senha `demo12345`): `cliente@transportes.demo`, `cliente@entregas.demo`, `cliente@pessoal.demo` e `operador@transportes.demo`.

Configuração: veja [`.env.exemplo`](.env.exemplo). Instalação em servidor (PM2, Docker, cPanel, Nginx/Apache, porta GT06):
`npm run empacotar` gera `dist/rastreador.zip` com o [LEIA-ME](scripts/LEIA-ME.txt).

### Segurança

- O identificador do OsmAnd (celular) funciona como senha: quem souber pode enviar posições por ele. O sistema gera identificadores
  aleatórios (`app-` + 10 dígitos) para os celulares; não use o IMEI de um GT06 num celular.
- O protocolo GT06 não tem autenticação: só o IMEI cadastrado é aceito, e cada IMEI tem uma conexão por vez.
- Bloquear exige digitar a placa. Todo corte passa pelo **bloqueio inteligente**: andando acima da velocidade segura (20 km/h), o corte
  espera e sai sozinho quando o veículo diminui ou desliga. Forçar o corte em movimento só pelo Modo Roubo, com a placa e um aviso de risco.
- As chaves (Evolution, Anthropic, Google) ficam só no `.env` do servidor. O assistente só lê os dados da empresa de quem pergunta, tem limite
  diário e não envia comandos. A senha do app do motorista é guardada com hash e nunca sai do servidor.
