# Canais ao vivo: receber o sinal do fornecedor

Como o sinal do fornecedor (RTMP ou SRT) vira canal tocando no celular, na TV e no navegador.

---

## O que mandar para quem fornece o sinal

Copie e mande este pedaço:

> **O que precisamos para colocar os canais no ar**
>
> 1. **Protocolo**: SRT de preferência, RTMP também serve.
> 2. **Se for SRT**: nós conectamos em vocês (`caller`) ou vocês empurram para nós (`listener`)?
>    Qual porta? Tem `passphrase` ou `streamid`?
> 3. **Codec**: **H.264 (vídeo) + AAC (áudio)**. É o que toca em todo aparelho sem recodificar.
>    H.265 funciona, mas Smart TV e iPhone antigos não abrem.
> 4. **A lista de canais**: nome, número e o endereço de cada um.
> 5. **Banda de upload** do servidor de origem.

### Por que SRT é melhor que RTMP

| | RTMP | SRT |
|---|---|---|
| Perda de pacote na rede | engasga, congela | recupera sozinho (ARQ) |
| Atraso | 2 a 5 s | 0,5 a 2 s, ajustável |
| Codec | só H.264 + AAC | H.264, H.265, AAC, Opus |
| Criptografia | não tem | AES-128/256 nativo |
| Situação | tecnologia da era do Flash | padrão atual de contribuição |

RTMP funciona e está aceito aqui. Mas se o fornecedor puder escolher, peça SRT — num enlace
com perda, é a diferença entre o canal travar e o canal não travar.

---

## O que a plataforma faz com o sinal

Nem RTMP nem SRT tocam em navegador, celular ou TV. Então, para cada canal ligado, o servidor
mantém um `ffmpeg` conectado na origem **convertendo para HLS**, que é o formato que todo
aparelho abre.

A conversão é **remux** (`-c copy`), não recodificação:

- os mesmos quadros saem do outro lado — **a qualidade é exatamente a da origem**;
- o gasto de processador é quase zero;
- exige que a origem já venha em H.264 + AAC.

Se o sinal vier em outro codec, o painel avisa no "Testar" em vez de recodificar escondido —
recodificar derrubaria o servidor com uma dúzia de canais.

O assinante nunca vê o endereço da origem: ele recebe o endereço da plataforma, com token
assinado por tela, que expira.

### Custo medido por canal

Medido neste projeto, com sinal real de 720p a 3 Mbps:

| | por canal |
|---|---|
| Processador | **~1,8% de um núcleo** |
| Memória | **~57 MB** |
| Disco | só os segundos que estão na lista (poucos MB) |
| Tempo até entrar no ar | **~12 s** (ver abaixo) |

Quem limita é a **memória**, não o processador: 60 canais pesam cerca de 3,5 GB de RAM e pouco
mais de um núcleo. O teto está em `TV_AO_VIVO_MAX=60`; suba ou desça conforme a RAM do servidor.

A **banda de saída** é outra conta, e é a que manda: cada assinante assistindo consome o bitrate
do canal. 3 Mbps × 300 assinantes = 900 Mbps de upload.

### Por que o canal frio demora ~12 s, e não ~4 s

O ffmpeg escreve a lista assim que fecha o **primeiro** pedaço, com 4 segundos de vídeo dentro.
Entregar o canal nesse instante é tentador — e foi o que a plataforma fazia. O resultado era o
canal **travando**: o player ficava colado na ponta, sem reserva, correndo atrás de um processo
que produz 4 segundos a cada 4 segundos. Qualquer oscilação da rede do celular parava a imagem.

O HLS (RFC 8216) recomenda começar a tocar a **três pedaços da ponta**, e o hls.js procura
exatamente isso (`liveSyncDurationCount: 3`). Com um pedaço na lista, não há de onde tirar.

Então a plataforma espera **três pedaços** — 12 segundos de folga — antes de entregar o canal.
São uns 8 segundos a mais para abrir um canal frio, em troca de o canal não travar. Canal morno
(visto nos últimos 5 minutos) continua entrando na hora, porque a folga já existe.

Medido nesta bancada:

| | antes | depois |
|---|---|---|
| Lista liberada ao player | 3,6 s, com **1** pedaço | 11,7 s, com **3** pedaços |
| Folga de vídeo na entrada | 4 s | **12 s** |
| Pedaços guardados além da lista | 1 (4 s) | **6 (24 s)** |

A última linha é um segundo defeito, independente: o ffmpeg apagava o pedaço quase na hora em
que ele saía da lista. O player que ficasse dois pedaços atrás — comum em rede de celular —
pedia um arquivo já apagado, levava 404 e parava de vez. Guardar seis a mais custa uns 9 MB por
canal convertendo.

Os dois valores são ajustáveis: `TV_AO_VIVO_PEDACOS_INICIO` e `TV_AO_VIVO_PEDACOS_GUARDADOS`.

---

## Conversão sob demanda (é o que faz 116 canais caberem)

O servidor **não** converte os 116 canais o tempo todo. Converte **só os que alguém está
assistindo naquele momento**, e desliga cada um depois de 5 minutos sem ninguém.

Por que isso não é detalhe:

| | Todos ligados 24 h | Sob demanda |
|---|---|---|
| Memória | 116 × 57 MB = **6,6 GB** | ~40 canais vistos ao mesmo tempo = **2,3 GB** |
| Processador | ~2 núcleos | ~0,7 núcleo |
| Banda **entrando** | ~350 Mbps, dia e noite | só a dos canais em uso |
| Banda entrando por dia | **~3,7 TB**, mesmo de madrugada | uma fração disso |

Como fica para o assinante:

- canal **frio** (ninguém via): entra no ar em ~12 s — o app mostra que está entrando no ar;
- canal **morno** (alguém viu nos últimos 5 minutos): entra **na hora**;
- zapear entre canais que a casa costuma ver é instantâneo, porque eles ficam mornos.

Para desligar esse comportamento e deixar tudo sempre ligado, `TV_AO_VIVO_SOB_DEMANDA=0` — mas
só com a memória e a banda da tabela acima sobrando.

---

## Importar a lista do fornecedor de uma vez

A lista chega num texto assim:

```
001 - TV_APARECIDA
Input: srt://45.190.156.152:5000?streamid=#!::r=TV_APARECIDA,m=request latency=2000
```

Salve esse texto num arquivo e rode **no servidor**:

```bash
cd /opt/playtechvip
node scripts/importar-canais.js scripts/canais-fornecedor.txt            # só mostra o que faria
node scripts/importar-canais.js scripts/canais-fornecedor.txt --gravar   # cria os canais
```

Sem `--gravar` ele não toca no banco: lê, confere todos os endereços, mostra quantos canais há
em cada categoria e o que corrigiu. Os canais entram **desligados** — teste antes de ligar.

Ele já faz:

- **número e nome** como na lista (`TV_APARECIDA` vira `TV Aparecida`, `TELE_CINE_FUN` vira
  `Telecine Fun`);
- **categoria** pelo nome (infantil, esportes, filmes, notícias, documentários…);
- **classificação indicativa** nos canais adultos, que já nascem fora do perfil infantil;
- **conserto do endereço** (abaixo).

### O que ele conserta no endereço, e por quê

O endereço que o fornecedor manda vem com dois erros que quebram o canal:

```
veio: srt://45.190.156.152:5000?streamid=#!::r=GLOBO_HD,m=request latency=2000
vai : srt://45.190.156.152:5000?streamid=#!::r=GLOBO_HD,m=request&latency=2000000
```

1. **O espaço antes de `latency`.** Sem o `&`, o ` latency=2000` entra junto no `streamid`, a
   origem não reconhece o nome do canal e recusa a conexão. O erro apareceria como "a origem não
   respondeu", e ninguém adivinharia a causa.
2. **`latency=2000` em milissegundos.** O SRT conta em milissegundos (2000 = 2 s); o ffmpeg conta
   em **microssegundos**. Ao pé da letra, `latency=2000` são 2 ms de buffer — o canal picotaria a
   cada oscilação da rede. Vira `2000000`, que é os 2 s que o fornecedor quis dizer.

---

## Passo a passo no painel

1. **Operação → Canais → Novo canal**
2. Em "Como este canal chega", escolha **"Sinal ao vivo em RTMP ou SRT"**
3. Cole o endereço que o fornecedor passou:
   - `rtmp://origem.do.fornecedor/live/canal1`
   - `srt://10.20.0.9:9000?mode=caller`
4. Deixe **"Canal no ar para os assinantes" desmarcado** por enquanto
5. Salve e clique em **"Testar"** — ele conecta, lê os codecs e responde uma destas coisas:
   - *"Sinal pronto para converter sem perda: H264 1280x720 30fps + AAC."* → pode ligar
   - *"O vídeo vem em H.265…"* → funciona, mas aparelho antigo não abre; vale pedir H.264
   - *"O áudio vem em AC-3…"* → peça AAC, ou o canal sai sem som em parte dos aparelhos
   - *"A origem não respondeu…"* → endereço errado, firewall, ou o sinal não está no ar
6. **Editar → marque "Canal no ar"** → a conversão sobe na hora
7. Em poucos segundos a etiqueta muda para **"convertendo"** e **"sinal ok"**
8. **"Prévia"** abre o canal no player do painel, sem gastar tela do plano

### O que as etiquetas querem dizer

| Etiqueta | O que é |
|---|---|
| `convertendo` + `sinal ok` | está tudo certo, o canal está no ar |
| `conectando` | a conversão subiu e ainda não escreveu o primeiro pedaço |
| `conversão parada` + `sinal com falha` | a origem caiu; passe o mouse na etiqueta para ver o erro |
| `aguardando sinal` | o canal existe mas ninguém cadastrou o endereço |

Canal cuja origem cai **reconecta sozinho**, esperando cada vez um pouco mais (2 s, 4 s, 8 s…
até 1 minuto), para não martelar um sinal que está fora do ar. A linha de baixo mostra quantas
tentativas já houve.

---

## Detalhes que evitam dor de cabeça

- **Testar um canal que já está no ar não toca na origem.** Ele lê o pedaço que a nossa própria
  conversão acabou de escrever. Isso é de propósito: muito fornecedor aceita **uma conexão por
  sinal**, e abrir uma segunda derrubaria o canal no ar justamente quando a operação foi olhar.
- **A pasta `data/ao-vivo` não precisa de backup.** É descartável e se refaz sozinha. Os pedaços
  antigos são apagados conforme saem da lista — ao vivo não guarda histórico.
- **Trocar o endereço de um canal derruba e sobe a conversão de novo**, porque o processo só
  conhece o endereço com que subiu. São alguns segundos fora do ar.
- **Reiniciar o servidor devolve todos os canais ao ar sozinho**, sem ninguém clicar em nada.
- **Endereço de rede interna é aceito** (`rtmp://192.168.0.10/...`). A origem costuma ficar no
  data center do próprio provedor, e quem cadastra aqui é a operação, não o assinante.
- **Teto de canais**: passando de `TV_AO_VIVO_MAX`, os canais além do teto ficam marcados com
  falha e um recado dizendo exatamente isso, em vez de a máquina inteira ficar sem memória.
