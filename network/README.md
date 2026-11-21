# Manager Provedor

ERP para provedores de internet: **assinantes, contratos, faturamento e cobrança** ao lado de **rede óptica, Central NOC,
chamados técnicos, equipe e comissões, frota, manutenção, abastecimentos e rastreamento**. Publicado em `/network`, com
servidor, banco (SQLite com migrações), usuários e login próprios, e identidade própria: grafite e verde-esmeralda, com
alertas em laranja e vermelho.

O assinante, o contrato e a planta óptica vivem no mesmo banco: o contrato ocupa a porta na CTO, o corte por inadimplência
aparece no histórico do contrato e o chamado técnico cai na mesma caixa que o cliente usa. Uma instalação por provedor.

Ele se conecta ao **Rastreador de Veículos** deste repositório ([`rastreador/`](../rastreador/README.md)) pela API de
integração dele, recebe as medições da rede por um **coletor** autenticado e tem um adaptador configurável para o
**Downdetector**, que fica *não conectado* enquanto não houver acesso autorizado.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Visão geral** | Disponibilidade medida, chamados abertos e críticos, técnicos em campo e frota disponível, cada um com período, fonte e horário. Mapa geográfico real (camadas Rede e Frota, com lista acessível por teclado), alertas prioritários (incidentes, preventivas vencidas, veículos bloqueados, documentos), chamados em andamento e agenda da frota. |
| 2 | **Central NOC** | Saúde da rede, incidentes (confirmação por N amostras, histerese, recorrência, correlação por topologia, impacto em clientes únicos), serviços externos, histórico com início/reconhecimento/fim/duração, regras versionadas e **modo TV** (`#/tv`, legível à distância, sem dados de clientes, consulta a cada 30 s). |
| 3 | **Rede óptica** | POPs, CEOs e CTOs com coordenadas validadas; portas com reserva (validade e responsável), ocupação, defeito e histórico; ligações com percurso até o POP (trecho desconhecido explícito); fusões por bandeja sem extremidade repetida; cabos; equipamentos ativos (OLT/PON). Situação de CTO/CEO sempre com a origem: inspeção manual ou inferência pelo equipamento ativo. |
| 4 | **Chamados técnicos** | Kanban e lista; aberto → atribuído → em rota → em execução → concluído (em validação) → aprovado/retornado, com cancelar, reagendar e reabrir auditados. Atribuição recusa veículo indisponível (com o motivo) e sinaliza conflito de agenda. Checklist versionado por tipo (potência antes/depois, foto, porta…), evidências por câmera, interface do técnico no celular. |
| 5 | **Equipe e comissões** | Técnicos, produtividade por período (concluídos, aprovados, tempo médio, prazo, retrabalho), regras versionadas (valor fixo ou valor × quantidade do checklist), conferência (ninguém aprova a própria), rateio da equipe, ajustes/estornos e **registro administrativo** de pagamento com comprovante. |
| 6 | **Assinantes** | Pessoa física e jurídica com CPF/CNPJ conferido pelo dígito e único na operação, endereço georreferenciado, contatos, consentimento de contato comercial (LGPD) e posição financeira. Situação comercial (prospecto → cliente → inativo) mantida pelo próprio sistema; o estado do serviço é do contrato, nunca copiado. Abrir um assinante abre a **ficha**: uma tela só. |
| 6.1 | **Ficha do assinante** | Tudo do cliente numa resposta e numa tela: alertas do que precisa ser dito primeiro, indicadores, contratos com itens e serviço no equipamento, faturas com itens e baixas, bloqueios e confianças, o que a régua já fez, chamados e uma **linha do tempo unificada** (contrato, faturamento, cobrança e atendimento, cada fato uma vez só). Trocar de aba não vai ao servidor, e nenhuma ação — baixa, estorno, corte, religação, confiança, sincronizar, novo contrato, cobrança avulsa — leva para outra tela. As abas que o perfil não pode ver não aparecem. |
| 7 | **Contratos** | O serviço de um assinante num endereço: plano, mensalidade contratada (independente da tabela de preços de hoje), dia de vencimento, fidelidade, ponto na planta (CTO e porta, ocupada de verdade na ativação) e itens fixos por competência (SVA, aluguel de equipamento, ponto adicional, desconto). Ciclo em implantação → ativo → bloqueado/suspenso → cancelado, cada passo com quem fez, de onde veio e por quê. |
| 8 | **Faturamento** | Ciclo mensal **simulável quantas vezes quiser** antes de emitir, com o que será cobrado de cada contrato e o motivo de cada contrato fora do ciclo; **pró-rata** de entrada e de saída (e adiada quando o vencimento do mês de entrada já passou); instalação cobrada uma vez; competência que não roda duas vezes; multa e juros calculados no dia do pagamento, sem alterar o valor da fatura; baixa total ou parcial, estorno com motivo, cancelamento e cobrança avulsa. |
| 9 | **Cobrança e bloqueios** | Régua versionada por dias em relação ao vencimento (avisar, bloquear, indicar para cancelamento), carência que prevalece sobre qualquer regra, execução idempotente (a mesma regra nunca roda duas vezes na mesma fatura), bloqueio que guarda a regra e a fatura que o originou, **desbloqueio de confiança** com prazo e limite anual, desbloqueio automático na quitação e inadimplência por faixa de atraso. |
| 9.1 | **Cobrança bancária** | Como o assinante paga. **PIX** com BR Code gerado aqui (EMV BR Code com CRC16, sem API nenhuma: basta a chave) e **boleto** com código de barras e linha digitável montados no sistema (módulo 10 e 11, fator de vencimento com a virada de 2025). Registro e baixa por arquivo: **remessa CNAB 240** e leitura de **retorno 240 e 400**, com o mapa de posições à vista. O retorno nunca é aplicado direto — vira prévia (o que casou, por qual chave, com que divergência), e só então o operador manda aplicar. Uma conta cujo campo livre nunca foi conferido com o banco avisa isso em toda emissão. |
| 10 | **Planos** | Tabela comercial (internet, voz, SVA, combo) com tecnologia, velocidade, mensalidade, taxa de instalação e fidelidade. Alterar o plano não altera o que já foi contratado. |
| 11 | **Veículos** | Placa normalizada e única por organização, responsáveis com início e fim, restrições (oficina, documento, sinistro…) que tiram o veículo da escala até a liberação, documentos com vencimento, histórico de manutenção, abastecimentos e chamados. |
| 12 | **Manutenção e lavagem** | Planos preventivos por item, por dias e/ou km (alerta no primeiro limite, antecedência e tolerância); ordens solicitado → orçado → aprovado (alçada por valor) → agendado → em execução → concluído; lavagem sem zerar a mecânica; fornecedores; custos orçado e realizado separados. |
| 13 | **Abastecimentos** | Comprovante, volume, preço, odômetro e tanque cheio; total = litros × preço; preço médio ponderado; consumo por ciclo entre tanques cheios (com os parciais); lançamento retroativo validado; volume acima do tanque sinalizado; correção autorizada com valor original guardado; relatórios por veículo, técnico e posto; CSV protegido. |
| 14 | **Rastreamento** | Posições do rastreador com horário da medição e idade; parado ≠ sem comunicação; ignição ausente = desconhecida; trajeto do período; vínculo dispositivo ↔ veículo pelo IMEI (a placa só sugere); chamados próximos por distância em linha reta (não é ETA). |
| 15 | **Provisionamento** | A ponte entre o contratado e o equipamento, por uma **camada de drivers**: o sistema fala em estado desejado (login, velocidade, IP, corte) e cada fabricante é um driver plugável, que declara o que sabe fazer. Fila de tarefas com ensaio (dry-run), tentativa com recuo, erro legível e histórico; releitura periódica que acha o que foi mexido por fora; e a tela de divergências, que mostra serviço liberado com contrato bloqueado (receita escapando) e contrato ativo com serviço cortado. |
| 16 | **Wi-Fi do assinante (TR-069)** | ACS próprio: o roteador do assinante liga para o sistema, se registra sozinho e passa a ser gerenciável. Trocar SSID, senha e canal e reiniciar o aparelho saem da ficha do cliente, nos dois dialetos de parâmetro (TR-098 e TR-181). Para não esperar o contato periódico, o sistema bate na porta do CPE (Connection Request com Digest) pedindo que ligue agora — e grava nele, no primeiro encontro, a credencial que torna isso possível. |
| 17 | **Consulta de CNPJ e CEP** | Cadastro preenchido pela base pública da Receita e pelos Correios, com a fonte e o horário à vista, o que veio marcado até alguém conferir, e queda para a fonte seguinte. Fonte fora do ar não trava o cadastro. |
| 18 | **Integrações** | Rastreador, coletores de monitoramento e Downdetector: configuração, teste de conexão, estado (não configurada, conectada, parcial, desatualizada, sem permissão, limite atingido, falha), último sucesso, erro com ID e histórico de coletas. |

