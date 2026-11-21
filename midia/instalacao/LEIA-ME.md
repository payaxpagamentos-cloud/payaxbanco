# Instalação no servidor — Ubuntu 24.04 LTS

Esta pasta põe o Vai Mídia no ar numa máquina limpa: o site, o painel da equipe, os portais do
anunciante e do síndico, o player das TVs e o servidor de e-mail da caixa do CRM. Tudo atrás do nginx,
com HTTPS do Let's Encrypt, subindo sozinho quando a máquina reinicia.

| Arquivo | O que é |
|---|---|
| `instalar.sh` | A instalação inteira, de uma vez. Pode rodar de novo sem medo. |
| `atualizar.sh` | Troca o código por uma versão nova, guardando antes uma cópia do banco. |
| `vaimidia.service` | O serviço do systemd (quem mantém o sistema no ar). |
| `nginx-vaimidia.conf` | O nginx na frente, com o tamanho de envio certo para vídeo. |

## O que a máquina precisa ter

- **Ubuntu 24.04 LTS** (testado nela; em outra versão pode faltar pacote).
- **1 vCPU e 2 GB de RAM** dão conta de uma rede pequena; o disco é o que importa, porque criativo é
  vídeo — comece com **40 GB** e acompanhe pelo *Diagnóstico*.
- **IP fixo** e acesso root (sudo).
- O **domínio apontando para o IP** antes de pedir o certificado.

## Antes de rodar: o DNS

Crie estes registros no painel do seu domínio. Sem eles o HTTPS não sai e o e-mail não entra.

| Tipo | Nome | Valor |
|---|---|---|
| A | `vaimidia.com.br` | o IP do servidor |
| A | `www.vaimidia.com.br` | o IP do servidor |
| MX | `vaimidia.com.br` | `vaimidia.com.br`, prioridade 10 |
| TXT | `vaimidia.com.br` | `v=spf1 ip4:SEU.IP -all` |
| TXT | `vaimidia._domainkey.vaimidia.com.br` | a chave DKIM que a instalação imprime no fim |
| TXT | `_dmarc.vaimidia.com.br` | `v=DMARC1; p=none; rua=mailto:postmaster@vaimidia.com.br` |

Duas coisas que **só o provedor da máquina resolve**: o **DNS reverso (PTR)** do IP apontando para o
domínio, e a **porta 25 liberada na entrada** — quase toda nuvem bloqueia a 25 por padrão e abre a pedido.

## Instalar

```bash
# na máquina, com o código já copiado (git clone ou scp)
cd midia/instalacao
sudo ./instalar.sh --dominio vaimidia.com.br --email voce@vaimidia.com.br
```

No fim ele mostra **a senha do master** (só desta vez — anote) e a lista do que falta no DNS, já com a
chave DKIM pronta para copiar.

Opções úteis:

```bash
sudo ./instalar.sh --dominio vaimidia.com.br --simular     # mostra tudo o que faria, sem mexer em nada
sudo ./instalar.sh --dominio vaimidia.com.br --sem-tls     # sem certificado agora (fica em HTTP)
sudo ./instalar.sh --dominio vaimidia.com.br --sem-email   # sem o servidor de e-mail
```

Rodar de novo é seguro: a configuração, as senhas e a chave DKIM que já existem não são tocadas.

## Depois

```
Site .............. https://vaimidia.com.br
Painel ............ https://vaimidia.com.br/midia/
Player das TVs .... https://vaimidia.com.br/midia/tv/
```

```bash
sudo systemctl status vaimidia      # está no ar?
sudo journalctl -u vaimidia -f      # o que está acontecendo agora
sudo nano /etc/vaimidia/vaimidia.env && sudo systemctl restart vaimidia
```

**Para o sistema responder e-mail**, preencha `MIDIA_SMTP_*` em `/etc/vaimidia/vaimidia.env` com um
provedor (Google Workspace, Zoho, Amazon SES) e reinicie. Receber pelo servidor próprio é tranquilo;
**mandar** e chegar na caixa de entrada depende de reputação de IP, que leva meses — por isso a
recomendação é receber aqui e enviar por um provedor.

## Onde ficam as coisas

| | |
|---|---|
| Sistema | `/opt/vaimidia` |
| Configuração e chave DKIM | `/etc/vaimidia/` |
| Banco, criativos, e-mails e backups | `/var/lib/vaimidia/` |
| Serviço | `/etc/systemd/system/vaimidia.service` |
| nginx | `/etc/nginx/sites-available/vaimidia` |

O backup do banco roda sozinho a cada 24 h, guardando as 30 cópias mais recentes em
`/var/lib/vaimidia/backups`. **Isso não é backup de verdade enquanto estiver no mesmo disco**: aponte
`MIDIA_ESPELHO` para outro volume, ou leve a pasta para fora da máquina.

## Atualizar

```bash
cd midia/instalacao
sudo ./atualizar.sh
```

Copia o código novo, reinstala as dependências e reinicia — sem tocar na configuração, no banco nem nos
criativos. Antes de trocar qualquer coisa, guarda uma cópia do banco em
`/var/lib/vaimidia/backups/antes-da-atualizacao-*.db`.

## Quando alguma coisa não sobe

| Sintoma | Onde olhar |
|---|---|
| O site não abre | `sudo systemctl status vaimidia` e `sudo journalctl -u vaimidia -n 80` |
| Erro 502 no navegador | o serviço caiu; o journal diz por quê |
| O certificado não saiu | o DNS ainda não propagou. Repita: `sudo certbot --nginx -d vaimidia.com.br` |
| Não chega e-mail | de fora da máquina: `nc -vz vaimidia.com.br 25`. Se não entra, é a porta 25 no provedor |
| E-mail enviado cai no spam | falta SPF/DKIM/PTR, ou o IP é novo — use um provedor no `MIDIA_SMTP_*` |
| Envio de criativo falha | vídeo acima de 200 MB (`MIDIA_MAX_MB`) ou disco cheio: veja o *Diagnóstico* |
