# PAY AX Pagamentos — servidor

Guia para contratar o servidor, instalar o sistema e crescer por etapas, sem refazer nada no caminho.

## A regra que define tudo

**Só um servidor ativo por vez.** As rotinas automáticas (PIX a cada 15 minutos, remessa e retorno do banco)
rodando em dois servidores pagariam o cliente duas vezes. Por isso a redundância aqui é *um ativo e uma reserva
pronta*, não dois ativos ao mesmo tempo. Os scripts recusam subir um segundo ativo sem confirmação.

## As etapas

| Etapa | Quando | O que tem | Se o servidor cair |
|---|---|---|---|
| **1 — Principal** (agora) | Homologação com o Bradesco e primeiros clientes | 1 servidor em São Paulo, cópia contínua do banco no S3 (a cada ~1 s), cópia das pastas a cada 15 min, backup conferido a cada 12 h, recuperação automática de hardware do AWS | Falha de hardware: o AWS religa sozinho. Servidor perdido: um novo é montado com o mesmo script e restaura a cópia — **30 a 60 min**, perda de **segundos** |
| **2 — Reserva** | Antes de muitos clientes em produção | + 1 servidor reserva já instalado e **desligado** (paga só o disco) | Liga a reserva e roda `assumir.sh` — **10 a 15 min**, perda de **segundos** |
| **3 — Alta disponibilidade** | Volume alto, ou a PAY AX virando instituição autorizada | Banco PostgreSQL gerenciado em duas zonas + 2 servidores, um só rodando as rotinas | Troca automática, em minutos. Exige mudança no código (banco SQLite → PostgreSQL) |

Etapas 1 e 2 usam os mesmos scripts desta pasta. A 3 é um projeto à parte, quando chegar a hora.

## Onde: duas opções, o mesmo instalador

| | **A — Econômica (recomendada para começar)** | **B — AWS** |
|---|---|---|
| Servidor | VPS com data center em **São Paulo** (ex.: Hostinger KVM 2: 2 vCPU, 8 GB, 100 GB) | EC2 `t4g.small` em São Paulo |
| Cópias do banco | **Magalu Cloud Object Storage**, região `br-se1` (São Paulo) | S3 em São Paulo |
| Segredos do sistema | Cifrados com uma **frase de recuperação** da PAY AX, guardados junto das cópias | Parameter Store do AWS |
| Custo/mês (ordem de grandeza) | **~R$ 40 a 60** (VPS no plano anual + centavos de armazenamento) | ~US$ 25 a 35 |
| Recuperação automática de hardware | Depende do provedor | Sim (alarme do passo 7) |
| Crescer | Trocar de plano no painel do provedor | Trocar o tipo da máquina |

**Os dois mantêm os dados no Brasil** — as cópias levam nome e CPF de pagadores, e guardar no exterior traria as
exigências de transferência internacional da LGPD. Preços de VPS costumam ser promocionais no primeiro ciclo
(plano anual) e subir na renovação: confira no site do provedor antes de contratar.

Daqui a pouco, quando o volume e o caixa pedirem, migra-se para B sem reinstalar nada: o instalador é o mesmo e a
cópia contínua leva o banco junto.

---

## Opção A, passo a passo

### A1. Servidor (VPS)
1. Contrate um VPS com **data center em São Paulo**, **Ubuntu 24.04**, pelo menos **2 vCPU e 4 GB** e **IPv4 dedicado**
   (fixo) — é o IP que vai para o Bradesco e para os IXC.
2. No painel do provedor: ative a **verificação em duas etapas** da conta e cadastre uma **chave SSH** para o acesso
   (em vez de senha).
3. No DNS do domínio, crie o registro **A**: `pagamentos` → o IP do VPS.

### A2. Armazenamento das cópias (Magalu Cloud)
1. Crie a conta em **magalu.cloud** com o CNPJ da PAY AX (cobrança em reais).
2. **Object Storage → Criar bucket**, região **br-se1 (São Paulo)**, privado. Nome ex.: `payax-pagamentos-copias`.
3. Crie uma **chave de API com acesso ao Object Storage** (leitura e gravação). O painel mostra a *Key ID* e a
   *Key Secret* — tenha as duas à mão na instalação; não envie por e-mail nem mensagem.

### A3. Instalar
1. Envie o pacote para o servidor (pelo gerenciador de arquivos do painel do provedor, ou `scp`).
2. Entre no servidor (terminal do painel ou SSH) e rode, trocando os valores:

```bash
cd /root && tar xzf payax-pagamentos-*.tar.gz && cd payax-pagamentos-*/
sudo ./implantacao/instalar.sh --dominio pagamentos.payax.com.br --bucket payax-pagamentos-copias \
  --email-admin ti@payax.com.br --endpoint https://br-se1.magaluobjects.com --regiao br-se1
```

O instalador pede:
- a **Key ID** e a **Key Secret** do Magalu (ficam só no servidor, legíveis só pelo administrador);
- uma **frase de recuperação** (mín. 16 caracteres), duas vezes. **Guarde num cofre da empresa**: sem ela, um servidor
  novo não consegue ler as credenciais do banco gravadas no sistema.