Mais: **Organização e acessos** (usuários, perfis, matriz de permissões, parâmetros da operação e auditoria com request ID).

## Perfis

| Perfil | Acesso |
|---|---|
| **Administrador** | Tudo da própria organização, inclusive usuários, integrações, parâmetros e auditoria. |
| **Gestor operacional** | Distribui e valida chamados, rede, NOC, frota (consulta e escala) e produtividade. Consulta assinantes, contratos, faturas e inadimplência, sem alterar. |
| **NOC** | Rede, incidentes, regras de monitoramento, topologia e chamados relacionados. |
| **Gestor de frota** | Veículos, restrições, documentos, manutenção, lavagem, fornecedores, combustível e vínculos do rastreador. |
| **Técnico** | Só os próprios chamados (execução, checklist, evidências), as próprias comissões e os abastecimentos do veículo sob sua responsabilidade. Não vê a posição das equipes **nem a base de assinantes**: do atendimento dele vêm só os dados daquele chamado. |
| **Conferência de comissões** | Regras, aprovação, ajustes e registro de pagamento (nunca da própria comissão). |
| **Financeiro** | Assinantes, planos, contratos (inclusive ativar, suspender e cancelar), faturamento, baixas, régua de cobrança, bloqueio e desbloqueio. Não estorna baixa nem cancela fatura: isso é do administrador. |
| **Consulta / TV** | Indicadores e painel TV, sem escrita. |

