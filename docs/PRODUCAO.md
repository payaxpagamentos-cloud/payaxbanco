# Colocando o Banqueiro PAY AX em produção

Este guia leva o sistema do código para um endereço real com HTTPS. Caminho recomendado: um **servidor
em nuvem no Brasil** com Docker. O Caddy faz o HTTPS automático e separa os dois domínios:

| Domínio (exemplo) | Quem usa | O que fica exposto |
|---|---|---|
| `internetbanking.payax.com.br` | Clientes | Só o Internet Banking (`/ib/`), a API do cliente e o webhook PIX |
| `banqueiro.payax.com.br` | Equipe PAY AX | O Banqueiro completo (recomendado restringir por IP ou VPN) |

## 1. Antes de começar (decisões do negócio)

- [ ] **Regulatório:** validar com especialista e com o Bradesco o modelo de conta única guardando saldo de clientes (autorização do Banco Central como instituição de pagamento, segregação de recursos e termos do contrato da conta PJ).
- [ ] **LGPD:** política de privacidade, termos de uso do Internet Banking e encarregado de dados (DPO).
- [ ] **Bradesco:** contrato das APIs, credenciais, certificado e-CNPJ A1 e homologação no sandbox.
- [ ] **Teste de segurança (pentest)** por empresa independente antes de abrir para clientes reais.

## 2. Servidor

- **Onde:** provedor com região em São Paulo. Exemplos: AWS (sa-east-1), Google Cloud (southamerica-east1), Azure (Brazil South), Magalu Cloud ou outra VPS nacional.
- **Tamanho para começar:** 2 vCPU, 2 a 4 GB de RAM e 40 GB de disco, com Ubuntu 24.04 LTS.
- **Instale o Docker:** `curl -fsSL https://get.docker.com | sh`.
- **Firewall:** libere apenas as portas 22 (SSH, de preferência só do seu IP), 80 e 443.

## 3. Domínios

No painel de DNS do domínio da PAY AX, crie dois registros **tipo A** apontando para o IP do servidor:
`internetbanking` e `banqueiro`.

## 4. Implantar

```bash
git clone https://github.com/payaxpagamentos-cloud/payaxbanco.git
cd payaxbanco
cp .env.example .env
nano .env          # preencha domínios, segredos (openssl rand -hex 32) e senha do administrador
docker compose up -d --build
docker compose logs -f banqueiro
```

Em cerca de um minuto, o Caddy emite os certificados e os dois endereços abrem com HTTPS.
Entre no Banqueiro com o e-mail e a senha de administrador definidos no `.env` e **troque a senha**.

> **Importante:** guarde `PAYAX_SECRET` e principalmente `PAYAX_PEPPER` num cofre de senhas. Se o
> `PAYAX_PEPPER` mudar ou se perder, todas as senhas de clientes deixam de funcionar.

## 5. Backups (obrigatório)

O banco fica no volume `dados`. Agende um backup diário no servidor (`crontab -e`):

```cron
15 3 * * * cd /root/payaxbanco && docker compose exec -T banqueiro npm run backup >> /var/log/payax-backup.log 2>&1
```

Os backups ficam em `/app/data/backups` (os últimos 14). Copie-os também para fora do servidor
(por exemplo, um bucket S3 com criptografia) e **teste a restauração** periodicamente:

```bash
docker compose stop banqueiro
docker compose cp ./banqueiro-AAAAMMDD-HHMM.db banqueiro:/app/data/banqueiro.db
docker compose start banqueiro
```

## 6. Atualizar para uma nova versão

```bash
git pull
docker compose exec -T banqueiro npm run backup
docker compose up -d --build
```

As novas tabelas e colunas são criadas automaticamente ao iniciar.

## 7. Ligar o Bradesco

1. Copie o certificado `.pfx` para o volume: `docker compose cp certificado.pfx banqueiro:/app/data/certificado.pfx`.
2. No `.env`, troque `BRADESCO_MODO=sandbox` e preencha URLs, credenciais, `BRADESCO_CERT_PFX=/app/data/certificado.pfx`, a chave PIX e o `BRADESCO_WEBHOOK_TOKEN` (`openssl rand -hex 32`).
3. Rode `docker compose up -d`. No Banqueiro, em **Bradesco**, faça uma cobrança de teste.
4. Cadastre o webhook no Bradesco: `https://internetbanking.payax.com.br/api/integracoes/bradesco/webhook?token=SEU_TOKEN`.
5. Depois da homologação, troque para `BRADESCO_MODO=producao`.

## 8. Monitoramento

- **Saúde:** monitore `https://internetbanking.payax.com.br/api/saude`, por exemplo com UptimeRobot ou Better Stack, com alerta por e-mail ou celular.
- **Logs:** `docker compose logs --since 1h banqueiro`.
- **Diário:** confira a tela **Bradesco → Conciliação**. A diferença deve ser explicável.

## 9. Quando crescer

O SQLite atende bem uma instalação única com milhares de clientes. Migre para **PostgreSQL** quando
for necessário:
- rodar mais de um servidor;
- ter alta disponibilidade;
- volumes muito altos de transações.

Nesse caso, troque também o limitador de tentativas em memória por um compartilhado (Redis).
