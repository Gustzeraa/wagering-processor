# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por HTTP e por SQS, mantendo saldo e ledger consistentes mesmo com mensagens duplicadas, fora de ordem, concorrentes e com quedas de processo.

As decisões técnicas, trade-offs e limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime, package manager e test runner | Bun 1.x |
| Linguagem | TypeScript (`strict: true`) |
| Framework | NestJS 12 |
| Banco | PostgreSQL 17 |
| ORM | MikroORM 7 (Unit of Work, Identity Map, `transactional`, `LockMode`) |
| Mensageria | SQS FIFO e SNS via LocalStack |
| Orquestração local | Docker Compose |
| Validação de entrada | Zod |
| Métricas | prom-client (formato Prometheus) |

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose v2

## Setup rápido

```bash
bun install

# PostgreSQL e LocalStack (cria as filas, a DLQ e o tópico de eventos)
docker compose up -d
docker compose ps          # esperar os dois ficarem healthy

# schema
bun run migration:up

# aplicação local na porta 3000
bun run start:dev
```

## Rodando 3 instâncias (Docker)

A aplicação fica no perfil `app` do Compose. O perfil sobe um job de migrations e três réplicas da aplicação, todas consumindo a mesma fila e usando o mesmo banco.

```bash
docker compose --profile app up -d --build
docker compose --profile app ps

curl http://localhost:3101/health/ready
curl http://localhost:3102/health/ready
curl http://localhost:3103/health/ready

docker compose --profile app logs app --tail 50   # logs JSON das três instâncias
docker compose --profile app stop app             # parar as instâncias
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start:dev` | Aplicação local com reload |
| `bun run start` | Aplicação local |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run test:unit` | Testes de unidade (sem Docker) |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Concorrência real, incluindo múltiplos processos |
| `bun run test` | Todos os testes |
| `bun scripts/publish-wager.ts <walletId> <playerId> [kind] [amount] [ref]` | Publica uma mensagem na fila |

## Testes

Antes de rodar os testes de integração e concorrência:

1. `docker compose up -d` com PostgreSQL e LocalStack healthy, e `bun run migration:up` aplicado.
2. **Nenhuma instância da aplicação rodando** (nem `start:dev` num terminal, nem `docker compose --profile app`). Os testes do consumidor SQS usam a fila compartilhada `wager-transactions.fifo`, e uma instância externa disputaria as mensagens. Os testes de múltiplos processos criam uma fila exclusiva e não são afetados.

```bash
bun run test:unit
bun run test:integration
bun run test:concurrency   # ~2 minutos: dois cenários esperam o visibility timeout de 30s
```

Todo teste de integração e concorrência que mexe em saldo termina conferindo o invariante global `wallet.balance == saldo reconstruído pelo ledger` para **todas** as wallets do banco.

### Cobertura dos testes obrigatórios

| Exigência | Arquivo |
|---|---|
| `Money`: escala, entradas inválidas, conflito de moeda | `test/unit/money.test.ts` |
| Invariantes da `Wallet` e do ledger | `test/unit/wallet.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK e máquina de estados | `test/unit/wager-transaction.test.ts`, `test/integration/http.test.ts` |
| Idempotency key com payload divergente | `test/unit/wager-transaction.test.ts`, `test/integration/http.test.ts` |
| Migrations e constraints | `bun run migration:down && bun run migration:up`, `test/integration/*` |
| Atomicidade wallet, ledger, inbox e outbox | `test/integration/sqs-consumer.test.ts`, `test/integration/outbox.test.ts` |
| Inbox e redelivery | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes na mesma outbox | `test/integration/outbox.test.ts` |
| Retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| Recuperação após reinicialização | `test/concurrency/processes.test.ts` |
| 1. Mesma aposta 50 vezes em paralelo | `test/concurrency/wagering.test.ts` |
| 2. Disputa de saldo (seção 8) | `test/concurrency/wagering.test.ts` |
| 3. Wallets distintas em paralelo | `test/concurrency/wagering.test.ts` |
| 4. Três ou mais processos simultâneos | `test/concurrency/processes.test.ts` |
| 5. Worker morto após commit e antes do ack | `test/concurrency/processes.test.ts`, `test/integration/sqs-consumer.test.ts` |
| 6. Dois publishers na mesma outbox | `test/integration/outbox.test.ts` |
| 7. ROLLBACK ou REFUND antes da referência | `test/integration/pending-reference.test.ts` |
| 8. Reinício com consistência final | `test/concurrency/processes.test.ts` |

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (saldo inicial gera transação `OPENING`) |
| `GET` | `/wallets/:walletId` | Consulta wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado, cursor estável e opaco |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado com o ledger |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por ID do provedor |
| `GET` | `/health/live` | Processo vivo (sem dependências) |
| `GET` | `/health/ready` | PostgreSQL e SQS alcançáveis |
| `GET` | `/metrics` | Métricas Prometheus |