As regras ficam no servidor (`server/lib/permissoes.js` e as rotas): esconder um botão não substitui a permissão. Todo dado
tem `organizacao_id` e cada consulta filtra pela organização do usuário.

## Rodar

Requisitos: **Node.js 22.13+**.

```bash
cd network
npm install
npm start          # http://localhost:3500/  (com NETWORK_BASE_PATH=/network → http://localhost:3500/network/)
npm test           # 183 testes de aceite (inclui o rastreador real, se rastreador/node_modules existir)
```

Acesso inicial: `admin@managerprovedor.local` / `admin12345` (defina `NETWORK_ADMIN_EMAIL` e `NETWORK_ADMIN_SENHA`; em produção a senha é obrigatória).
O primeiro start cria a organização (`NETWORK_ORGANIZACAO`) **vazia**: os cadastros reais começam do zero.

### Ambiente demonstrativo (opcional)

```bash
npm run demo       # cria a organização "Provedor Demonstração", separada e marcada como demonstração
```

Dados fictícios (pessoas, placas, endereços, medições, valores de comissão, carteira de assinantes com três meses faturados, faturas pagas e vencidas, cortes feitos pela régua e um desbloqueio de confiança), criados pela própria API. A interface mostra o
selo **Ambiente demonstrativo** só nessa organização. Acessos com a senha `demo12345`: `demo@`, `gestor.demo@`, `noc.demo@`,
`frota.demo@`, `lucas.demo@` (técnico), `comissoes.demo@`, `financeiro.demo@` e `tv.demo@managerprovedor.local`. O script recusa rodar com
`NODE_ENV=production`; use um banco separado. Rastreador e Downdetector ficam não configurados.

## Configuração

