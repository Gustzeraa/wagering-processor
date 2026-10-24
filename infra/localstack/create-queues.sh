#!/bin/bash
set -e
ACCOUNT=000000000000
REGION=us-east-1

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:${REGION}:${ACCOUNT}:wager-transactions-dlq.fifo\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
}"

# eventos de integração publicados pela outbox
awslocal sns create-topic --name wallet-events
awslocal sqs create-queue --queue-name wallet-events-audit
awslocal sns subscribe \
  --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:wallet-events" \
  --protocol sqs \
  --notification-endpoint "arn:aws:sqs:${REGION}:${ACCOUNT}:wallet-events-audit" \
  --attributes RawMessageDelivery=true

echo "queues and topics created"