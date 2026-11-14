#!/usr/bin/env bash
# PAY AX Pagamentos — cria a estrutura na AWS (região São Paulo) de uma vez, pelo CloudShell.
#
# Cria: bucket das cópias (privado, versionado, cifrado), papel do servidor com as permissões mínimas,
# grupo de segurança (só 80/443), servidor t4g.small Ubuntu 24.04 ARM (crédito ilimitado, disco 30 GB
# cifrado, proteção contra encerramento/interrupção), IP fixo, alertas por e-mail (hardware → recupera,
# máquina travada → reinicia, memória, disco), foto diária do disco (7 dias) e orçamento mensal.
#
# Uso, no CloudShell (ícone >_ no topo do console), com o pacote carregado (Ações → Carregar arquivo):
#   tar xzf payax-pagamentos-*.tar.gz && cd payax-pagamentos-*/
#   bash implantacao/criar-aws.sh --email-alertas ti@payax.com.br
#
# Pode rodar de novo: o que já existe é reaproveitado, não duplicado.
set -euo pipefail
export AWS_REGION=sa-east-1 AWS_DEFAULT_REGION=sa-east-1 AWS_PAGER=""

EMAIL="" TIPO="t4g.small" DISCO=30 ORCAMENTO=30 NOME="payax-pagamentos-1"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --email-alertas) EMAIL="$2"; shift 2 ;;
    --tipo) TIPO="$2"; shift 2 ;;
    --orcamento) ORCAMENTO="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || { echo "Informe --email-alertas (e-mail da equipe que recebe os avisos)." >&2; exit 2; }

passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33mAviso: %s\033[0m\n' "$*" >&2; }
PACOTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONTA="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="payax-pagamentos-copias-$CONTA"
PAPEL="PayaxPagamentosServidor"
echo "Conta $CONTA · região São Paulo (sa-east-1) · bucket $BUCKET"

# ---------------------------------------------------------------- 1. bucket das cópias
passo "Bucket das cópias"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Já existe."
else
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=sa-east-1 >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
# Versões antigas das cópias saem depois de 30 dias (o histórico do banco já guarda 30 dias).
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"versoes-antigas","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'
echo "Privado, versionado e cifrado."

# ---------------------------------------------------------------- 2. papel do servidor
passo "Papel do servidor ($PAPEL)"
if ! aws iam get-role --role-name "$PAPEL" >/dev/null 2>&1; then
  aws iam create-role --role-name "$PAPEL" --description "Servidor PAY AX Pagamentos" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam attach-role-policy --role-name "$PAPEL" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name "$PAPEL" --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
aws iam put-role-policy --role-name "$PAPEL" --policy-name payax-pagamentos --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": [\"s3:ListBucket\"], \"Resource\": \"arn:aws:s3:::$BUCKET\" },
    { \"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\"], \"Resource\": \"arn:aws:s3:::$BUCKET/*\" },
    { \"Effect\": \"Allow\", \"Action\": [\"ssm:GetParameter\", \"ssm:PutParameter\"],
      \"Resource\": \"arn:aws:ssm:sa-east-1:$CONTA:parameter/payax/pagamentos/*\" }
  ]
}"
if ! aws iam get-instance-profile --instance-profile-name "$PAPEL" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$PAPEL" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$PAPEL" --role-name "$PAPEL"
  echo "Aguardando o papel propagar (15 s)..."; sleep 15
fi
echo "Acesso só ao bucket $BUCKET, aos segredos /payax/pagamentos/*, ao terminal pelo navegador e às métricas."

# ---------------------------------------------------------------- 3. grupo de segurança
passo "Grupo de segurança (só HTTP e HTTPS)"
VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
[[ "$VPC" != None ]] || { echo "A conta não tem VPC padrão em São Paulo." >&2; exit 1; }
SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values=payax-pagamentos-web Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
if [[ "$SG" == None ]]; then
  SG="$(aws ec2 create-security-group --group-name payax-pagamentos-web --description "PAY AX Pagamentos: so HTTP e HTTPS" --vpc-id "$VPC" --query GroupId --output text)"
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' >/dev/null
fi
echo "$SG — sem SSH (o acesso é pelo navegador, registrado pela AWS)."

# ---------------------------------------------------------------- 4. servidor
passo "Servidor $NOME ($TIPO, Ubuntu 24.04 ARM)"
INST="$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NOME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [[ "$INST" == None ]]; then
  INST="$(aws ec2 run-instances \
    --image-id resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
    --instance-type "$TIPO" \
    --iam-instance-profile Name="$PAPEL" \
    --security-group-ids "$SG" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISCO,VolumeType=gp3,Encrypted=true,DeleteOnTermination=false}" \
    --credit-specification CpuCredits=unlimited \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --disable-api-termination \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NOME},{Key=Sistema,Value=payax-pagamentos}]" \
                         "ResourceType=volume,Tags=[{Key=Name,Value=$NOME},{Key=Sistema,Value=payax-pagamentos}]" \
    --query 'Instances[0].InstanceId' --output text)"
  echo "Criado: $INST. Aguardando ligar..."
fi
aws ec2 wait instance-running --instance-ids "$INST"
aws ec2 modify-instance-attribute --instance-id "$INST" --disable-api-stop >/dev/null 2>&1 \
  || aviso "não foi possível ativar a proteção contra interrupção (ative no console: Ações → Configurações da instância)."
echo "$INST ligado. Crédito de CPU ilimitado, disco cifrado e mantido mesmo se a máquina for apagada."

