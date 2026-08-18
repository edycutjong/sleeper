#!/usr/bin/env bash
#
# Deploy the release gate to AWS Lambda behind a public Function URL.
#
# Idempotent: run it twice and the second run updates code and configuration rather than failing
# on "already exists". `--dry-run` prints every AWS call it would make and touches nothing, which
# is also how this file documents itself — the same contract scripts/provision.sh follows.
#
# Requires: aws CLI v2 authenticated, and DATABASE_URL in the environment or .env.
#
set -euo pipefail

FUNCTION_NAME="${FUNCTION_NAME:-sleeper}"
ROLE_NAME="${ROLE_NAME:-sleeper-lambda-role}"
# us-east-1, and it is not an arbitrary default. This script used to say ap-southeast-3, which
# disagreed with src/config.ts (us-east-1) and .env.example (us-east-1) — and would have failed
# twice over: Bedrock is not offered in ap-southeast-3 at all, and BEDROCK_CHAT_MODEL_ID below is
# a `us.` cross-region inference profile, which only resolves inside US regions. The function has
# to live where the models it calls actually exist.
REGION="${AWS_REGION:-us-east-1}"
RUNTIME="nodejs22.x"
TIMEOUT=60
MEMORY=1024

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

run() {
  if [[ $DRY_RUN -eq 1 ]]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------------------------
# 0 · preflight
# ---------------------------------------------------------------------------------------------
say "0 · preflight"
command -v aws >/dev/null || { echo "aws CLI not found — brew install awscli"; exit 1; }

if [[ $DRY_RUN -eq 0 ]]; then
  aws sts get-caller-identity >/dev/null 2>&1 || {
    echo "ERROR: no AWS credentials. Run 'aws configure' or 'aws sso login' first."
    exit 1
  }
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  echo "  account $ACCOUNT_ID · region $REGION"
else
  ACCOUNT_ID="<account>"
fi

# The function needs the cluster URL and the model ids. Sourced from .env so there is one source
# of truth for them; never baked into the zip, which is world-readable to anyone with the ARN.
[[ -f .env ]] && set -a && source .env && set +a
: "${DATABASE_URL:?DATABASE_URL is required — put it in .env}"

# ---------------------------------------------------------------------------------------------
# 1 · bundle
# ---------------------------------------------------------------------------------------------
say "1 · bundle"
# The layout is not arbitrary. src/corpus.ts resolves DATA_DIR as `<dir of this module>/../data`,
# so the bundle has to sit one directory DOWN from the zip root or the seed corpus and the fitted
# thresholds resolve to /var/data and the function starts with no memory to compare against.
rm -rf .aws-build && mkdir -p .aws-build/dist
run npx esbuild src/lambda.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile=.aws-build/dist/index.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

run cp -R data .aws-build/data
if [[ $DRY_RUN -eq 0 ]]; then
  # thresholds.json is gitignored and fitted locally; without it the gate silently falls back to
  # defaults, which is a different gate from the one the numbers were measured on.
  [[ -f data/thresholds.json ]] || echo "  WARNING: data/thresholds.json missing — deploying with FALLBACK thresholds"
  (cd .aws-build && zip -qr ../function.zip .)
  echo "  function.zip $(du -h function.zip | cut -f1)"
fi

# ---------------------------------------------------------------------------------------------
# 2 · execution role
# ---------------------------------------------------------------------------------------------
say "2 · execution role"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  would create role $ROLE_NAME, attach AWSLambdaBasicExecutionRole + inline bedrock:InvokeModel"
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
else
  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "  role exists"
  else
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" >/dev/null
    echo "  role created"
  fi
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  # Least privilege on purpose: the function invokes two Bedrock models and writes logs. It has no
  # S3, no DynamoDB and no IAM — the durable state lives in CockroachDB, not in AWS.
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name sleeper-bedrock \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:Converse"],"Resource":"*"}]}' >/dev/null
  ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"
  echo "  $ROLE_ARN"
fi

# ---------------------------------------------------------------------------------------------
# 3 · function
# ---------------------------------------------------------------------------------------------
say "3 · function"
ENV_VARS="Variables={DATABASE_URL=$DATABASE_URL,AWS_BEDROCK_REGION=${AWS_REGION:-$REGION},BEDROCK_EMBEDDING_MODEL_ID=${BEDROCK_EMBEDDING_MODEL_ID:-amazon.titan-embed-text-v2:0},BEDROCK_CHAT_MODEL_ID=${BEDROCK_CHAT_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0},PACKAGE_ID=${PACKAGE_ID:-xz-utils},ARC_WINDOW_DAYS=${ARC_WINDOW_DAYS:-90}}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  would create-or-update $FUNCTION_NAME ($RUNTIME, ${MEMORY}MB, ${TIMEOUT}s) handler dist/index.handler"
else
  if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FUNCTION_NAME" --region "$REGION" \
      --zip-file fileb://function.zip >/dev/null
    aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" \
      --timeout "$TIMEOUT" --memory-size "$MEMORY" --environment "$ENV_VARS" >/dev/null
    echo "  updated"
  else
    # The role is eventually consistent; Lambda rejects it for a few seconds after creation.
    for attempt in 1 2 3 4 5 6; do
      if aws lambda create-function --function-name "$FUNCTION_NAME" --region "$REGION" \
        --runtime "$RUNTIME" --role "$ROLE_ARN" --handler dist/index.handler \
        --zip-file fileb://function.zip --timeout "$TIMEOUT" --memory-size "$MEMORY" \
        --environment "$ENV_VARS" >/dev/null 2>&1; then
        echo "  created"; break
      fi
      echo "  role not propagated yet, retrying ($attempt/6)…"; sleep 10
    done
  fi
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
fi

# ---------------------------------------------------------------------------------------------
# 4 · public Function URL
# ---------------------------------------------------------------------------------------------
say "4 · function URL"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  would create a public (AuthType NONE) Function URL and allow lambda:InvokeFunctionUrl"
else
  aws lambda add-permission --function-name "$FUNCTION_NAME" --region "$REGION" \
    --statement-id FunctionURLAllowPublicAccess --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
  URL="$(aws lambda create-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" \
    --auth-type NONE --query FunctionUrl --output text 2>/dev/null \
    || aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" \
       --query FunctionUrl --output text)"
  say "DEPLOYED"
  echo "  $URL"
  echo
  echo "  verify:"
  echo "    curl ${URL}health"
  echo "    curl -X POST $URL -H 'content-type: application/json' \\"
  echo "      -d '{\"actor_id\":\"jia-tan\",\"kind\":\"release\",\"content\":\"signs and publishes 5.6.1\",\"occurred_at\":\"2024-03-09T00:00:00Z\"}'"
fi