Veja [`.env.exemplo`](.env.exemplo).

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3500` | Porta HTTP. |
| `NETWORK_BASE_PATH` | (raiz) | Endereço de publicação, ex.: `/network`. |
| `NETWORK_SECRET` | aleatório | Segredo das sessões (mín. 32). **Obrigatório em produção.** |
| `NETWORK_CHAVE_CREDENCIAIS` | derivada do segredo | 64 hex (32 bytes) para cifrar as credenciais das integrações (AES-256-GCM). **Obrigatória em produção.** |
| `NETWORK_ADMIN_EMAIL` / `_SENHA` / `_NOME`, `NETWORK_ORGANIZACAO` | — | Primeiro administrador e organização. Senha obrigatória em produção (mín. 12). |
| `NETWORK_FUSO` | `America/Sao_Paulo` | Fuso padrão. Datas ficam em UTC no banco e aparecem no fuso da organização. |
| `NETWORK_DADOS` / `NETWORK_DB` / `NETWORK_ARQUIVOS` | `data/`… | Banco SQLite e arquivos privados (fora da pasta pública, nome aleatório, SHA-256 conferido). **Faça backup das duas.** |
| `NETWORK_ARQUIVO_MAX_MB` | `10` | Limite por arquivo (JPG, PNG, WEBP, PDF, reconhecidos pelo conteúdo). |
| `NETWORK_CONECTOR_REDE_INTERNA` | desligado | `1` permite conectores em endereços internos (ex.: rastreador no mesmo servidor). Desligado, bloqueia destinos privados (SSRF). |
| `NETWORK_CONECTOR_TIMEOUT_MS` | `10000` | Tempo máximo de cada consulta a uma fonte. |
| `NETWORK_COLETAS` | ligado | `0` desliga as coletas periódicas. |
| `NETWORK_MAPA_TILES` / `_ATRIBUICAO` / `_LAT` / `_LNG` | Esri World Street Map | Camada de imagens do mapa (Leaflet). Para uso comercial e volume alto, use um provedor licenciado. |
| `NETWORK_TRUST_PROXY` / `NETWORK_LIMITE_LOGIN` | `loopback` / `10` | Proxy reverso e tentativas de login por minuto. |

### ACS (TR-069) e o Wi-Fi do assinante

Configurado em **Provisionamento → Aparelhos (TR-069)**. O endereço do ACS é `<endereço público>/api/acs`, e é
ele que vai nos CPEs junto com o usuário e a senha definidos ali.

A conversa é sempre do aparelho para o sistema: ele liga no boot, de tempos em tempos e quando algo muda. No
primeiro encontro o sistema grava nele a **credencial de chamada** — é ela que depois permite pedir "ligue
agora" e aplicar uma mudança de Wi-Fi em segundos, em vez de esperar o contato periódico. Se a gravação falhar,
a credencial guardada é descartada e tudo é tentado de novo no contato seguinte.

| Variável | Padrão | Descrição |
|---|---|---|
| `NETWORK_ACS_CHAMADO_TIMEOUT_MS` | `6000` | Tempo máximo para o aparelho atender à chamada. Curto de propósito: não atender é comum e esperado. |

A senha do ACS fica guardada em milhares de aparelhos: trocá-la derruba a conversa de todos os já
provisionados até que sejam atualizados, e o sistema avisa isso antes de salvar.

### Parâmetros do provisionamento

Também em **Organização e acessos**, e lidos pela fila a cada execução:

| Parâmetro | Padrão | O que faz |
|---|---|---|
| Provisionamento automático | ligado | A fila executa sozinha as tarefas pedidas ao equipamento. Desligado, elas ficam aguardando o processamento manual. |
| Corte automático | ligado | O bloqueio comercial da régua vira corte no equipamento. Desligado, o bloqueio continua existindo, só não chega à rede. |
| Reconciliação | `12` horas | De quanto em quanto tempo os serviços são relidos para achar o que foi mexido por fora do sistema. Zero desliga. |

O acesso de gerência de cada equipamento (driver, IP, usuário, senha) fica em **Provisionamento → Equipamentos**.
A senha é cifrada com a mesma chave das integrações e nunca aparece em tela, log ou auditoria. A conferência do
certificado TLS é por equipamento e vem desligada, porque certificado autoassinado é o normal em OLT e concentrador.

### Parâmetros de faturamento e cobrança

Ficam na organização (não em variável de ambiente) e são editados em **Organização e acessos → Faturamento e cobrança**.
O ciclo e a régua leem estes valores a cada execução:

| Parâmetro | Padrão | O que faz |
|---|---|---|
| Dia de vencimento padrão | `10` | Sugerido ao criar contrato (1 a 28, para existir em todo mês). Cada contrato pode ter o seu. |
| Carência antes do bloqueio | `5` dias | **Nenhuma regra da régua corta antes disso**, mesmo configurada para menos. O contrato pode ter carência própria. |
| Multa por atraso | `2,00%` | Uma única vez sobre o saldo, calculada no dia do pagamento. |
| Juros | `1,00%` ao mês | Proporcional aos dias de atraso (pro rata die). |
| Primeira fatura proporcional | ligada | O mês de entrada (e o de saída) é cobrado pelos dias de serviço. Desligada, o mês é cobrado inteiro. |
| Desbloqueio de confiança | `5` dias, `3` por ano | Prazo máximo e quantas vezes cada contrato pode usar no ano. Zero dias desliga o recurso. |

A rotina diária (expirar confianças vencidas e aplicar a régua) roda sozinha uma vez por dia, pela data no fuso da
organização, e fica registrada. Se o servidor passar um dia desligado, ela roda ao voltar e a régua pega o atraso
acumulado sem repetir o que já havia feito. `NETWORK_COLETAS=0` desliga também essa rotina.

Migrações: aplicadas automaticamente no start, em ordem e numa transação cada (`server/db.js`, tabela `schema_migracoes`).
`npm run migrar` aplica sem iniciar o servidor. Produção com Docker: `docker build -t manager-network network/` e volume em `/app/data`.

### Cobrança bancária: conta, remessa e retorno

A **conta de cobrança** (menu *Cobrança bancária → Contas*) guarda o beneficiário, a chave PIX e, para boleto,
o convênio e a carteira combinados com o banco. Só o perfil **administrador** mexe nela: é por onde o dinheiro entra.

O **PIX funciona de imediato** — a chave basta, e o BR Code é montado e conferido aqui mesmo.

O **boleto exige cuidado**. O código de barras tem 44 posições; 25 delas são o *campo livre*, que cada banco define
conforme a carteira contratada. O sistema traz a montagem de 8 bancos (001, 033, 077, 104, 237, 341, 748, 756),
mas **todas marcadas como não validadas**: nenhuma foi conferida contra um boleto real em produção. Campo livre
errado produz um boleto que o cliente paga e o provedor não recebe, e o erro só aparece depois do pagamento.
Por isso o fluxo correto é: emitir um boleto, pagar no caixa ou no aplicativo, confirmar a compensação com o
gerente e então marcar a conta como **layout conferido**. Enquanto isso não acontece, o aviso aparece em toda emissão.

A **remessa** (CNAB 240, layout FEBRABAN) leva os boletos emitidos que o banco ainda não recebeu. O arquivo fica
guardado: baixar de novo não muda a numeração.

O **retorno** (240 ou 400) entra em dois passos, de propósito:

1. **Enviar** — o arquivo é apenas lido. A prévia mostra cada registro ao lado da linha crua: o que o banco disse,
   com qual cobrança casou (por nosso número, por nosso número com dígito ou por número da fatura) e que divergência existe.
2. **Aplicar** — só então as baixas entram no financeiro, como pagamentos comuns de origem `retorno`, e a quitação
   religa o serviço igual a uma baixa feita à mão.

Posição de layout errada aparece como valor sem sentido na prévia, em vez de virar baixa errada no caixa.
Só ocorrência de **liquidação** vira baixa; entrada confirmada, rejeição e baixa pelo banco mudam a situação da
cobrança e não tocam na fatura.

### API de banco e PayAx

O registro de adaptadores (`server/bancos/`) define o contrato que um banco — ou a PayAx — precisa cumprir:
registrar título, consultar, baixar, extrato, cobrança PIX e consulta de PIX, com idempotência por (conta, cobrança)
e a regra de que nenhum adaptador mexe no financeiro por conta própria.

**O registro está vazio, e isso é proposital.** Cada instituição publica o próprio manual (endpoints, escopos OAuth,
certificado mTLS, ambiente de homologação) e esse manual só sai depois do credenciamento. Escrever um adaptador de
memória produziria chamadas que falham em produção e, pior, um sistema que *parece* conectado. Para ligar um banco
ou a PayAx, basta a especificação da API e as credenciais: nada no núcleo muda.

## Integrações

### Rastreador de Veículos (conectado de verdade)

Usa a API de integração do `rastreador/` (`rastreador/server/routes/integracao.js`):
`GET <base>/api/integracao/veiculos` e `GET <base>/api/integracao/veiculos/:placa/posicoes` com `X-Api-Key`.

1. No rastreador: **Configurações → Integrações → Nova chave** (gera `rst_…`).
2. No Network: **Integrações → Rastreador → Configurar**: endereço (ex.: `https://seu-dominio/rastreador`; no mesmo servidor,
   `http://127.0.0.1:3400/rastreador` com `NETWORK_CONECTOR_REDE_INTERNA=1`) e a chave. **Testar conexão**.