No fim ele **confere se a cópia do banco chegou** ao armazenamento e mostra a senha inicial do administrador.
Depois, siga o *Primeiro acesso* (passo 9 da opção B — é igual).

**Se o servidor cair (opção A):** contrate/recrie um VPS, aponte o DNS para o novo IP (e avise o Bradesco e os
IXC), envie o pacote e rode o mesmo comando com **`--anterior-desligado`**. Ele pede a frase de recuperação,
restaura o banco de segundos atrás e sobe.

---

## Opção B (AWS)

- **São Paulo (`sa-east-1`)**: os dados ficam no Brasil e a latência até o Bradesco e os IXC é baixa.
- Tem tudo o que as três etapas precisam: servidor (EC2), armazenamento (S3), IP fixo, cofre de segredos e, na
  etapa 3, PostgreSQL gerenciado em duas zonas.
- O AWS fatura clientes brasileiros em reais, com nota fiscal — confirme na contratação.
- **Custo da etapa 1 (configuração de início)**, ordem de grandeza: **US$ 25 a 35 por mês** — servidor `t4g.small`
  (2 vCPU, 2 GB, processador ARM, o mais barato que roda o sistema com folga), disco de 30 GB, IP fixo e as cópias
  no S3 (centavos). Contas novas do AWS costumam ganhar créditos de boas-vindas. Confira na calculadora do AWS
  (calculator.aws) antes de contratar.
- **Crescer é trocar o tamanho, não reinstalar**: com a máquina desligada, *Ações → Configurações da instância →
  Alterar tipo* (ex.: `t4g.medium`, 4 GB) e aumentar o disco em *Volumes → Modificar*. Minutos, sem perder nada.
- A reserva da etapa 2, desligada, custa só o disco (poucos dólares).

## Opção B: o que ter em mãos

1. CNPJ e cartão de crédito da PAY AX.
2. Acesso ao DNS do domínio (onde o `payax.com.br` está registrado), para criar `pagamentos.payax.com.br`.
3. Um e-mail da PAY AX para o administrador do sistema (ex.: `ti@payax.com.br`).
4. O pacote de instalação (`payax-pagamentos-AAAAMMDD-HHMM.tar.gz`) — gerado com `npm run empacotar`.

---

## Opção B, passo a passo

### 1. Conta AWS
1. Em **aws.amazon.com/pt**, *Criar uma conta da AWS*, com os dados da PAY AX (CNPJ).
2. Entre como usuário raiz e ative a **MFA** (autenticação em duas etapas): canto superior direito → *Credenciais
   de segurança* → *Atribuir dispositivo de MFA*.
3. Em **Billing → Budgets**, crie um orçamento mensal com alerta por e-mail (ex.: US$ 50). Evita surpresa na fatura.
4. No canto superior direito do console, escolha a região **América do Sul (São Paulo)**. Tudo abaixo é nela.

### 2. Bucket S3 (onde ficam as cópias)
**S3 → Criar bucket**:
- Nome: único no mundo, ex.: `payax-pagamentos-copias` (anote: é o `--bucket` da instalação).
- Região: São Paulo. **Bloquear todo o acesso público**: ligado. **Versionamento**: ativado. **Criptografia**: padrão (SSE-S3).
- Dentro dele, crie a pasta `instalacao`.

