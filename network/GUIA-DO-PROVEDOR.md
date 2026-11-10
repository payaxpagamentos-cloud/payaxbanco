# Guia do provedor — Manager Network

Passo a passo para colocar o tráfego, o Anti-DDoS e os avisos para funcionar na sua rede. Cada etapa diz o que fazer no
Manager Network e o que fazer no seu equipamento. O Manager Network **só lê** os roteadores e o BRAS: nada é configurado neles pelo sistema.

## 1. Servidor

- Rode o painel (`npm start`) e o coletor de rede (`npm run coletor-rede`) no mesmo servidor e no mesmo banco.
  Em instalação pequena, use `NETWORK_COLETOR_EMBUTIDO=1` e só o `npm start`.
- Libere no firewall do servidor, **só para os IPs dos seus roteadores e BRAS**: UDP 2055 (NetFlow), 4739 (IPFIX), 6343 (sFlow) e 1813 (RADIUS accounting).
- Para 10 Gbps ou mais, aumente o buffer UDP do sistema: `sysctl -w net.core.rmem_max=67108864`.

## 2. Roteadores (flows)

1. Em **Fontes e avisos → Roteadores**, cadastre cada roteador com o IP de **origem** do export e o papel:
   - **Borda**: o que fala com a internet (trânsito, PTT, CDN). É ele que alimenta o Anti-DDoS.
   - **BRAS** e **core**: tráfego interno (usado nos módulos de assinantes e ataques internos).
2. No roteador, exporte NetFlow v9, IPFIX ou sFlow para o servidor. Recomendações:
   - amostragem de 1:1000 a 1:4000 em 10–50 Gbps (informe a taxa no cadastro se o roteador não a enviar);
   - *active timeout* de até 60 s e *inactive timeout* de 15 s (com tempo maior, o ataque demora mais para aparecer);
   - exporte nas interfaces de **entrada** da borda, para não contar o mesmo tráfego duas vezes.
3. Em poucos segundos o roteador aparece como **Conectada**, com o formato reconhecido. "Sem template" logo no início é normal no NetFlow v9/IPFIX
   (o roteador reenvia o template em seguida).

## 3. Blocos e limites

1. Em **Anti-DDoS → Grupos e limites**, crie os grupos (ex.: Clientes residenciais, Corporativos, Servidores) com os blocos de cada um.
2. Clique em **Usar limites sugeridos** e depois ajuste ao tráfego normal da sua rede (veja os picos em **Tráfego**). Não existe limite universal.
3. Escolha o que fazer quando detectar: **só alertar**, **pedir aprovação** (recomendado no começo) ou **bloquear automaticamente**.
4. Em **Nunca bloquear**, inclua os DNS do provedor, a gerência, o next-hop do blackhole e os clientes críticos.

## 4. BGP (ExaBGP)

1. Instale o ExaBGP num servidor com sessão iBGP com a borda (famílias `ipv4 unicast`, `ipv6 unicast`, `ipv4 flow`, `ipv6 flow`).
2. Em **Fontes e avisos → BGP**, gere um token de uso "ExaBGP".
3. No ExaBGP, configure o processo (exemplo completo no cabeçalho de `scripts/exabgp-sincronizar.js`) com `NETWORK_URL` e `NETWORK_BGP_TOKEN`.
4. Em **Anti-DDoS → Configuração**, confira o next-hop e a community do blackhole (padrão `65535:666`, RFC 7999) com a sua operadora de trânsito,
   e o next-hop da limpeza em linha, se houver.
5. No roteador, aceite FlowSpec do ExaBGP e associe a community de blackhole a uma rota para `null0`/descarte.

Segurança: sem resposta do Manager Network, o ExaBGP mantém os anúncios por 30 minutos e depois retira todos.

## 5. RADIUS (assinantes)

1. Em **Fontes e avisos → RADIUS**, cadastre o BRAS com o IP de origem e um segredo.
2. No BRAS, inclua o servidor do Manager Network como **servidor de accounting adicional** (porta 1813) com o mesmo segredo.
   A autenticação dos clientes continua no seu RADIUS. Envie *interim-update* a cada 5–15 minutos.
3. Sem acesso ao BRAS, envie os eventos pela API `POST /api/coletor/sessoes` com um token de uso "sessões" (ex.: FreeRADIUS com `rlm_rest`).

As sessões ficam guardadas por pelo menos 1 ano, como pede o Marco Civil da Internet.

## 6. Avisos

Em **Fontes e avisos → Avisos** (só administrador):

- **Telegram**: crie um bot com o @BotFather, adicione-o ao grupo do NOC e informe o token e o ID do grupo.
- **WhatsApp**: use a API oficial da Meta (Phone Number ID e token). Fora da janela de 24 horas, a Meta só entrega mensagem de **modelo aprovado**:
  crie um modelo com uma variável e informe o nome.
- **Webhook**: para outros gateways; o corpo vai em JSON, assinado com HMAC-SHA256 no cabeçalho `X-Assinatura` quando houver segredo.

Use **Testar** depois de salvar. Falhas aparecem em "Últimos envios" com o erro e o ID.

## 7. Consumo e Conteúdo

- **Consumo** (Tráfego da rede → Consumo): painel ao vivo. Clique em **Informar capacidade** e digite a soma dos links de borda (ex.: 2 × 10 Gbps = 20),
  para o medidor de uso. Bom para deixar aberto numa TV do NOC.
- **Conteúdo** (Tráfego da rede → Conteúdo): mostra de quais redes vem o tráfego dos clientes. Para funcionar bem:
  1. no roteador de borda, exporte o ASN de origem no flow (*bgp-origin-as*), **ou**
  2. importe a base pública IP → ASN uma vez por semana: `wget https://iptoasn.com/data/ip2asn-combined.tsv.gz && npm run importar-asn -- ip2asn-combined.tsv.gz`.
  3. Em **Catálogo**, confira os ASNs do catálogo inicial e inclua os caches dentro da sua rede (ex.: o servidor de cache da Netflix ou do Google)
     **por prefixo**: o tráfego que sai do cache não passa pela borda, mas o prefixo cadastrado garante o nome certo se ele aparecer.
  4. Na lista, use **Catalogar** nos ASNs que aparecem sem nome.

O flow mostra a rede de origem, não o site nem o vídeo: CDNs compartilhadas (Akamai, Cloudflare, AWS) aparecem pelo nome da CDN.

## 8. Testar sem a rede real

```bash
npm run demo                                  # organização "Conecta Fibra" com dados fictícios
# cadastre o exportador 127.0.0.1 (borda) e rode:
npm run coletor-rede
ATAQUE=dns ALVO=203.0.113.10 npm run simulador
```

Em cerca de 10 segundos o ataque aparece em **Anti-DDoS**, com o bloqueio aguardando aprovação.