3. Em **Rastreamento → Dispositivos**, vincule cada IMEI ao veículo (a mesma placa aparece como sugestão).

A coleta roda no intervalo configurado (padrão 60 s), grava as posições deduplicadas por dispositivo e horário, só avança a
posição atual com uma medição mais nova, guarda campos ausentes como nulos e o hodômetro do dispositivo separado do odômetro do
veículo. Erros: 401/403 viram *sem permissão* (sem repetir), 429 respeita `Retry-After`, falhas transitórias usam backoff com jitter.

### Monitoramento da rede (coletor)

A plataforma de monitoramento existente, ou um agente dentro da rede, envia amostras para
`POST <base>/api/coletor/amostras` com `Authorization: Bearer mnc_…` (token em **Integrações → Novo token de coletor**):

```json
{ "amostras": [
  { "schema_version": 1, "source_event_id": "id-unico-na-fonte", "target_id": "olt-pg-01", "ponto": "1/1/4",
    "metric": "optical_rx_dbm", "value": -27.4, "unit": "dBm", "observed_at": "2026-11-05T17:26:00Z" }
] }
```

`target_id` é o **ID no monitoramento** do equipamento; a organização vem do token, nunca do corpo; `source_event_id` repetido
não duplica. Métricas sugeridas: `disponibilidade` (1/0), `latencia_ms`, `perda_pacotes_pct`, `optical_rx_dbm`,
`interface_status`, `utilizacao_pct`. As **regras** (Central NOC → Regras) definem limiar, limiar de recuperação (histerese),
confirmações e severidade; não há limiar universal. `scripts/coletor-exemplo.js` é um agente simples que testa TCP e envia
disponibilidade e latência:

```bash
NETWORK_URL=https://seu-dominio/network NETWORK_COLETOR_TOKEN=mnc_... ALVOS="olt-pg-01=10.0.0.2:22" npm run coletor
```

### Downdetector (não conectado sem acesso)

Não há credenciais nem a lista de recursos do contrato, e os endpoints **não foram presumidos**. Em **Integrações → Downdetector**
você informa, a partir da documentação do seu acesso (https://downdetectorapi.com/v2/docs/): endereço base, caminho da consulta
com `{servico}`, cabeçalho de autenticação, credencial e onde ler o volume de relatos e a referência. Sem isso, a tela mostra
*não configurada* e o link do site oficial: sem scraping, sem iframe. Classificação: *sem dados* (nunca "normal"),
*sem relatos relevantes* ou *indício externo*; relato externo não confirma causa.

## Regras que o sistema garante

- **CTO/CEO são passivas**: sem ping nem sensor; a situação é inspeção manual ou inferência com a evidência (equipamento, ponto, valor, instante, regra).
- **Impacto** conta clientes únicos pela referência da porta; sem referência, mostra "portas ocupadas".
- **Concluir uma OS não resolve o incidente**; a resolução manual exige evidência.
- **Comissão** só depois da aprovação do chamado e da aprovação por perfil autorizado; restrição única por chamado/técnico/regra;
  versão da regra e valor guardados; ajustes são novos registros; pagamento é **registro administrativo, sem transferência bancária**.
- **Preventiva** alerta no primeiro limite (data ou km); sem odômetro confiável, avalia só a data e avisa.
- **Veículo com restrição ativa** não recebe escala; concluir um serviço só libera a restrição daquele serviço.
- **Uma competência por contrato**: rodar o ciclo duas vezes não cobra o assinante duas vezes, e a simulação não grava nada nem consome número de fatura.
- **O valor da fatura não muda depois de emitida**: multa e juros são calculados no dia do pagamento e ficam registrados na baixa.
- **A carência prevalece sobre a régua**: uma regra que mande cortar antes dela só age quando ela terminar.
- **Quem corta é sempre uma regra identificada**: o bloqueio guarda a regra, a fatura e o dia, e aparece no histórico do contrato.
- **Cancelar contrato nunca é automático**: a régua, no máximo, indica o contrato e registra a indicação.
- **Bloqueio por inadimplência continua faturando** (o serviço está cortado, o contrato não); **suspensão a pedido** não fatura.
- **Nada de dinheiro é apagado**: estorno, cancelamento de fatura e item encerrado continuam no histórico, com motivo e autor.
- **Dinheiro em centavos**, volume em mL e preço por litro em milésimos: todos os cálculos com inteiros.
- **Concorrência**: reserva de porta, aprovação e mudanças de status com condição sobre o estado e versão otimista (`versao`); conflito devolve 409 legível.
- **Idempotência**: todo POST da interface leva `Idempotency-Key`; repetir devolve a mesma resposta.
- **O equipamento só é tocado pela fila**: a tela e a régua pedem, a fila executa com tentativa e histórico. Equipamento fora do ar não trava o atendimento nem perde o pedido.
- **Ensaio antes de aplicar**: o mesmo caminho da execução, descrevendo o que faria, sem escrever.
- **Corte não é exclusão**: o acesso é desabilitado e a sessão derrubada, para o assinante voltar igual ao religar. Apagar só no cancelamento.
- **O que o driver não sabe fazer, ele declara**: a ação é recusada com o motivo. Nenhuma tela diz "aplicado" sem ter aplicado.
- **No TR-069, quem liga é o aparelho**: o sistema guarda o pedido e bate na porta do CPE. Se ele não atender — roteador desligado, CGNAT sem porta aberta —, a tela diz que o pedido ficou guardado, em vez de dizer que aplicou.
- **"Entregue" não é "aplicado"**: só a confirmação do aparelho conclui o pedido de Wi-Fi; a recusa dele vira erro legível com o código do CWMP.
- **A consulta pública é sugestão, não cadastro**: a resposta diz a fonte e o horário, os campos preenchidos ficam marcados, e quem salva é a pessoa.
- **"Está tudo certo" só se diz do que foi lido**: com serviço nunca lido, a tela diz que não sabe.
- **Uma tela por assunto, não uma tela por tabela**: a ficha do assinante responde "ele pagou?", "está cortado?", "qual o login dele?" e "abriu chamado?" sem trocar de tela, porque é tudo a mesma conversa.
- **Segredos** só no servidor (cifrados), nunca em respostas ou na auditoria; anexos por link temporário assinado e permissão por recurso.

## Arquitetura

```
network/
  server/
    db.js              # migrações (organizações, frota, rede, chamados, comissões, rastreamento, NOC, integrações, auditoria)
    auth.js            # token HMAC e exigir(permissão)
    lib/permissoes.js  # matriz perfil × permissão
    drivers/           # contrato único por fabricante: base (HTTP com TLS por equipamento), index (registro), mikrotik
    lib/cwmp.js        # o SOAP do TR-069, lido como entrada hostil (sem DOCTYPE, tamanho limitado, caixa respeitada)
    lib/acs.js         # registro do aparelho, fila por CPE, credencial e chamada (Digest)
    lib/ficha.js       # a ficha do assinante inteira numa resposta, filtrada pela permissão do perfil
    lib/provisionamento.js # estado desejado x real, divergências, fila, reconciliação
    lib/consultas.js   # CNPJ e CEP com cache, queda de fonte e degradação honesta
    lib/faturamento.js # pró-rata, ciclo, encargos, baixa, estorno
    lib/cobranca.js    # régua versionada, carência, bloqueio, confiança, inadimplência
    lib/frota.js manutencao.js combustivel.js rede.js comissoes.js noc.js anexos.js enderecos.js http.js (paginação, idempotência, CSV)
    conectores/        # base (SSRF, timeout, estados, backoff), rastreador, downdetector
    routes/            # organizacao, assinantes, planos, contratos, faturamento, cobranca, provisionamento, acs (público), cpes, consultas, frota, manutencao, combustivel, rede, chamados, equipe, noc, coletor, rastreamento, integracoes, painel
    coletas.js         # agenda das coletas, a rotina diária de cobrança e a fila do provisionamento
    demo.js            # organização demonstrativa (separada)
  public/              # SPA sem build (módulos ES), Leaflet + markercluster servidos do próprio pacote
  scripts/coletor-exemplo.js
  test/                # node:test, com o rastreador real, um RouterOS e um CPE de mentira que falam os protocolos de verdade
```

## O que depende de terceiros

- **Campo livre do boleto**: os 8 bancos acompanhados montam o código de barras pelo manual da instituição, mas nenhum foi conferido contra um boleto real. A conta nasce com o layout **não validado** e avisa isso em toda emissão, até alguém pagar um boleto de teste e confirmar a compensação. Carteira e convênio vêm do contrato de cobrança do provedor.
- **Posições do retorno CNAB**: o 240 segue a FEBRABAN; o 400 varia por banco. Por isso o arquivo passa por conferência antes de aplicar, e o mapa de posições (`server/lib/cnab.js`, `POSICOES`) é editável.
- **Registro de boleto e cobrança PIX por API, e a PayAx**: exigem o manual da instituição e as credenciais do credenciamento. O contrato do adaptador está escrito (`server/bancos/`), o registro está vazio, e a cobrança por arquivo e por BR Code funciona sem nenhuma delas.
- **Cartão de crédito e débito automático**: exigem contrato com um meio de pagamento.
- **Envio automático de aviso por WhatsApp ou e-mail**: exige contrato com um provedor de mensagens. A régua deixa o aviso pronto, com o texto da regra, e registra quem despachou e quando.
- **Nota fiscal (NFCom, modelo 62)**: exige certificado digital e credenciamento na SEFAZ.
- **Drivers de outros fabricantes**: hoje acompanha o driver de **MikroTik RouterOS** (concentrador PPPoE, API REST), testado de ponta a ponta. Huawei, ZTE, Fiberhome, Datacom, Parks, Intelbras e Cisco entram pelo mesmo contrato — OLT e CPE normalmente exigem SSH/Telnet/SNMP ou TR-069, caminhos que ainda não estão escritos. O que falta é driver, não arquitetura.
- **Alcance do ACS**: o CPE precisa chegar ao endereço do ACS, e o ACS precisa chegar ao CPE para o "aplicar agora". Em CGNAT sem porta aberta a mudança continua funcionando — só espera o contato periódico do aparelho.
- **Downdetector**: acesso autorizado (API Enterprise), credencial e a documentação dos recursos contratados.
- **Plataforma de monitoramento** do provedor (ou o agente de exemplo na rede interna) enviando amostras ao coletor.
- **Rota viária e trânsito** para estimar chegada: hoje só distância em linha reta, identificada como tal.
- **Camada de mapa licenciada** para o volume de uso da operação.
