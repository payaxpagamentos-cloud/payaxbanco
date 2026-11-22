# Instalar o Manager Provedor no servidor

Destino: **`/provedor`** · Endereço: **https://provedor.meumanager.com.br**

## Antes de começar

1. **O DNS precisa apontar primeiro.** Crie o registro `A` de `provedor.meumanager.com.br` para o IP do
   servidor e espere propagar. Sem isso o certificado TLS não sai — e o script continua, deixando o site
   em HTTP, com o comando para emitir depois.
2. Servidor **Debian 12** ou **Ubuntu 22.04/24.04**, limpo, com acesso root.
3. Mínimo confortável: 2 vCPU, 4 GB de RAM, 40 GB de disco. O banco é SQLite, num arquivo só; o que
   cresce com o tempo são os anexos (fotos de chamado, comprovantes, retornos do banco).

## Instalar

Copie a pasta `network/` do repositório para `/provedor` no servidor e rode:

```bash
cd /provedor
sudo EMAIL_TLS=seu@email.com bash implantar/instalar.sh
```

Ou, deixando o próprio script baixar o código:

```bash
sudo REPO=https://github.com/payaxpagamentos-cloud/payaxbanco.git \
     RAMO=claude/cool-gauss-iekelg \
     EMAIL_TLS=seu@email.com \
     bash instalar.sh
```

O script pode ser rodado de novo quantas vezes quiser: ele só faz o que falta e **não apaga dados**.

## O que ele faz

| Passo | O quê |
|---|---|
| 1 | Instala Node.js 22 (o sistema usa o SQLite embutido do Node, que só existe da 22.13 em diante) |
| 2 | Cria o usuário `provedor`, sem shell, dono de `/provedor` |
| 3 | Instala as dependências (só `express`) |
| 4 | **Gera os segredos uma única vez** em `/provedor/.env` |
| 5 | Aplica as migrações do banco |
| 6 | Sobe o serviço `manager-provedor` no systemd, com reinício automático |
| 7 | Configura o nginx para o domínio e fecha o firewall |
| 8 | Emite o certificado TLS com o certbot, se o DNS já apontar |
| 9 | Agenda o backup diário às 3h10 |

## Primeiro acesso

A senha do administrador é sorteada na instalação e aparece no fim do script. Ela também fica em
`/provedor/.senha-inicial`.

**Troque a senha ao entrar e apague esse arquivo.**

## Os dois segredos que não podem ser perdidos

Estão em `/provedor/.env`:

- **`NETWORK_CHAVE_CREDENCIAIS`** — cifra as senhas de equipamento e as credenciais das integrações
  guardadas no banco. **Perder ou trocar esta chave torna ilegível o que já está guardado**: o sistema
  continua funcionando, mas as senhas dos concentradores e das OLTs precisam ser digitadas de novo, uma
  a uma. Guarde-a junto do backup, e em outro lugar também.
- **`NETWORK_SECRET`** — assina as sessões. Trocar derruba todo mundo que estiver logado. É só isso.

Um backup do banco **sem o `.env`** não restaura a operação. Por isso o script de backup leva os dois.

## O que falta configurar depois

O sistema sobe e funciona sem nada disto, e diz na própria tela o que está faltando em vez de fingir que
está pronto:

| O quê | Onde | Sem isso |
|---|---|---|
| Chave do **Google Maps** | `/provedor/.env` → `NETWORK_GOOGLE_MAPS_CHAVE` | Panorama, rede óptica e frota dizem que falta a chave |
| **Certificado digital A1** da empresa | pela tela: Fiscal → Certificado | Não emite nota fiscal |
| **Cadeia ICP-Brasil** | `/provedor/.env` → `NETWORK_SEFAZ_CA` | Não transmite NFCom (os servidores da SEFAZ são assinados por ela, e ela não vem na lista padrão do sistema) |
| **Endereço da empresa** e responsável técnico | pela tela: Organização e Fiscal | Não emite nota fiscal; a tela lista os campos que faltam |
| **Regras fiscais** conferidas pela contabilidade | pela tela: Fiscal → Regras | O sistema sugere a partir da tabela oficial, mas marca como não conferida |
| Conta bancária e convênio | pela tela: Cobrança | Não emite boleto nem remessa |

### Cadeia ICP-Brasil

```bash
mkdir -p /provedor/dados/certificados
curl -o /provedor/dados/certificados/icp-brasil.pem \
  https://acraiz.icpbrasil.gov.br/credenciadas/CertificadoACRaiz.crt
# ajuste NETWORK_SEFAZ_CA em /provedor/.env para esse caminho e reinicie o serviço
```

## Dia a dia

```bash
systemctl status manager-provedor      # como está
journalctl -u manager-provedor -f      # acompanhar o registro
systemctl restart manager-provedor     # reiniciar

/usr/local/bin/manager-provedor-backup # backup agora
ls -la /var/backups/manager-provedor/  # backups guardados (30 dias)
```

### Atualizar

```bash
cd /provedor
git pull
npm ci --omit=dev
node server/migrar.js
systemctl restart manager-provedor
```

As migrações são numeradas e só aplicam o que falta. Cada uma roda numa transação: se falhar, nada do
que ela fazia fica pela metade.

### Restaurar um backup

```bash
systemctl stop manager-provedor
mkdir -p /tmp/restaurar && tar -xzf /var/backups/manager-provedor/manager-provedor-AAAA-MM-DD-HHMM.tar.gz -C /tmp/restaurar
cp /tmp/restaurar/banco.db /provedor/dados/network.db
cp -a /tmp/restaurar/arquivos /provedor/dados/arquivos
cp /tmp/restaurar/env /provedor/.env        # a chave das credenciais vem daqui
chown -R provedor:provedor /provedor/dados /provedor/.env
systemctl start manager-provedor
```

## Backup fora do servidor

O backup diário fica em `/var/backups/manager-provedor`, **no mesmo disco do sistema**. Isso protege
contra erro humano, não contra perder o servidor. Mande os pacotes para fora — o fim de
`implantar/backup.sh` tem a linha de exemplo com `rclone`, basta descomentar depois de configurar o
destino.