### Exemplo

```bash
# criar wallet
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# apostar (troque WALLET_ID)
curl -s -i -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "player-1",
    "walletId": "WALLET_ID",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Repetir a mesma requisição devolve `200` com `"idempotentReplay": true`. Repetir com a mesma key e outro valor devolve `409 IDEMPOTENCY_CONFLICT`.

### Status HTTP

| Situação | Status |
|---|---|
| Processada | `201` (primeira vez) ou `200` (replay, `idempotentReplay: true`) |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` |
| Rejeitada por regra de negócio (`REJECTED` + `failureCode`) | `422` |
| Payload inválido ou header ausente | `400` |
| Conflito de idempotência ou wallet duplicada | `409` |
| Recurso inexistente | `404` |
| Falha transitória de infraestrutura | `503` + `Retry-After` (reenviar com a mesma key é seguro) |

Erros usam um envelope único: `{ "error": { "code": "...", "message": "...", "retryable": false } }`.

## Mensageria

| Recurso | Nome |
|---|---|
| Fila de entrada | `wager-transactions.fifo` (redrive para a DLQ após 5 entregas) |
| DLQ | `wager-transactions-dlq.fifo` |
| Tópico de eventos | `wallet-events` (SNS) |
| Fila de auditoria dos eventos | `wallet-events-audit` (assinante do tópico) |

```bash
# publicar uma aposta pela fila
bun scripts/publish-wager.ts WALLET_ID player-1 BET 10.00

# ver os eventos publicados pela outbox
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wallet-events-audit --max-number-of-messages 10
```

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `5432`, `wagering`... | PostgreSQL |
| `AWS_ENDPOINT`, `AWS_REGION` | `http://localhost:4566`, `us-east-1` | LocalStack |
| `WAGER_QUEUE_NAME`, `WAGER_DLQ_NAME` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo` | Filas |
| `WALLET_EVENTS_TOPIC_ARN` | `arn:aws:sns:us-east-1:000000000000:wallet-events` | Tópico da outbox |
| `WORKERS_ENABLED` | `true` | Liga consumidor SQS, relay da outbox e worker de pendentes |
| `PENDING_REFERENCE_TTL_MS` | `1800000` (30 min) | Prazo para uma referência ausente chegar |
| `DB_DEBUG` | `false` | Loga o SQL do MikroORM |
| `CRASH_AFTER_COMMIT` | — | **Somente testes**: encerra o processo entre o commit e o ack |

## Estrutura

```
src/
  domain/          regras de negócio puras (Money, Wallet, WagerTransaction, ledger, eventos)
  application/     casos de uso e portas (Clock, IdGenerator)
  infrastructure/  persistência (records, mappers, repositórios), SQS, SNS, observabilidade
  http/            controllers, validação, mapeamento de erros, guard de autenticação
  messaging/       consumidor SQS, relay da outbox, worker de referências pendentes
  migrations/      schema versionado e reversível (SQL)
test/
  unit/            domínio, sem infraestrutura
  integration/     PostgreSQL e LocalStack reais
  concurrency/     paralelismo real e múltiplos processos
```
