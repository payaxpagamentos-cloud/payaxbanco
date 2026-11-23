# Instalação no servidor

Servidor desta instalação: **45.190.156.250**, SSH na porta **62052**.

A instalação é um comando. Ele instala o Docker se faltar, sobe a plataforma, emite o
certificado HTTPS, agenda o backup diário e confere tudo no fim.

---

## Antes de começar: três coisas

| O que | Por quê | Quem resolve |
|---|---|---|
| **Domínio apontado para 45.190.156.250** | Sem domínio não há HTTPS, e sem HTTPS o app de celular, o PWA e as Smart TVs não funcionam | Cliente, no painel do DNS |
| **Portas 80 e 443 abertas** | A porta 80 é usada na emissão do certificado; fechada, o HTTPS não sai | Cliente, no firewall do provedor |
| **Usuário com sudo no servidor** | Para instalar o Docker e subir os containers | Cliente |

Se o domínio ainda não existir, dá para subir **agora mesmo em modo de teste**: a instalação usa
um endereço do tipo `45-190-156-250.sslip.io`, que é um DNS público apontando para o próprio IP.
Funciona com HTTPS de verdade e serve para validar tudo; depois é só rodar de novo com o domínio
definitivo.

---

## Caminho A — da sua máquina, em um comando

Na máquina onde está este código (precisa de `ssh` e acesso ao servidor):

```bash
# com o domínio definitivo
bash scripts/enviar-servidor.sh root@45.190.156.250 --porta 62052 play.seudominio.com.br

# ou, para validar agora, sem domínio
bash scripts/enviar-servidor.sh root@45.190.156.250 --porta 62052 --teste
```

Ele copia o código para `/opt/playtechvip` e roda o instalador lá dentro.

## Caminho B — direto no servidor

```bash
ssh -p 62052 root@45.190.156.250

# leve o código para o servidor (git, scp ou o zip da entrega), depois:
cd /opt/playtechvip
sudo bash scripts/instalar-servidor.sh play.seudominio.com.br
```

Antes de valer, dá para ver o que o instalador vai fazer, sem ele mexer em nada:

```bash
sudo bash scripts/instalar-servidor.sh --simular play.seudominio.com.br
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
8. **Cria os dados de demonstração** na primeira instalação (canais, planos e catálogo).
9. **Agenda o backup diário** às 03:20, guardando as 7 cópias mais recentes em
   `/var/backups/playtechvip`.
10. **Roda a conferência** de ponta a ponta e mostra os endereços e a senha do administrador.

> A senha do administrador aparece **uma vez só**, no fim. Anote na hora: no banco ela fica
> cifrada e não há como recuperá-la (só criar outra).

---

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

## Trocar o domínio depois

```bash
cd /opt/playtechvip
sudo sed -i 's|^DOMINIO=.*|DOMINIO=play.definitivo.com.br|' .env
sudo docker compose up -d
```

O certificado do domínio novo é emitido sozinho, em segundos. Os dados ficam todos no lugar.

## Atualizar a plataforma

```bash
bash scripts/enviar-servidor.sh root@45.190.156.250 --porta 62052 --so-enviar
ssh -p 62052 root@45.190.156.250 'cd /opt/playtechvip && sudo docker compose up -d --build'
```

Banco e vídeos ficam no volume `dados` e não são tocados pela atualização.

---

## Se algo der errado

| Sintoma | O que olhar |
|---|---|
| O site não abre, mas o container está de pé | DNS apontando para o IP certo, e 80/443 abertas no firewall do provedor |
| HTTPS não é emitido | `docker compose logs proxy` — quase sempre é a porta 80 fechada ou o DNS ainda não propagado |
| A plataforma não sobe | `docker compose logs app` — em produção ela recusa subir sem `TV_SECRET` e `TV_ADMIN_SENHA` de verdade |
| Vídeo trava no meio | Disco: o conteúdo em exibição precisa estar em NVMe/SSD, não em HDD |
| "no space left on device" | `df -h` e `du -sh /opt/playtechvip/data/midia` — vídeo ocupa muito, veja o documento de requisitos |
