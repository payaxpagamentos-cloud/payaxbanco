# Colocar o site da LK TECH no ar (VPS HostGator)

Este guia leva o site para `https://lktechprovedor.com.br` em um VPS da HostGator. Também funciona em outro provedor com Ubuntu, como a Hostinger.
O site é independente: no VPS roda só ele, sem ligação com os outros sistemas.

## 1. Configurar o VPS na HostGator

- **Sistema:** escolha **Ubuntu** (22.04 ou 24.04, o mais novo que aparecer).
  - **Não use AlmaLinux nem Rocky Linux:** o instalador é para Ubuntu.
  - **Sem cPanel:** o cPanel ocupa as portas do site e o instalador para com um aviso.
  - Se o VPS já foi entregue com outro sistema ou com cPanel, peça à HostGator (ou faça pelo painel do VPS) a reinstalação com Ubuntu puro.
- **Firewall do painel da HostGator:** se o painel do VPS tiver uma área de firewall ou de regras de rede, libere as portas **22** (SSH), **80** (HTTP) e **443** (HTTPS). O instalador libera as portas dentro do servidor, mas não consegue mexer nesse firewall externo.
- **Acesso:** anote o **IP do VPS** e o acesso SSH que a HostGator entregou. Pode ser o usuário `root` com senha, ou um usuário como `ubuntu` com chave ou senha.

## 2. Enviar a pasta do site para o VPS

Você precisa da pasta `lktech` deste repositório. Escolha uma forma:

**Pelo programa FileZilla (mais simples):**
1. Baixe o repositório do GitHub em ZIP e extraia.
2. No FileZilla, use servidor `sftp://IP-DO-VPS`, porta `22` e o usuário e a senha (ou a chave) entregues pela HostGator.
3. Arraste a pasta `lktech` para a pasta inicial do usuário: `/root/` se entrou como root, ou `/home/ubuntu/` se entrou como `ubuntu`.

**Pelo terminal (se já tiver o repositório no computador):**
```bash
scp -r lktech USUARIO@IP-DO-VPS:~/
```

## 3. Rodar o instalador

Entre no VPS (`ssh USUARIO@IP-DO-VPS`) e rode:

```bash
cd ~/lktech
sudo bash implantacao/instalar.sh
```

(Se entrou como `root`, o `sudo` é opcional.)

O instalador:

- confere se o VPS está pronto: Ubuntu, sem cPanel e com as portas do site livres;
- instala o Node.js 24, o Caddy (HTTPS automático) e o firewall;
- libera as portas do site também nas regras de rede da nuvem da Oracle, que a HostGator usa;
- confere o código e roda os testes **antes** de ligar;
- instala o site em `/opt/lktech`, com dados em `/var/lib/lktech`;
- deixa o site ligando sozinho e reiniciando se cair;
- agenda **backup diário** às 03h30 em `/var/backups/lktech` (guarda 30 dias);
- no final, pede o **e-mail do administrador** e uma **senha** (mínimo de 12 caracteres, não aparece na tela).

Leva poucos minutos. No fim, ele mostra o IP para o próximo passo.

## 4. Apontar o domínio para o VPS

Só faça isto **depois** que o instalador terminar sem erro.

O e-mail @lktechprovedor.com.br (Titan) continua funcionando nas duas opções, desde que siga a tabela.

**Opção 1: pelo Editor de Zona da HostGator** (o DNS continua lá)

No cPanel da HostGator → **Editor de Zona** → `lktechprovedor.com.br`:

| Tipo | Nome | Trocar para |
|---|---|---|
| A | `lktechprovedor.com.br` | IP do VPS |
| A ou CNAME | `www` | registro A com o IP do VPS (ou CNAME para `lktechprovedor.com.br`) |

Não mexa nos registros MX, TXT, `mail` e `webmail`.

**Opção 2: pelo registro.br** (o DNS sai da HostGator)

Em registro.br → `lktechprovedor.com.br` → **DNS** → usar os servidores DNS do Registro.br, e crie **todos** estes registros:

| Tipo | Nome | Valor |
|---|---|---|
| A | (vazio) | IP do VPS |
| A | www | IP do VPS |
| MX | (vazio) | `mx1.titan.email`, prioridade 10 |
| MX | (vazio) | `mx2.titan.email`, prioridade 20 |
| TXT | (vazio) | `v=spf1 include:spf.titan.email ~all` |
| TXT | titan1._domainkey | copiar o valor do Editor de Zona da HostGator |
| TXT | default._domainkey | copiar o valor do Editor de Zona da HostGator |
| TXT | _dmarc | `v=DMARC1; p=none;` |

A mudança pode levar algumas horas para valer em todos os lugares.

## 5. HTTPS e conferência

Se o site não abrir pelo IP ou o HTTPS não ativar, confira se as portas 80 e 443 estão liberadas no firewall do painel da HostGator (passo 1).

Quando o domínio estiver apontando para o VPS, o HTTPS é ativado **sozinho** em alguns minutos (Caddy + Let's Encrypt), para `lktechprovedor.com.br` e `www`.

Confira:

- `https://lktechprovedor.com.br` abre o site com cadeado;
- `https://www.lktechprovedor.com.br` leva para o endereço sem `www`;
- `https://lktechprovedor.com.br/admin` abre o painel e o login funciona.

Depois, preencha no painel os dados reais (planos, preços, WhatsApp, links da Área do Cliente e da segunda via, CEPs) e clique em **Publicar**.

## Atualizar o site

Envie a pasta `lktech` nova para o VPS (substituindo a antiga) e rode de novo:

```bash
cd ~/lktech
sudo bash implantacao/instalar.sh
```

Os dados (conteúdo do painel, imagens, contatos recebidos, administradores) são mantidos. Antes de trocar, o instalador roda os testes e faz um backup. Se a versão nova não ligar, a anterior volta sozinha.

## Comandos úteis no VPS

Se não entrou como `root`, coloque `sudo` antes de cada comando.

| Para | Comando |
|---|---|
| Ver se o site está ligado | `systemctl status lktech` |
| Ver as mensagens do site | `journalctl -u lktech -f` |
| Reiniciar o site | `systemctl restart lktech` |
| Fazer um backup agora | `systemctl start lktech-backup` |
| Ver os backups | `ls /var/backups/lktech` |
| Criar outro administrador | `lktech-admin email@empresa.com.br` |
| Trocar a senha de um administrador | `lktech-admin email@empresa.com.br --reset` |
| Ver o HTTPS | `journalctl -u caddy -f` |

## Restaurar um backup

```bash
systemctl stop lktech
rm -f /var/lib/lktech/site.sqlite-wal /var/lib/lktech/site.sqlite-shm
cp /var/backups/lktech/PASTA-DO-BACKUP/site.sqlite /var/lib/lktech/site.sqlite
rm -rf /var/lib/lktech/uploads && cp -r /var/backups/lktech/PASTA-DO-BACKUP/uploads /var/lib/lktech/uploads
chown -R lktech:lktech /var/lib/lktech
systemctl start lktech
```

Guarde também uma cópia dos backups fora do VPS (por exemplo, baixando pelo FileZilla de tempos em tempos).

## Campanhas prontas (ex.: Black Friday)

A pasta `conteudo/` tem campanhas prontas: banners, planos e preços. Para colocar uma no painel:

```bash
sudo lktech-conteudo black-friday
```

O conteúdo vai para o **rascunho**. Nada vai ao ar sozinho: entre no painel, confira em **Ver prévia** e clique em **Publicar**. Depois, tudo continua editável pelo painel, como sempre.

Para ver as campanhas disponíveis, rode `sudo lktech-conteudo` sem nome.