### 3. Papel do servidor (permissões sem senha em disco)
**IAM → Funções → Criar função** → *Serviço da AWS* → *EC2*:
1. Anexe a política gerenciada **AmazonSSMManagedInstanceCore** (permite abrir o terminal pelo navegador).
2. Nome: **PayaxPagamentosServidor**. Crie.
3. Abra a função → *Adicionar permissões* → *Criar política em linha* → aba JSON, cole o texto abaixo trocando
   `NOME-DO-BUCKET` e `NUMERO-DA-CONTA` (12 dígitos, no canto superior direito do console). Nome: `payax-pagamentos`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::NOME-DO-BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::NOME-DO-BUCKET/*" },
    { "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:PutParameter"],
      "Resource": "arn:aws:ssm:sa-east-1:NUMERO-DA-CONTA:parameter/payax/pagamentos/*" }
  ]
}
```

### 4. O servidor
**EC2 → Executar instância**:
- Nome: `payax-pagamentos-1`.
- Imagem: **Ubuntu Server 24.04 LTS**, arquitetura **64 bits (Arm)**.
- Tipo: **t4g.small** (2 vCPU, 2 GB). Quando o volume pedir, troque para `t4g.medium` sem reinstalar.
- Par de chaves: *Prosseguir sem um par de chaves* — o acesso é pelo navegador (Session Manager), sem porta SSH aberta.
- Rede: *Criar grupo de segurança* permitindo **HTTPS** e **HTTP** de qualquer lugar. **Desmarque o SSH.**
- Armazenamento: **30 GB, gp3, criptografado** (dá para aumentar depois sem desligar).
- Detalhes avançados: *Perfil de instância do IAM* = **PayaxPagamentosServidor**; *Proteção contra encerramento* = ativada.

### 5. IP fixo
**EC2 → IPs elásticos → Alocar** → *Ações → Associar* à instância `payax-pagamentos-1`.
Esse é o IP que vai para o **Bradesco** (liberação da API ou da transmissão de arquivos) e para os **IXC** dos clientes.

### 6. Endereço
No DNS do domínio, crie um registro **A**: `pagamentos` → o IP fixo. (Pode levar alguns minutos para valer.)

### 7. Recuperação automática
**CloudWatch → Alarmes → Criar alarme** → métrica *EC2 → Por instância → StatusCheckFailed_System* da
instância → maior que 0 por 2 minutos → ação do EC2 **Recuperar esta instância** + aviso por e-mail. Se o hardware
do AWS falhar, a máquina volta sozinha, com o mesmo IP e o mesmo disco.

### 8. Instalar
1. Envie o pacote para o bucket: **S3 → seu bucket → pasta `instalacao` → Carregar**.
2. **EC2 → Instâncias → payax-pagamentos-1 → Conectar → Session Manager → Conectar.** Abre um terminal no navegador.
3. Cole, trocando os três valores:

```bash
sudo snap install aws-cli --classic
cd /tmp && aws s3 cp s3://NOME-DO-BUCKET/instalacao/ . --recursive --exclude "*" --include "payax-pagamentos-*.tar.gz"
tar xzf "$(ls -t payax-pagamentos-*.tar.gz | head -1)" && cd "$(ls -td payax-pagamentos-*/ | head -1)"
sudo ./implantacao/instalar.sh --dominio pagamentos.payax.com.br --bucket NOME-DO-BUCKET --email-admin ti@payax.com.br
```

Ao final aparecem o endereço e a **senha inicial do administrador** — anote. Os segredos do sistema ficam
guardados, cifrados, no AWS (*Systems Manager → Parameter Store → /payax/pagamentos/env*): **não apague**.
Sem eles, as credenciais do banco gravadas no sistema não podem ser lidas por um servidor novo.

### 9. Primeiro acesso
1. `https://pagamentos.payax.com.br/` → entre com o e-mail e a senha inicial → troque a senha.
2. Ative a **autenticação em duas etapas** e, em Segurança e usuários, **exija** para toda a equipe.
3. Cadastre a equipe, o convênio Bradesco (Contas e preços), o encarregado de dados (LGPD) e as integrações.
4. Configure um monitor externo de disponibilidade em `https://pagamentos.payax.com.br/api/saude` (ex.: *Route 53
   → Verificações de integridade*, com aviso por e-mail).

### Atualizar o sistema
Gere o pacote novo, envie para a pasta `instalacao` e repita o passo 8.3 **no mesmo servidor**. O script mantém o
banco e os segredos, troca o programa e reinicia (alguns segundos fora do ar).

---

## Etapa 2: a reserva

1. Crie `payax-pagamentos-2` igual ao passo 4, **em outra zona de disponibilidade** (Rede → Sub-rede, ex.: `sa-east-1b`).
2. Instale com o mesmo comando do passo 8.3, acrescentando **`--reserva`**. Ela instala tudo e fica parada.
3. No console, **Interromper instância**. Desligada, ela paga só o disco.
4. Sempre que atualizar o principal, ligue a reserva, rode o mesmo comando com `--reserva` e desligue de novo.

## Se o servidor principal cair

**Etapa 2 (com reserva):**
1. Console → `payax-pagamentos-1` → **Interromper** (se ainda responder). *Nunca deixe os dois ligados com o sistema ativo.*
2. Ligue `payax-pagamentos-2` → Conectar → Session Manager → `sudo /opt/payax/pagamentos/implantacao/assumir.sh`
   (pede para digitar ASSUMIR; restaura o banco de segundos atrás, confere a integridade e sobe).
3. **IPs elásticos** → associar o IP fixo a `payax-pagamentos-2`. O endereço e o IP liberado no Bradesco continuam os mesmos.

**Etapa 1 (sem reserva):** crie um servidor novo (passo 4), associe o IP fixo (passo 5) e rode o passo 8.3 com
**`--anterior-desligado`**. Ele encontra os segredos e a cópia contínua no AWS, restaura e sobe.

Nos dois casos, se a restauração falhar, **nada é iniciado** — o sistema nunca sobe com o banco vazio.

## Segurança, resumo

- Só as portas 80 e 443 abertas; sem SSH (acesso pelo navegador, registrado pelo AWS).
- Disco, bucket e segredos cifrados; bucket sem acesso público e com versionamento.
- O servidor acessa o AWS por papel (IAM role): nenhuma chave de acesso gravada em disco.
- O programa roda com um usuário próprio, sem privilégios, e só escreve na pasta de dados.
- MFA na conta AWS e duas etapas obrigatórias no sistema.
