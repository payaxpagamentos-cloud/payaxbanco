# ZOE PABX Inteligente

Painel de gestão de PABX em nuvem (**ZOE PABX Inteligente**), publicado em `/pabx`, com dois níveis de acesso:

| Perfil | O que vê |
|---|---|
| **Master** | A plataforma inteira: empresas, chamadas de todas, usuários e permissões, segurança, relatórios, terminação (operadoras e números), diagnóstico, configurações e integrações. Entra no painel de qualquer empresa pela lista de Empresas. |
| **Suporte** | Como o master, sem usuários, segurança e configurações; só consulta a terminação e as chaves de API e não exclui empresas. |
| **Cliente** (administrador da empresa) | O painel da própria empresa: dashboard, supervisão de campanhas, campanhas, pessoas/ramais, chamadas, CRM, terminação, números entrantes, recursos PABX, relatórios, configurações e integrações. |
| **Supervisor** | O painel da empresa só para consulta (não altera nada e não vê senhas nem chaves). |

O painel cuida do cadastro e do acompanhamento. **Quem faz as ligações é a central telefônica** (Asterisk, FreeSWITCH ou outra),
que busca a configuração e informa cada chamada pela [API de integração](#api-de-integração).

Servidor próprio (Node.js + SQLite), sem depender do Ativa BPO nem do APP Táxi. Tema escuro por padrão, com o claro no botão do topo.

## Telas

### Master
- **Dashboard**: empresas ativas, chamadas agora, ramais online, faturamento; utilização (recebidas, realizadas e gastos de hoje e do mês),
  chamadas simultâneas ao longo do dia, ramais online/offline, uso do mês por tipo de destino, empresas com mais chamadas e TTS/STT.
- **Empresas**: filtro por nome, tipo e status; ramais (ativos/limite), chamadas online/total de hoje, uso do disco das gravações;
  **editar** (dados, limites, rota de saída e tarifas), **bloquear/desbloquear** (com motivo) e **excluir** (confirmando o nome).
  Clicar na empresa abre o painel dela (`Empresas / NOME / Dashboard`).
- **Chamadas**: todas as empresas, com filtros, detalhe e CSV.
- **Permissões e usuários**: usuários da plataforma e das empresas, perfil, ativo/inativo e troca de senha. Sempre sobra um master ativo.
- **Segurança**: logins recusados nas últimas 24 h, **bloqueio de IP** (o IP bloqueado não acessa o painel nem a API) e o registro de atividades.
- **Relatórios**: por dia, por tipo de destino e **por empresa**, com CSV e impressão.
- **Terminação**: rotas de saída (operadoras: host, usuário, canais e custo por minuto) e o estoque de **números (DIDs)**, atribuídos às empresas.
- **Diagnóstico**: verificações (banco, contato da central telefônica, registro de ramais, chamadas presas, empresas sem rota, números sem destino,
  disco cheio, empresas no limite de canais) e o estado das rotas.
- **Configurações**: nome da plataforma, cadência da tarifação (ex.: 30/6), padrões das empresas novas e tempos da central telefônica.
- **Integrações**: chaves de API de todas as empresas e o guia da API.

### Cliente
- **ZOE**: a atendente virtual ligada ao IXC (veja [ZOE](#zoe-atendente-virtual)). Ligações de hoje, quanto a ZOE resolveu sozinha,
  transferidas, boletos e desbloqueios do mês, motivos das ligações, o que a ZOE fez em cada ligação e a configuração.
- **Dashboard**: os cartões Utilização, Chamadas Simultâneas, Ramais, Uso mês atual, Recursos de voz e texto (TTS/STT) e Limites.
- **Supervisão de campanhas**: progresso de cada campanha e cada agente (livre, em chamada, offline), atualizando sozinha.
### ZOE conversando no telefone

O `scripts/zoe-agi.js` tem dois modos:

- **Conversado** (com `ZOE_CEREBRO`, `ZOE_CEREBRO_CHAVE` e `ZOE_TTS_APP`): a ligação fala com a
  **mesma ZOE do WhatsApp**, no ZOE Atende. O cliente fala o que quer; o Asterisk grava até 2 s de
  silêncio (`RECORD FILE`), manda a fala para o ZOE Atende, que transcreve com o mesmo whisper e
  responde com as mesmas regras e ferramentas; o TTS fala a resposta. Apertar uma tecla interrompe
  a gravação e lê o número pelo teclado. As gravações são apagadas na hora.
- **Por teclas** (sem `ZOE_CEREBRO`, ou se ele estiver fora do ar quando a ligação chega): a URA de
  teclas de sempre, pela API do PABX. Fica como reserva.

Os dois deixam no canal as mesmas variáveis (`ZOE_STATUS`, `ZOE_FILA_NOME`, `ZOE_RESUMO`): o plano
de discagem não muda. **Os nomes das filas precisam ser iguais** no ZOE Atende e no Asterisk, porque
é pelo nome que a ligação cai na fila certa (`Queue(${ZOE_FILA_NOME})`).

```
ZOE_CEREBRO=https://SEU-DOMINIO/atendimento
ZOE_CEREBRO_CHAVE=atd_...
ZOE_TTS_APP=Flite            # ou a aplicação de voz instalada no Asterisk
ZOE_SUSSURRO=1               # 0 desliga o resumo falado no ouvido do atendente
```

**Passagem para o atendente.** Na transferência a ZOE deixa `__ZOE_UID` e `__ZOE_SUSSURRO`, que
passam para o canal do ramal que a fila chamar. Com o gosub no `Queue`, quando o ramal atende:
o atendente ouve o resumo antes de o cliente entrar, e o painel de quem tem aquele ramal
(`Usuários › Ramal` no ZOE Atende) abre com tudo o que o cliente disse e o que a ZOE já fez.

```
exten => s,1,Answer()
 same => n,AGI(/opt/zoe/zoe-agi.js)
 same => n,GotoIf($["${ZOE_STATUS}" = "transferir" | "${ZOE_STATUS}" = "indisponivel"]?fila)
 same => n,Hangup()
 same => n(fila),Queue(${IF($["${ZOE_FILA_NOME}" = ""]?atendimento:${ZOE_FILA_NOME})},,,,,,,zoe-atendeu^s^1)
exten => h,1,AGI(/opt/zoe/zoe-agi.js,fim)

[zoe-atendeu]
exten => s,1,AGI(/opt/zoe/zoe-agi.js,atendeu)
 same => n,Return()
```

O `h` fecha a conversa no ZOE Atende quando o cliente desliga — inclusive depois de falar com o
atendente. Nada disso segura a ligação: se o ZOE Atende não responder em 3 s, o atendente atende
normalmente.

### URA inteligente

A URA comum pergunta a mesma coisa para todo mundo. A inteligente consulta o IXC pelo número que
ligou e **abre pelo motivo mais provável daquela pessoa**:

| Situação | Ordem | O que ela oferece |
|---|---|---|
| Falha em massa na região | 1ª | avisa que já sabemos e **não abre chamado** |
| Acesso bloqueado por atraso | 2ª | desbloqueio de confiança na hora |
| Fatura vencida | 3ª | segunda via |
| Fatura perto do vencimento | 4ª | segunda via |
| Conexão fora do ar agora | 5ª | suporte técnico |

Cada uma liga, desliga e tem a fala reescrita pelo provedor, em `PABX › URA › Inteligência`.

**A regra de privacidade.** Bina se falsifica, então reconhecer o número **não é** confirmar a
identidade. A URA trabalha em dois momentos:

- **antes de confirmar**: a situação só muda a ORDEM do menu. Nada de nome, valor, vencimento ou
  bloqueio. A única exceção é a falha na região, que é informação da rede e não do contrato — e é
  justamente ela que evita a ligação virar mais um chamado do mesmo problema;
- **depois de confirmar** (três primeiros do CPF/CNPJ ou data de nascimento): aí sim fala tudo e
  oferece a solução.

**Nunca prende o cliente.** Toda abertura tem a tecla do atendente. Se o IXC cair, se houver dois
cadastros no mesmo telefone ou se o número for desconhecido, a URA cai no menu normal em vez de
deixar a ligação no vazio.

**Os alertas de rede vêm do ZOE Atende**, que é onde a equipe os cadastra, por
`GET /api/integracao/alertas`. Guardar uma cópia aqui criaria duas verdades sobre a mesma falha —
e, no dia em que divergissem, a ZOE do WhatsApp e a do telefone contariam histórias diferentes
para o mesmo cliente.

A central telefônica conversa com ela por duas rotas:
`POST /api/integracao/ura/:id/atender` `{ uid, telefone }` (a ligação chegou) e
`POST /api/integracao/ura/:id/confirmado` `{ uid, codigo }` (o que o cliente digitou). Quem confere
o código é o servidor, contra o cliente que o `/atender` reconheceu naquele `uid`: a central nunca
informa o cliente. Código errado devolve `fase: "confirmar"` (tente de novo); no terceiro erro,
`fase: "fila"` (vai para o atendente). Sem `uid` no `/atender`, a ligação segue como desconhecida.

- **Campanhas** (discador): modo, fila que atende, canais e tentativas; importação de contatos ("nome;telefone"), ativar, pausar e encerrar.
- **Pessoas / Ramais**: cadastro dentro do limite contratado, gravação por ramal, situação do registro e os dados SIP para configurar o telefone.
- **Chamadas**: lista com filtros (período, direção, status, ramal, número ou contato), detalhe e CSV.
- **CRM**: contatos com o histórico de chamadas; o nome aparece na lista de chamadas.
- **Terminação**: rota, cadência, preço por minuto e consumo do mês.
- **Números Entrantes**: para onde vai cada número (ramal, fila ou URA).
- **Recursos PABX**: filas de atendimento (ramais e distribuição) e URAs (mensagem e opções por tecla).
- **Relatórios**: por dia, por tipo de destino e por ramal.
- **Configurações**: contato, gravação, plano contratado e usuários da empresa (administrador e supervisor).
- **Integrações**: chaves de API da empresa.

## Telefone no painel

Botão azul no canto inferior direito, para os usuários das empresas: abre o teclado para **ligar** (com mudo, teclas durante a
ligação e desligar) e, quando chega uma ligação, mostra o aviso **no meio da tela** com toque para **atender ou recusar**.
Com o painel minimizado ou em outra aba, o navegador mostra uma notificação do sistema (o usuário ativa no próprio telefone,
em "Ativar aviso de ligação") e o título da aba pisca; clicar na notificação traz o painel de volta. O navegador precisa
estar aberto: fechar a aba desconecta o ramal. O ponto no botão mostra a situação (verde: online; vermelho: desconectado).

Cada usuário liga com **o próprio ramal**: o administrador escolhe em Configurações → Usuários → "Ramal no telefone do painel"
(um usuário por ramal). O painel entrega a senha SIP só do ramal do usuário logado.

Para funcionar:
1. **Asterisk com WebRTC** (PJSIP): transporte WSS com certificado válido e os ramais com `webrtc=yes`:
   ```
   ; pjsip.conf
   [transport-wss]
   type=transport
   protocol=wss
   bind=0.0.0.0
   ; http.conf: tlsenable=yes, tlsbindaddr=0.0.0.0:8089, tlscertfile/tlsprivatekey do seu domínio

   [1_100]            ; usuario_sip = <empresa>_<ramal> (veja GET /config da integração)
   type=endpoint
   webrtc=yes
   context=ramais
   disallow=all
   allow=opus,ulaw
   auth=1_100
   aors=1_100
   ```
2. No servidor do painel: `PABX_WEBRTC_WSS=wss://pbx.seudominio.com.br:8089/ws` (e, se o domínio SIP for outro, `PABX_SIP_DOMINIO`).
   O endereço entra na política de segurança (CSP) do painel, que só conversa com ele.
3. O painel precisa estar em **https** (o navegador só libera o microfone assim).

A biblioteca SIP (JsSIP, licença MIT) fica em `public/vendor/jssip.min.js`; para atualizar: `npm run vendor`.

## Tarifação e limites

- Só as ligações **realizadas e atendidas** são cobradas. O tipo vem do número discado: móvel (9 dígitos começando com 9), fixo,
  internacional (`00…`) ou interno (ramal).
- Tempo cobrado na cadência configurada (padrão **30/6**: mínimo de 30 s, depois a cada 6 s) × preço por minuto da empresa.
- A central telefônica recebe **429** ao passar do limite de chamadas simultâneas e **403** com a empresa bloqueada. Sem espaço em disco,
  a resposta do início da chamada diz `gravar: false`. TTS e STT são recusados acima do limite do mês.
- Chamadas que a central não encerrou em 6 h viram "falha"; ramais sem registro há 10 min ficam offline (ajustável em Configurações).

## API de integração

Autenticação pela chave da empresa (Integrações → Nova chave) no cabeçalho `X-Api-Key`. Base: `https://SEU-DOMINIO/pabx/api/integracao`.

| Método e caminho | Para quê |
|---|---|
| `GET /config` | Ramais (com usuário e senha SIP), números e destinos, filas com os ramais, URAs e a rota de saída. |
| `POST /chamadas` | Início: `{ uid, direcao: entrada\|saida\|interna, origem, destino, ramal?, numero?, campanha_contato_id?, inicio? }` → `{ id, gravar }`. |
| `POST /chamadas/:uid/atendida` | Atendimento: `{ em? }`. |
| `POST /chamadas/:uid/fim` | Fim: `{ status?: atendida\|nao_atendida\|ocupado\|falha, fim?, gravacao_bytes? }` → duração, custo. |
| `POST /ramais/:numero/registro` | Telefone conectou/desconectou: `{ online, ip?, agente? }`. |
| `POST /recursos` | Uso de TTS/STT: `{ recurso: tts\|stt, quantidade }`. |
| `POST /campanhas/:id/proximos` | Discador: próximos contatos a ligar (até os canais livres), já marcados como "discando". |

Repetir a mesma mensagem (mesmo `uid`) não duplica a chamada.

## ZOE (atendente virtual)

A ZOE atende as ligações de clientes de provedores de internet e resolve sozinha o que é repetitivo, consultando e agindo
direto no **IXC Provedor**. Fase 1 (esta): **URA por teclas**. A voz com IA (fase 2) usa as mesmas etapas da API.

| Tecla | O que a ZOE faz |
|---|---|
| — | Identifica pelo número que ligou (BINA) ou pede o CPF/CNPJ, e confirma: número cadastrado + 3 primeiros dígitos do CPF/CNPJ; número desconhecido + data de nascimento. Nada do contrato é dito antes. |
| 1 | Segunda via: diz quantas faturas estão abertas, vencimento e valor, e envia boleto e PIX por WhatsApp, SMS ou e-mail **cadastrados no IXC**. |
| 2 | Desbloqueio de confiança: só contrato bloqueado por atraso (nunca bloqueio manual), dentro do limite por cliente (padrão 1 a cada 30 dias). O prazo é o do IXC. |
| 3, 4, 0 | Transfere para a fila de suporte, comercial ou atendimento, com um resumo da conversa. |

Se o IXC não responder em 3 segundos, a ZOE avisa e transfere. Tudo o que ela fez fica registrado por ligação (tela ZOE),
sem guardar o CPF. Ela não negocia desconto, não muda plano e não cancela contrato.

**Configurar** (tela ZOE, administrador da empresa):
1. No IXC, crie um usuário só para a ZOE, com permissão apenas para consultar clientes, contratos e faturas, gerar boleto e
   fazer desbloqueio de confiança, e copie o token (Configurações > Usuários > Token).
2. Informe o endereço do IXC e o token, clique em **Testar conexão**, escolha os canais e as filas de cada motivo e ligue a ZOE.
   O token fica cifrado com o `PABX_SECRET` (se ele mudar, informe o token de novo).
3. WhatsApp: o IXC não envia por WhatsApp; informe o endereço do seu serviço (webhook). A ZOE envia um `POST` com
   `{ evento: "zoe.boleto", telefone, cliente_nome, fatura: { id, vencimento, valor_centavos }, pdf_base64 }`.

**No Asterisk/Issabel**: copie `scripts/zoe-agi.js` (no pacote: `asterisk/zoe-agi.js`) para o servidor do Asterisk (Node.js 22),
crie uma chave em Integrações e mande as ligações para ele:

```
; extensions.conf
exten => s,1,Answer()
 same => n,Set(ZOE_STATUS=)
 same => n,AGI(/opt/zoe/zoe-agi.js,https://SEU-DOMINIO/pabx/api/integracao,pbx_SUA_CHAVE)
 same => n,GotoIf($["${ZOE_STATUS}" = "resolvido"]?fim)
 same => n,Queue(${IF($["${ZOE_FILA_NOME}" = ""]?atendimento:${ZOE_FILA_NOME})})
 same => n(fim),Hangup()
```

O script deixa no canal `ZOE_STATUS` (`resolvido`, `transferir`, `indisponivel` ou `desligou`), `ZOE_FILA_ID`, `ZOE_FILA_NOME` e `ZOE_RESUMO`.
Com a ZOE desligada ou fora do ar, `ZOE_STATUS=indisponivel` e a ligação segue para a fila padrão.

Voz: com `ZOE_TTS_APP=Flite` (ou outra aplicação de texto para voz do Asterisk) no ambiente do Asterisk, a ZOE fala o texto que a API devolve.
Sem ela, toca áudios gravados em `sounds/zoe/`: `aviso`, `digite-documento`, `digite-cpf3`, `digite-nascimento`, `menu`, `sem-faturas`,
`faturas-abertas`, `vence-em`, `mes-01` a `mes-12`, `valor-de`, `reais`, `e`, `centavos`, `canal-whatsapp`, `canal-sms`, `canal-email`,
`boleto-enviado`, `liberado`, `ja-liberado`, `desbloqueio-limite`, `desbloqueio-negado`, `transferindo`, `obrigada`.

**API da ZOE** (mesma chave `X-Api-Key`, base `/pabx/api/integracao/zoe/atendimentos`). Cada resposta traz a `etapa` seguinte
(`documento`, `confirmar`, `menu`, `transferir`) e a `fala` pronta para texto para voz:

| Método e caminho | Para quê |
|---|---|
| `POST /` | Início: `{ uid, telefone }`. |
| `POST /:uid/documento` | CPF/CNPJ: `{ documento }`. |
| `POST /:uid/confirmar` | Confirmação: `{ codigo }` (3 dígitos ou DDMMAAAA). |
| `GET /:uid/faturas` | Faturas abertas, total e canais disponíveis (com destino mascarado). |
| `POST /:uid/boleto` | `{ canal: whatsapp\|sms\|email, fatura_id? }` (padrão: a mais antiga). |
| `POST /:uid/desbloqueio` | Desbloqueio de confiança → `{ liberado, motivo? }`. |
| `POST /:uid/transferir` | `{ motivo: financeiro\|suporte\|comercial\|outro }` → fila e resumo. |
| `POST /:uid/fim` | Fim da ligação. |

**A validar no IXC do piloto**: os recursos usados (`cliente`, `cliente_contrato`, `fn_areceber`, `get_boleto` com `tipo_boleto` `mail`/`sms`/`arquivo`,
`desbloqueio_confianca`) e os códigos de situação do contrato estão todos em `server/zoe/ixc.js`, para ajustar num lugar só.

## Rodar

```bash
cd pabx
npm install
npm run seed     # opcional: 3 empresas de exemplo com chamadas do mês
npm start        # http://localhost:3300/  (ou PABX_BASE_PATH=/pabx → http://localhost:3300/pabx/)
npm test
```

Master inicial: `master@pabx.com.br` / `master123` (troque com `PABX_ADMIN_EMAIL` e `PABX_ADMIN_SENHA`; em produção a senha é obrigatória).
Contas de exemplo do `seed` (senha `demo12345`): `cliente@cobranca.demo`, `cliente@clinica.demo`, `cliente@loja.demo` e `supervisor@cobranca.demo`.

Configuração: veja [`.env.exemplo`](.env.exemplo). Instalação em servidor (PM2, Docker, cPanel, Nginx/Apache): `npm run empacotar`
gera `dist/pabx.zip` com o [LEIA-ME](scripts/LEIA-ME.txt).
