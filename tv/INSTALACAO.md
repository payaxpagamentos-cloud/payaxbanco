# Instalação no servidor

Servidor desta instalação: SSH em **45.190.156.250**, porta **62052**, usuário **playtv**.

Endereço público da plataforma: **45.190.156.169** — é esse IP que o provedor encaminha para
as portas 80 e 443 desta máquina, e é ele que o domínio definitivo deve apontar.

A instalação é um comando. Ele instala o Docker se faltar, sobe a plataforma, emite o
certificado HTTPS, agenda o backup diário e confere tudo no fim.

---

## Antes de começar: três coisas

| O que | Por quê | Quem resolve |
|---|---|---|
| **Domínio apontado para 45.190.156.250** | Sem domínio não há HTTPS, e sem HTTPS o app de celular, o PWA e as Smart TVs não funcionam | Cliente, no painel do DNS |
| **Portas 80 e 443 abertas** | A porta 80 é usada na emissão do certificado; fechada, o HTTPS não sai | Cliente, no firewall do provedor |
| **Usuário com sudo no servidor** | Para instalar o Docker e subir os containers. Aqui é o `playtv` — ele precisa poder usar `sudo` | Cliente |

**Sem o domínio, dá para subir hoje.** Com `--sem-dominio`, a instalação usa um endereço do tipo
`45-190-156-250.sslip.io` — um DNS público que aponta para o próprio IP. O HTTPS é real (o
certificado é emitido normalmente), tudo funciona, e quando o domínio definitivo chegar a troca
é de duas linhas, sem perder dado nenhum nem reinstalar.

Nesse modo o login da operação fica em `admin@playtechvip.com.br`, e **não** no endereço
provisório — assim o acesso continua o mesmo depois da troca de domínio.

---

## Caminho A — da sua máquina, em um comando

Na máquina onde está este código (precisa de `ssh` e acesso ao servidor):

```bash
# agora, sem domínio (é o caso desta instalação)
bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 --sem-dominio

# depois, com o domínio definitivo
bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 play.seudominio.com.br
```

Ele copia o código para `/opt/playtechvip` e roda o instalador lá dentro.

## Caminho B — direto no servidor

```bash
# 1. mande o pacote da entrega para o servidor
scp -P 62052 PLAYTECHVIP-servidor.tar.gz playtv@45.190.156.250:/tmp/

# 2. entre, descompacte e instale
ssh -p 62052 playtv@45.190.156.250
sudo mkdir -p /opt/playtechvip
sudo tar -C /opt/playtechvip -xzf /tmp/PLAYTECHVIP-servidor.tar.gz
sudo chmod +x /opt/playtechvip/scripts/*.sh
cd /opt/playtechvip
sudo bash scripts/instalar-servidor.sh --sem-dominio      # ou o domínio, quando houver
```

Antes de valer, dá para ver o que o instalador vai fazer, sem ele mexer em nada:

```bash
sudo bash scripts/instalar-servidor.sh --simular --sem-dominio
```

---

## O que o instalador faz, passo a passo

1. **Confere o servidor** — sistema, arquitetura, memória e disco livre, avisando o que estiver
   abaixo do recomendado.
2. **Confere o domínio** — descobre o IP público e avisa se o DNS ainda não aponta para cá.
3. **Instala o Docker**, se não houver, pelo script oficial da Docker.
4. **Copia o código** para `/opt/playtechvip` (sem `node_modules`, sem `data`, sem chaves).
5. **Gera o `.env`** com segredo de sessão e senha de administrador novos, aleatórios. Se já
   existir um `.env`, ele é mantido — rodar de novo nunca troca o segredo nem derruba sessão.
6. **Libera 80, 443 e a porta do SSH** no `ufw`, quando ele estiver ativo.
7. **Sobe a plataforma** com `docker compose up -d --build` e espera ela responder.
8. **Cria os dados de demonstração** na primeira instalação (canais, planos e catálogo). Essa
   parte roda **solta no servidor**: se a conexão cair, ela continua. Acompanhe com
   `sudo docker compose exec -T app tail -f /app/data/seed.log`. Para pular, use `--sem-demo`.
9. **Agenda o backup diário** às 03:20, guardando as 7 cópias mais recentes em
   `/var/backups/playtechvip`.
10. **Roda a conferência** de ponta a ponta e mostra os endereços e a senha do administrador.

> A senha do administrador aparece **uma vez só**, no fim. Anote na hora: no banco ela fica
> cifrada e não há como recuperá-la (só criar outra).

---

## A conexão caiu no meio

Não tem problema: os contêineres rodam soltos e a plataforma continua no ar. Entre de novo e
confira em que pé está:

```bash
ssh -o ServerAliveInterval=30 -p 62052 playtv@45.190.156.250
cd /opt/playtechvip
sudo docker compose ps                                       # está no ar?
sudo docker compose exec -T app tail -20 /app/data/seed.log  # o catálogo terminou?
```

Para evitar a queda, use `ssh -o ServerAliveInterval=30` — ele manda um sinal de vida a cada 30
segundos e impede que o roteador ou o provedor derrubem a sessão ociosa.

## Ver a plataforma antes de liberar o acesso externo

Enquanto o provedor não encaminha as portas 80 e 443 para o servidor, dá para conferir tudo por
um **túnel SSH** — a plataforma escuta em `127.0.0.1:3600` dentro do servidor, sem ficar exposta:

```bash
ssh -p 62052 -L 3600:127.0.0.1:3600 playtv@45.190.156.250
```

Deixe essa janela aberta e abra no navegador do seu computador:

```
http://localhost:3600/          app do assinante
http://localhost:3600/admin/    painel da operação
```

É a plataforma de verdade, rodando no servidor. Só o HTTPS fica de fora (o túnel é local), então
a instalação do app no celular e o acesso pela Smart TV continuam dependendo das portas abertas.

## Depois que subir

```bash
# acessos
https://SEU-DOMINIO/          app do assinante
https://SEU-DOMINIO/admin/    painel da operação

# no servidor
cd /opt/playtechvip
docker compose logs -f app            # acompanhar
docker compose restart app            # reiniciar
BASE=https://SEU-DOMINIO bash scripts/conferir-instalacao.sh   # conferir de novo
```

**Os três primeiros ajustes no painel**, pela ordem:

1. **Equipe** → trocar a senha do administrador e criar os acessos da operação.
2. **Canais** → colar o endereço do sinal (`.m3u8`) de cada emissora e ligar os canais.
   Os 15 canais abertos já vêm cadastrados e desligados, esperando o sinal.
3. **Configurações** → cadastrar o endereço do XMLTV da grade, para a programação se manter
   sozinha, e o token do TMDB, para o catálogo trazer capa e ficha dos títulos.

## Emitir o certificado quando as portas liberarem

Com as portas 80 e 443 chegando no servidor, um comando resolve — ele confere se o mundo
realmente enxerga esta máquina pelo domínio, limpa a tentativa travada no servidor de testes da
Let's Encrypt e acompanha a emissão:

```bash
cd /opt/playtechvip
sudo bash scripts/certificado.sh                      # usa o domínio atual
sudo bash scripts/certificado.sh play.dominio.com.br  # troca o domínio e emite
```

Se quem responder no domínio não for a plataforma, ele para e diz isso — é o sinal de que o
tráfego ainda vai para outra máquina.

## Trocar o domínio depois

É o que vai acontecer nesta instalação, assim que o cliente informar o endereço.

```bash
cd /opt/playtechvip
sudo sed -i 's|^DOMINIO=.*|DOMINIO=play.definitivo.com.br|' .env
sudo docker compose up -d
```

O certificado do domínio novo é emitido sozinho, em segundos. Os dados ficam todos no lugar.

## Atualizar a plataforma

```bash
bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 --so-enviar
ssh -p 62052 -t playtv@45.190.156.250 \
  'sudo tar -C /opt/playtechvip -xzf /tmp/playtechvip.tar.gz && cd /opt/playtechvip && sudo docker compose up -d --build'
```

Banco e vídeos ficam no volume `dados` e não são tocados pela atualização.

---

## Se algo der errado

| Sintoma | O que olhar |
|---|---|
| `sudo` pede senha e o envio para | Use o caminho A: ele abre um terminal de verdade no passo da instalação, e a senha pode ser digitada |
| `acme-challenge ... 404` no log do proxy, vindo de outro IP | O tráfego que entra no IP público não chega neste servidor (NAT do provedor). Peça o encaminhamento das portas 80 e 443 para esta máquina |
| Abre "Not found" ou um certificado de outro domínio | Outro serviço está com as portas 80/443. Veja `sudo ss -tlnp \| grep -E ':80 \|:443 '` — o instalador agora detecta isso e para antes de subir |
| O site não abre, mas o container está de pé | DNS apontando para o IP certo, e 80/443 abertas no firewall do provedor |
| HTTPS não é emitido | `docker compose logs proxy` — quase sempre é a porta 80 fechada ou o DNS ainda não propagado |
| A plataforma não sobe | `docker compose logs app` — em produção ela recusa subir sem `TV_SECRET` e `TV_ADMIN_SENHA` de verdade |
| Vídeo trava no meio | Disco: o conteúdo em exibição precisa estar em NVMe/SSD, não em HDD |
| "no space left on device" | `df -h` e `du -sh /opt/playtechvip/data/midia` — vídeo ocupa muito, veja o documento de requisitos |
