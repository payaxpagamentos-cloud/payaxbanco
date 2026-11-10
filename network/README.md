# Manager Network

Sistema para provedores de internet que reúne **tráfego e Anti-DDoS, rede óptica, Central NOC, chamados técnicos, equipe e
comissões, frota, manutenção, abastecimentos e rastreamento**. Publicado em `/network`, com servidor, banco (SQLite com migrações), usuários
e login próprios, e identidade própria: grafite e verde-esmeralda, com alertas em laranja e vermelho.

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
| 6 | **Veículos** | Placa normalizada e única por organização, responsáveis com início e fim, restrições (oficina, documento, sinistro…) que tiram o veículo da escala até a liberação, documentos com vencimento, histórico de manutenção, abastecimentos e chamados. |
| 7 | **Manutenção e lavagem** | Planos preventivos por item, por dias e/ou km (alerta no primeiro limite, antecedência e tolerância); ordens solicitado → orçado → aprovado (alçada por valor) → agendado → em execução → concluído; lavagem sem zerar a mecânica; fornecedores; custos orçado e realizado separados. |
| 8 | **Abastecimentos** | Comprovante, volume, preço, odômetro e tanque cheio; total = litros × preço; preço médio ponderado; consumo por ciclo entre tanques cheios (com os parciais); lançamento retroativo validado; volume acima do tanque sinalizado; correção autorizada com valor original guardado; relatórios por veículo, técnico e posto; CSV protegido. |
| 9 | **Rastreamento** | Posições do rastreador com horário da medição e idade; parado ≠ sem comunicação; ignição ausente = desconhecida; trajeto do período; vínculo dispositivo ↔ veículo pelo IMEI (a placa só sugere); chamados próximos por distância em linha reta (não é ETA). |
| 10 | **Integrações** | Rastreador, coletores de monitoramento e Downdetector: configuração, teste de conexão, estado (não configurada, conectada, parcial, desatualizada, sem permissão, limite atingido, falha), último sucesso, erro com ID e histórico de coletas. |
| 11 | **Tráfego** | Entrada e saída dos blocos protegidos por NetFlow v5/v9, IPFIX e sFlow (com amostragem, IPv6, VLAN, PPPoE e MPLS); gráfico por minuto ou hora, IPs que mais recebem e enviam (CSV), ficha do IP com tráfego, ataques e quem usou o endereço. |
| 11a | **Consumo** | Painel em tempo real no estilo Grafana (escuro): entrada, saída, pacotes, fluxos e UDP com minigráficos, medidor de uso da capacidade dos links, tráfego com legenda de média/máximo/atual, protocolos empilhados, entrada por grupo, pacotes/s e maiores consumidores agora. Somas de 5 s, períodos de 5 min a 6 h, atualização a cada 5, 10 ou 30 s. |
| 11b | **Conteúdo** | Principais conteúdos pelo ASN de origem de cada flow (ou pela base IP → ASN importada): ranking com participação, média, pico e comparação com o período anterior, consumo empilhado no tempo, diagrama de fluxo conteúdo → grupos de clientes e catálogo editável (Google/YouTube, Netflix, Meta, CDNs…) por ASN ou prefixo. |
| 12 | **Anti-DDoS** | Detecção a cada 5 s com médias de 5, 10 e 60 s por IP e por grupo (bits/s, pacotes/s, fluxos/s, TCP, UDP, SYN, ICMP), confirmação e histerese, vetor do ataque (amplificação DNS/NTP/SSDP/Memcached…, SYN flood, ICMP), separação de fora para dentro e saindo da rede. Bloqueio por BGP (FlowSpec, blackhole, limpeza em linha) automático ou com aprovação, sempre com lista "nunca bloquear", limite de ações simultâneas, retirada automática e registro de quem fez. Relatório do ataque em PDF. |
| 13 | **Assinantes** | Sessões PPPoE/IPoE pela contabilidade RADIUS do BRAS (cópia do accounting, conferida pelo segredo): login, IP, IPv6, MAC, início e fim. Busca por login, IP ou MAC e "quem estava com este IP" no instante do ataque. |
| 14 | **Fontes e avisos** | Roteadores exportadores, NAS RADIUS, ponte com o ExaBGP e canais "Manager Network Alertas" no Telegram, WhatsApp (API oficial) ou webhook, com fila e novas tentativas. |

Mais: **Organização e acessos** (usuários, perfis, matriz de permissões, parâmetros da operação e auditoria com request ID).

## Perfis

| Perfil | Acesso |
|---|---|
| **Administrador** | Tudo da própria organização, inclusive usuários, integrações, parâmetros e auditoria. |
| **Gestor operacional** | Distribui e valida chamados, rede, NOC, frota (consulta e escala) e produtividade. |
| **NOC** | Rede, incidentes, regras de monitoramento, topologia e chamados relacionados. |
| **Gestor de frota** | Veículos, restrições, documentos, manutenção, lavagem, fornecedores, combustível e vínculos do rastreador. |
| **Técnico** | Só os próprios chamados (execução, checklist, evidências), as próprias comissões e os abastecimentos do veículo sob sua responsabilidade. Não vê a posição das equipes. |
| **Conferência de comissões** | Regras, aprovação, ajustes e registro de pagamento (nunca da própria comissão). |
| **Consulta / TV** | Indicadores e painel TV, sem escrita. Vê tráfego e ataques, mas não login nem MAC de assinantes. |

