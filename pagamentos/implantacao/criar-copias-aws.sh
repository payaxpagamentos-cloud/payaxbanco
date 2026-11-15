#!/usr/bin/env bash
# PAY AX Pagamentos — onde guardar as cópias quando o servidor NÃO está na AWS (ex.: VPS Hostinger).
#
# Cria, na região São Paulo: o bucket das cópias (privado, versionado, cifrado) e um usuário "payax-copias"
# que só consegue ler e gravar nesse bucket — mais nada na conta. Mostra a chave de acesso UMA vez,
# para digitar no instalador do servidor.
#
# Uso, no CloudShell da AWS (ícone >_ no topo do console, região São Paulo):
#   bash criar-copias-aws.sh
set -euo pipefail
export AWS_REGION=sa-east-1 AWS_DEFAULT_REGION=sa-east-1 AWS_PAGER=""

CONTA="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="payax-pagamentos-copias-$CONTA"
USUARIO="payax-copias"

echo "== Bucket $BUCKET (São Paulo)"
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
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"versoes-antigas","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'
echo "Privado, versionado e cifrado."

echo "== Usuário $USUARIO (só este bucket)"
aws iam get-user --user-name "$USUARIO" >/dev/null 2>&1 || aws iam create-user --user-name "$USUARIO" >/dev/null
aws iam put-user-policy --user-name "$USUARIO" --policy-name payax-copias --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": [\"s3:ListBucket\"], \"Resource\": \"arn:aws:s3:::$BUCKET\" },
    { \"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\"], \"Resource\": \"arn:aws:s3:::$BUCKET/*\" }
  ]
}"

if [[ "$(aws iam list-access-keys --user-name "$USUARIO" --query 'length(AccessKeyMetadata)' --output text)" != "0" ]]; then
  echo
  echo "O usuário já tem chave de acesso. Se perdeu a chave, apague a antiga em IAM → Usuários → $USUARIO →"
  echo "Credenciais de segurança, e rode este script de novo para gerar outra."
else
  read -r ID SEGREDO < <(aws iam create-access-key --user-name "$USUARIO" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  cat <<EOF

================ CHAVE DE ACESSO DAS CÓPIAS (aparece só agora) ================
  Access Key ID ......... $ID
  Secret Access Key ..... $SEGREDO
Digite as duas no instalador do servidor, quando ele pedir. Não envie por e-mail,
mensagem ou chat. Ela só lê e grava no bucket das cópias, mais nada na conta.
===============================================================================
EOF
fi

cat <<EOF

No servidor, o instalador usa:
  --bucket $BUCKET --endpoint https://s3.sa-east-1.amazonaws.com --regiao sa-east-1
EOF