# ---------------------------------------------------------------- 5. IP fixo
passo "IP fixo"
IP="$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NOME" --query 'Addresses[0].PublicIp' --output text)"
if [[ "$IP" == None ]]; then
  ALOC="$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NOME}]" --query AllocationId --output text)"
  aws ec2 associate-address --instance-id "$INST" --allocation-id "$ALOC" >/dev/null
  IP="$(aws ec2 describe-addresses --allocation-ids "$ALOC" --query 'Addresses[0].PublicIp' --output text)"
fi
echo "$IP"

# ---------------------------------------------------------------- 6. alertas
passo "Alertas por e-mail"
TOPICO="$(aws sns create-topic --name payax-alertas --query TopicArn --output text)"
if ! aws sns list-subscriptions-by-topic --topic-arn "$TOPICO" --query 'Subscriptions[].Endpoint' --output text | grep -qx "$EMAIL"; then
  aws sns subscribe --topic-arn "$TOPICO" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  echo "Enviado um e-mail de confirmação para $EMAIL — clique em 'Confirm subscription', senão os avisos não chegam."
fi
alarme() { # nome métrica namespace limite períodos ação... (dimensão InstanceId)
  local nome="$1" metrica="$2" ns="$3" limite="$4" periodos="$5"; shift 5
  aws cloudwatch put-metric-alarm --alarm-name "$nome" --namespace "$ns" --metric-name "$metrica" \
    --dimensions Name=InstanceId,Value="$INST" --statistic Maximum --period 60 --evaluation-periods "$periodos" \
    --threshold "$limite" --comparison-operator GreaterThanThreshold --treat-missing-data missing \
    --alarm-actions "$@" "$TOPICO" --ok-actions "$TOPICO" \
    || aviso "não foi possível criar o alarme $nome."
}
alarme "payax-hardware-recupera" StatusCheckFailed_System AWS/EC2 0 2 "arn:aws:automate:sa-east-1:ec2:recover"
alarme "payax-travada-reinicia" StatusCheckFailed_Instance AWS/EC2 0 3 "arn:aws:automate:sa-east-1:ec2:reboot"
alarme "payax-memoria-85" mem_used_percent PAYAX 85 10
alarme "payax-disco-80" disk_used_percent PAYAX 80 5
echo "Hardware → recupera sozinho; máquina travada → reinicia sozinha; memória e disco → e-mail."

# ---------------------------------------------------------------- 7. foto diária do disco
passo "Foto diária do disco (7 dias)"
if aws dlm get-lifecycle-policies --target-tags Sistema=payax-pagamentos --query 'Policies[0].PolicyId' --output text 2>/dev/null | grep -q '^policy-'; then
  echo "Já existe."
else
  aws dlm create-default-role --resource-type snapshot >/dev/null 2>&1 || true
  sleep 5
  aws dlm create-lifecycle-policy --description "PAY AX: foto diaria do disco" --state ENABLED \
    --execution-role-arn "arn:aws:iam::$CONTA:role/AWSDataLifecycleManagerDefaultRole" \
    --policy-details '{"ResourceTypes":["VOLUME"],"TargetTags":[{"Key":"Sistema","Value":"payax-pagamentos"}],
      "Schedules":[{"Name":"diaria","CreateRule":{"Interval":24,"IntervalUnit":"HOURS","Times":["06:00"]},
      "RetainRule":{"Count":7},"CopyTags":true}]}' >/dev/null \
    || aviso "não foi possível criar a foto diária (crie no console: EC2 → Gerenciador de ciclo de vida)."
fi

# ---------------------------------------------------------------- 8. orçamento
passo "Orçamento mensal (US\$ $ORCAMENTO) com aviso em 80%"
if aws budgets describe-budget --account-id "$CONTA" --budget-name payax-mensal >/dev/null 2>&1; then
  echo "Já existe."
else
  aws budgets create-budget --account-id "$CONTA" \
    --budget "{\"BudgetName\":\"payax-mensal\",\"BudgetLimit\":{\"Amount\":\"$ORCAMENTO\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\"}" \
    --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}]" \
    || aviso "não foi possível criar o orçamento (crie em Faturamento → Budgets)."
fi

# ---------------------------------------------------------------- 9. pacote no bucket
passo "Pacote de instalação no bucket"
ARQ="$(ls -t "$PACOTE"/../payax-pagamentos-*.tar.gz 2>/dev/null | head -1 || true)"
if [[ -n "$ARQ" ]]; then
  aws s3 cp "$ARQ" "s3://$BUCKET/instalacao/" --only-show-errors && echo "$(basename "$ARQ") → s3://$BUCKET/instalacao/"
else
  aviso "pacote .tar.gz não encontrado ao lado desta pasta; envie para s3://$BUCKET/instalacao/ pelo console do S3."
fi

passo "Pronto"
cat <<EOF
IP fixo ......... $IP      ← vai para o DNS, para o Bradesco e para os IXC
Bucket .......... $BUCKET
Servidor ........ $INST ($NOME)
Conta ........... $CONTA

Próximos passos:
 1. Confirme o e-mail de alertas que chegou em $EMAIL.
 2. No DNS do domínio, crie o registro A:  pagamentos  →  $IP
 3. EC2 → Instâncias → $NOME → Conectar → Session Manager → Conectar, e cole:

sudo snap install aws-cli --classic
cd /tmp && aws s3 cp s3://$BUCKET/instalacao/ . --recursive --exclude "*" --include "payax-pagamentos-*.tar.gz"
tar xzf "\$(ls -t payax-pagamentos-*.tar.gz | head -1)" && cd "\$(ls -td payax-pagamentos-*/ | head -1)"
sudo ./implantacao/instalar.sh --dominio pagamentos.payax.com.br --bucket $BUCKET --email-admin $EMAIL
EOF