No tráfego: **NOC** e **administrador** configuram e aprovam bloqueios; **gestor** acompanha e vê os assinantes; avisos só o **administrador** configura.

As regras ficam no servidor (`server/lib/permissoes.js` e as rotas): esconder um botão não substitui a permissão. Todo dado
tem `organizacao_id` e cada consulta filtra pela organização do usuário.

## Rodar

Requisitos: **Node.js 22.13+**.

```bash
cd network
npm install
npm start          # http://localhost:3500/  (com NETWORK_BASE_PATH=/network → http://localhost:3500/network/)
npm test           # testes de aceite (inclui o rastreador real, se rastreador/node_modules existir)
npm run coletor-rede   # coletor de flows (UDP 2055/4739/6343) e RADIUS accounting (UDP 1813), no mesmo banco
```

Acesso inicial: `admin@managernetwork.local` / `admin12345` (defina `NETWORK_ADMIN_EMAIL` e `NETWORK_ADMIN_SENHA`; em produção a senha é obrigatória).
O primeiro start cria a organização (`NETWORK_ORGANIZACAO`) **vazia**: os cadastros reais começam do zero.

### Ambiente demonstrativo (opcional)

```bash
npm run demo       # cria a organização "Conecta Fibra", separada e marcada como demonstração
```

Dados fictícios (pessoas, placas, endereços, medições, valores de comissão, tráfego, ataques e sessões de assinantes em blocos de
documentação como 203.0.113.0/24), criados pela própria API. Para ver a detecção ao vivo, cadastre o exportador `127.0.0.1` (borda) e rode
`npm run coletor-rede` e `ATAQUE=dns ALVO=203.0.113.10 npm run simulador`. A interface mostra o
selo **Ambiente demonstrativo** só nessa organização. Acessos com a senha `demo12345`: `demo@`, `gestor.demo@`, `noc.demo@`,
`frota.demo@`, `lucas.demo@` (técnico), `comissoes.demo@` e `tv.demo@managernetwork.local`. O script recusa rodar com
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
| `NETWORK_FLUXOS_PORTAS` | `2055,4739,6343` | Portas UDP do coletor de flows (qualquer porta aceita qualquer formato). |
| `NETWORK_RADIUS_PORTA` | `1813` | Porta UDP do accounting RADIUS (`0` desliga). |
| `NETWORK_FLUXOS_HOST` / `NETWORK_FLUXOS_BUFFER_MB` | `0.0.0.0` / `32` | Endereço de escuta e buffer de recepção UDP (o sistema limita por `net.core.rmem_max`). |
| `NETWORK_COLETOR_EMBUTIDO` | desligado | `1` roda o coletor de rede dentro do servidor (instalação pequena), em vez de `npm run coletor-rede`. |
| `NETWORK_TRUST_PROXY` / `NETWORK_LIMITE_LOGIN` | `loopback` / `10` | Proxy reverso e tentativas de login por minuto. |

Migrações: aplicadas automaticamente no start, em ordem e numa transação cada (`server/db.js`, tabela `schema_migracoes`).
`npm run migrar` aplica sem iniciar o servidor. Produção com Docker: `docker build -t manager-network network/` e volume em `/app/data`.

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

### Tráfego, Anti-DDoS e RADIUS

Passo a passo para o provedor: [`GUIA-DO-PROVEDOR.md`](GUIA-DO-PROVEDOR.md). Resumo:

1. **Fontes e avisos → Roteadores**: cadastre o IP de origem do export de cada roteador (papel *borda*, *BRAS* ou *core*) e aponte o
   NetFlow/IPFIX/sFlow para o servidor. Pacote de IP não cadastrado é descartado.
2. **Anti-DDoS → Grupos e limites**: cadastre os blocos do provedor por grupo, use os limites sugeridos como ponto de partida e
   escolha a política (só alertar, pedir aprovação ou bloquear automaticamente).
3. **Fontes e avisos → BGP**: gere o token de escopo `bgp` e rode `scripts/exabgp-sincronizar.js` como `process` do ExaBGP. O Manager
   Network não entra no roteador: o ExaBGP anuncia e retira as rotas que a tela mostra.
4. **Fontes e avisos → RADIUS**: cadastre o BRAS e o segredo e inclua o servidor como accounting adicional. Ou use
   `POST /api/coletor/sessoes` com um token de escopo `sessoes`.

5. **Conteúdo**: importe a base pública IP → ASN (`npm run importar-asn -- ip2asn-combined.tsv.gz`, do iptoasn.com) uma vez por semana, ou exporte
   o ASN no flow (src_as/dst_as). Confira o catálogo inicial na aba **Catálogo**.
6. **Consumo**: informe a capacidade somada dos links de borda no próprio painel, para o medidor de uso.

Armazenamento: o coletor soma o tráfego em memória e grava no SQLite por minuto e grupo (8 dias) e por IP e hora (400 dias);
sessões ficam no mínimo 366 dias (Marco Civil). Consumo em tempo real: somas de 5 s por 6 horas. Conteúdo: por minuto (8 dias) e por hora (400 dias),
até 300 conteúdos/ASNs por minuto (o resto em "outros").

Logos dos conteúdos: [Simple Icons](https://simpleicons.org) 15.0.0 (CC0), em `public/js/marcas.js`, usados só para identificar quem entrega
o tráfego. As marcas pertencem aos seus donos; Amazon e Microsoft não constam do Simple Icons a pedido delas e aparecem com as iniciais. O detalhe de cada flow não é guardado; um banco colunar (ClickHouse) pode ser
acrescentado depois, se o provedor precisar dessa consulta.

## Regras que o sistema garante

- **CTO/CEO são passivas**: sem ping nem sensor; a situação é inspeção manual ou inferência com a evidência (equipamento, ponto, valor, instante, regra).
- **Impacto** conta clientes únicos pela referência da porta; sem referência, mostra "portas ocupadas".
- **Concluir uma OS não resolve o incidente**; a resolução manual exige evidência.
- **Comissão** só depois da aprovação do chamado e da aprovação por perfil autorizado; restrição única por chamado/técnico/regra;
  versão da regra e valor guardados; ajustes são novos registros; pagamento é **registro administrativo, sem transferência bancária**.
- **Preventiva** alerta no primeiro limite (data ou km); sem odômetro confiável, avalia só a data e avisa.
- **Veículo com restrição ativa** não recebe escala; concluir um serviço só libera a restrição daquele serviço.
- **Dinheiro em centavos**, volume em mL e preço por litro em milésimos: todos os cálculos com inteiros.
- **Concorrência**: reserva de porta, aprovação e mudanças de status com condição sobre o estado e versão otimista (`versao`); conflito devolve 409 legível.
- **Idempotência**: todo POST da interface leva `Idempotency-Key`; repetir devolve a mesma resposta.
- **Segredos** só no servidor (cifrados), nunca em respostas ou na auditoria; anexos por link temporário assinado e permissão por recurso.
- **Bloqueio** nunca atinge a lista "nunca bloquear" (nem por pedido manual); passa pelo limite de ações simultâneas; sai do ar no prazo;
  blackhole só de um IP; quem pediu, aprovou, recusou e retirou fica na auditoria. Roteadores e BRAS: só leitura.

## Arquitetura

```
network/
  server/
    db.js              # migrações (organizações, frota, rede, chamados, comissões, rastreamento, NOC, integrações, auditoria)
    auth.js            # token HMAC e exigir(permissão)
    lib/permissoes.js  # matriz perfil × permissão
    lib/frota.js manutencao.js combustivel.js rede.js comissoes.js noc.js anexos.js http.js (paginação, idempotência, CSV)
    conectores/        # base (SSRF, timeout, estados, backoff), rastreador, downdetector
    lib/ip.js          # IPv4/IPv6, prefixos e busca pelo prefixo mais específico
    lib/fluxos/        # decodificar (NetFlow/IPFIX/sFlow), agregador, deteccao, servico (UDP), gerar (simulador/testes)
    lib/mitigacao.js radius.js avisos.js pdf.js relatorio-ataque.js conteudo.js (catálogo, base IP → ASN, classificação)
    routes/            # organizacao, frota, manutencao, combustivel, rede, chamados, equipe, noc, coletor, rastreamento, integracoes, painel,
                       # trafego, ddos, avisos
    coletor-rede.js    # processo do coletor de flows e RADIUS
    tarefas-trafego.js # retirada automática, fila de avisos, roteador parado, retenção
    coletas.js         # agenda das coletas
    demo.js            # organização demonstrativa (separada)
  public/              # SPA sem build (módulos ES), Leaflet + markercluster servidos do próprio pacote
  scripts/coletor-exemplo.js exabgp-sincronizar.js simulador-fluxos.js importar-asn.js
  test/                # node:test, incluindo o rastreador real em processo separado
```

## O que depende de terceiros

- **Downdetector**: acesso autorizado (API Enterprise), credencial e a documentação dos recursos contratados.
- **Plataforma de monitoramento** do provedor (ou o agente de exemplo na rede interna) enviando amostras ao coletor.
- **Cadastro de clientes/ONUs** do sistema de gestão: hoje a referência do cliente entra na porta; a conexão automática exige o contrato dessa API.
- **Rota viária e trânsito** para estimar chegada: hoje só distância em linha reta, identificada como tal.
- **Camada de mapa licenciada** para o volume de uso da operação.
