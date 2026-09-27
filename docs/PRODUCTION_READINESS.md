# Production Readiness and Launch Runbook

This runbook is the operator checklist for an AnchorPoint production launch. It covers the AWS KMS key, AWS RDS PostgreSQL, Prisma migrations, Stellar hot-wallet controls, application deployment, and monitoring already represented in this repository.

## Scope and Safety

- Treat every unchecked stop gate as a release blocker.
- Run production commands only from an approved operator workstation or CI runner with short-lived credentials.
- Never place private keys, passwords, tokens, webhook URLs, or full connection strings in Git, tickets, chat, screenshots, Terraform outputs, or application logs.
- Use a production-specific AWS account or account boundary, region, Terraform state, KMS alias, RDS instance, Redis deployment, and monitoring credentials.
- Use `STELLAR_NETWORK=public` and the public Stellar network passphrase for mainnet. Do not infer production from an environment name alone.
- Record approvals, plan files, migration identifiers, transaction hashes, and alert test results in the change record. Do not record secret values.

## Known Release Blockers

The following repository conditions are release gates. Resolve each condition or document an approved exception before production launch:

1. `backend/prisma/schema.prisma` declares the `sqlite` provider, while `backend/prisma/migrations/migration_lock.toml` and the `20260623000000_init_postgres` migration target PostgreSQL. Stop before provisioning or migrating production until the schema provider, generated Prisma client, migration history, and deployment database agree.
2. `backend/src/workers/contract-queue.worker.ts` contains a hard-coded testnet Horizon URL and simulated contract/deployment/settlement behavior. Do not enable this worker for real value movement until it is production-safe, uses the configured network, and has been approved for the intended contract operations.
3. The general Redis client reads `REDIS_URL`, while BullMQ queue configuration reads `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `REDIS_DB`. Set and verify both interfaces against the same production Redis deployment, or make the application configuration consistent before launch.
4. The KMS Terraform module comments recommend `prevent_destroy = true` for mainnet, but the resource currently does not enforce it. Add an equivalent production control or obtain a documented exception before applying a mainnet plan.
5. The existing Prometheus rules alert on API availability and health probes. Hot-wallet balance metrics are exported by the backend, but no hot-wallet Prometheus alert rule is present in `infra/monitoring/prometheus-alerts.yml`. Backend alert channels and a tested low-balance alert are required until an equivalent Prometheus rule is added.

## Roles and Approval Gates

Assign named people or service identities before starting:

| Role | Required responsibility |
| --- | --- |
| Release owner | Owns the change record, launch decision, and rollback decision. |
| Security approver | Reviews IAM, KMS policy, secret handling, dependency audit, and incident access. |
| Database approver | Reviews the RDS plan, backup/restore evidence, migration plan, and data integrity checks. |
| Stellar operations owner | Verifies network, contract IDs, signer custody, balances, funding, and transaction tests. |
| On-call operator | Receives PagerDuty and wallet alerts and executes the incident procedures below. |

Do not proceed past a gate until the responsible approver has recorded approval.

## Launch Checklist

### Gate 0: Change and Access Preparation

- [ ] Create or confirm the production change record and maintenance window.
- [ ] Confirm the deployment branch is based on the intended `main` commit.
- [ ] Confirm CI has passed for the exact commit to deploy.
- [ ] Confirm the release owner, database approver, security approver, and on-call operator are available during the launch window.
- [ ] Confirm AWS access uses least-privilege roles and MFA for human operators.
- [ ] Confirm Terraform state is remote, encrypted, access-controlled, and versioned. Do not use a shared local state file for production.
- [ ] Confirm production credentials are injected through the approved secret manager or workload identity. If a local `.env` file is required by a deployment tool, verify that Git ignores it before writing secrets, and never commit, print, or include it in an artifact.
- [ ] Confirm the incident contacts, PagerDuty service, Stellar RPC provider contacts, and database escalation path are current.

### Gate 1: Pre-Flight Security Audit

- [ ] Review `CONTRIBUTING.md`, the backend README, the security audit documentation, and this runbook.
- [ ] Run the repository's dependency and static checks in CI. The backend workflow includes migration validation, lint, tests, and an `npm audit --audit-level=high` step.
- [ ] Run the contract security audit if contract artifacts or contract code are part of the release:

  ```text
  ./scripts/security-audit.sh
  ```

- [ ] Review all high and critical dependency findings. Do not waive a finding without a documented owner, exposure analysis, mitigation, and expiry date.
- [ ] Confirm no private key, seed phrase, database password, AWS credential, KMS plaintext, PagerDuty routing key, or webhook secret appears in the diff, build artifacts, container image, or logs.
- [ ] Confirm `.env`, local environment files, Terraform variable files containing real values, and generated database files are excluded from version control.
- [ ] Confirm production logging is structured and does not include request bodies, authorization headers, private keys, decrypted key material, or full database URLs.
- [ ] Confirm admin accounts use unique credentials, password reset delivery is configured, and default development secrets are not in production.
- [ ] Confirm CORS, callback-domain allowlists, rate limits, upload size/content-type limits, webhook signatures, and TLS termination are configured for production domains.
- [ ] Confirm public endpoints do not expose internal dashboards, Redis, PostgreSQL, Jaeger, Prometheus, Alertmanager, or worker administration endpoints.
- [ ] Confirm container and runtime identities are non-root where supported and have no interactive shell or broad administrator permissions.

### Gate 2: AWS KMS Setup

The KMS module provisions a symmetric customer-managed key for encrypted Stellar signing key material. The API and BullMQ worker roles must remain separate. Key administrators can manage lifecycle but must not decrypt application key material.

#### 2.1 Prepare IAM and CloudTrail

- [ ] Create or identify the production API runtime role.
- [ ] Create or identify a separate production BullMQ worker role.
- [ ] Create or identify the limited key administrator role and CI/CD deployment role.
- [ ] Confirm the API and worker roles need only `kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*`, and `kms:DescribeKey` for the intended key.
- [ ] Confirm key administrators do not receive application encrypt/decrypt permissions.
- [ ] Enable CloudTrail for KMS API events and route logs to the approved protected destination.
- [ ] Decide whether CloudTrail log encryption is enabled. Set `enable_cloudtrail_encryption = true` only when the CloudTrail trail and policy prerequisites are ready.

#### 2.2 Plan and Apply the KMS Module

Run from `infra/terraform/kms` using the approved production Terraform state and credentials:

```text
terraform init
terraform fmt -check
terraform validate
checkov -d . --framework terraform
terraform plan -var-file=terraform.tfvars -out=tfplan
```

The production variable file must use:

- `environment = "mainnet"` or the approved production environment name.
- `key_alias = "anchorpoint-stellar-keys"` or the approved stable alias.
- Separate `api_server_role_arn` and `worker_role_arn` values.
- The approved key administrator ARNs.
- `deletion_window_in_days = 30` for mainnet unless security approves another value.
- `multi_region = true` only when the recovery design, replica regions, and cost are approved before key creation. This value cannot be changed after creation.

Review the plan for unexpected principals, wildcard access, key deletion, alias replacement, or SSM changes. After both security and release approval:

```text
terraform apply tfplan
terraform output -raw key_id
terraform output -raw key_arn
terraform output -raw alias_name
terraform output -raw ssm_parameter_name
```

The module writes the KMS ARN to `/anchorpoint/<environment>/AWS_KMS_KEY_ARN` in SSM Parameter Store. Treat the parameter path and ARN as configuration metadata, not as a substitute for IAM authorization.

#### 2.3 Verify KMS Before Storing Application Keys

- [ ] Confirm key state is `Enabled`.
- [ ] Confirm automatic key rotation is enabled:

  ```text
  aws kms get-key-rotation-status --key-id <key-id>
  ```

- [ ] Perform an encrypt/decrypt round trip using only a non-secret sentinel such as `anchorpoint-production-kms-check`.
- [ ] Confirm the API role can perform the required application operation and cannot administer the key.
- [ ] Confirm the worker role has the same narrow use permissions and is not the API role.
- [ ] Confirm CloudTrail records KMS usage without exposing plaintext.
- [ ] Confirm the application can read the KMS ARN from the approved secret/configuration injection path.
- [ ] Do not schedule key deletion during launch. Key destruction before signing-key rotation can permanently break SEP-10 authentication.

### Gate 3: Database Provisioning and Migration

#### 3.1 Resolve the Provider Contract First

Before touching production data, reconcile these files:

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/migration_lock.toml`
- `backend/prisma/migrations/20260623000000_init_postgres/migration.sql`
- `backend/scripts/validate-migration-env.js`
- `.github/workflows/migration-integrity.yml`

The current repository contains a provider mismatch. A PostgreSQL RDS instance must not be treated as ready until `prisma generate`, migration validation, migration deployment, and application startup have been tested against the same provider and schema history.

#### 3.2 Provision RDS

Run from `infra/terraform/rds` with a production state file:

```text
terraform init
terraform fmt -check
terraform validate
terraform plan -var-file=terraform.tfvars -out=tfplan
```

Review and approve at least the following:

- Private subnets and no public accessibility.
- Security-group ingress limited to application and worker subnet CIDRs.
- Multi-AZ deployment.
- Encryption at rest.
- Automated backups and a verified retention period appropriate for production.
- A final snapshot on destruction and no accidental `skip_final_snapshot` change.
- PostgreSQL engine version and parameter group compatibility with the application.
- CloudWatch PostgreSQL log export and enhanced monitoring.
- Performance Insights retention and access controls.
- `apply_immediately = false` unless the change record explicitly approves an immediate change.
- Secrets Manager storage for the generated database credentials.

Apply only the reviewed plan:

```text
terraform apply tfplan
terraform output -raw db_endpoint
terraform output -raw db_port
terraform output -raw db_name
terraform output -raw secrets_manager_secret_name
```

Retrieve the database credential only through the approved secret-manager integration. Never paste it into a terminal transcript or runbook. Construct `DATABASE_URL` in the deployment secret/configuration layer with TLS enabled as required by the database service.

#### 3.3 Back Up and Test the Target

- [ ] Confirm the RDS instance is available, encrypted, private, and in the intended region/account.
- [ ] Confirm a recent automated backup exists and a restore test has succeeded in a non-production environment.
- [ ] Confirm the production migration identity has only the permissions needed for migration and is not the application runtime identity.
- [ ] Confirm the application and worker security groups can reach PostgreSQL on port 5432, but public networks cannot.
- [ ] Confirm connection pooling and maximum connections are within the RDS instance limits.
- [ ] Take or verify a pre-migration snapshot according to the approved change record.
- [ ] Restore the production migration plan against a staging clone or disposable database populated with representative data.

#### 3.4 Run Migration Checks

Run from `backend` with `DATABASE_URL` and, for shadow operations, `SHADOW_DATABASE_URL` injected from the approved secret/configuration layer:

```text
node scripts/validate-migration-env.js
npm run prisma:generate
npm run migrate:check
npm run migrate:status
npm run migrate:verify
```

Review the integrity output for destructive SQL, schema drift, missing migration files, pending migrations, or provider errors. Generate and review rollback guidance for the release migration before approval:

```text
npm run migrate:rollback
```

For the approved production window, deploy migrations before serving traffic that requires the new schema:

```text
npm run prisma:deploy
npm run migrate:status
```

Prisma does not provide an automatic general rollback. If a migration fails or the application is incompatible, stop the rollout, preserve logs, and use the reviewed migration-specific rollback or restore the approved database snapshot. Do not run an unreviewed `DROP`, `DELETE`, or schema rewrite in an incident.

#### 3.5 Verify Data and Application Compatibility

- [ ] Confirm the migration table reports every expected migration as applied.
- [ ] Confirm row counts and critical indexes for users, transactions, KYC records, jobs, and notification records.
- [ ] Confirm the application can read and write a non-financial health-check record if the release includes a safe probe for it.
- [ ] Confirm no duplicate settlement or notification jobs were created during migration.
- [ ] Confirm API and worker versions use the same Prisma client and migration commit.

### Gate 4: Environment and Secret Configuration

Use a secret manager or workload identity for secrets. The table below is the production contract; `backend/.env.example` and `backend/src/config/env.ts` remain the source of truth for supported names and defaults.

#### 4.1 API and Worker Shared Configuration

| Variable | Requirement | Handling |
| --- | --- | --- |
| `NODE_ENV` | `production` | Non-secret. Reject development/test values. |
| `PORT` | Approved API port, normally `3002` | Non-secret. Expose only through the service load balancer. |
| `DATABASE_URL` | TLS-enabled production PostgreSQL URL | Secret. Inject at runtime. Never log. |
| `JWT_SECRET` | Unique production secret of sufficient entropy | Secret. Rotate through the auth/session procedure. |
| `SEP24_INTERACTIVE_URL_JWT_SECRET` | Unique secret when SEP-24 interactive URL tokens are enabled | Secret. Do not reuse `JWT_SECRET`. |
| `INTERACTIVE_URL` | Production dashboard or interactive application URL | Non-secret URL. Must use HTTPS. |
| `BASE_URL` | Public backend URL | Non-secret URL. Must match published SEP endpoints. |
| `STELLAR_NETWORK` | `public` for mainnet | Release gate. Do not use `testnet`. |
| `STELLAR_NETWORK_PASSPHRASE` | Public Stellar network passphrase | Non-secret. Verify against the SDK/network configuration. |
| `STELLAR_HORIZON_URL` | Approved production Horizon endpoint | Non-secret URL. Use a monitored provider. |
| `HORIZON_URL` | Same approved Horizon endpoint unless intentionally different | Non-secret URL. Keep indexer and fee services consistent. |
| `SOROBAN_RPC_URL` | Approved production Soroban RPC endpoint | Non-secret URL. Do not rely on the testnet default. |
| `STELLAR_BASE_FEE` | Approved fee policy | Non-secret. Review with Stellar operations. |
| `RECEIVING_ACCOUNT` | Production public receiving account | Public key. Verify character-for-character. |
| `DISTRIBUTION_ACCOUNT` | Production public distribution account when used | Public key. Verify trustlines and authorization. |
| `SIGNING_KEY` | Public signing key published by the anchor | Public key. Verify it matches the protected signing key material. |
| `REGISTRY_CONTRACT_ID` | Production registry contract ID when required | Public identifier. Verify network and deployment commit. |
| `REDIS_URL` | Production Redis URL for the shared Redis client | Secret if it contains a password. Inject at runtime. |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | BullMQ connection settings | Keep aligned with `REDIS_URL`; `REDIS_PASSWORD` is secret. |
| `QUEUE_CONCURRENCY` | Approved mainnet worker concurrency | Non-secret. Load-test before raising. |

#### 4.2 Signing and Key Management Secrets

| Variable | Requirement | Handling |
| --- | --- | --- |
| `KEY_MANAGEMENT_BACKEND` | `aws-kms` for the AWS launch path | Non-secret. Fail startup if it does not match the release design. |
| `AWS_KMS_KEY_ARN` | ARN or approved stable alias for the production KMS key | Sensitive configuration. Inject from SSM/config service. |
| `AWS_REGION` | KMS and storage region | Non-secret. Match the approved deployment region. |
| `STELLAR_DISTRIBUTION_SECRET` | Distribution signing secret when recurring payments or settlement require it | Secret. Inject only to the worker that needs it. |
| `STELLAR_FEE_BUMP_SECRET` | Fee-bump signer when enabled | Secret. Scope to the required runtime. |
| `ANCHOR_SECRET_KEY` | Anchor signer when SEP-10 or transaction operations require it | Secret. Prefer KMS-backed encrypted storage where the code path supports it. |
| `RELAYER_SECRET_KEY` | Relayer signer when relaying is enabled | Secret. Set spending limits and allowed spenders. |
| `RELAYER_PUBLIC_KEY` | Relayer public key when relaying is enabled | Public key. Must match the secret key. |
| `RELAYER_MAX_AMOUNT`, `RELAYER_ALLOWED_SPENDERS`, `RELAYER_EXPIRY_WINDOW` | Relayer risk limits | Non-secret policy values. Review with security. |

#### 4.3 KYC, Storage, Email, and Alert Configuration

| Variable | Requirement | Handling |
| --- | --- | --- |
| `KYC_PROVIDER` | Approved provider, not `mock` | Non-secret. Production launch must not use mock KYC. |
| `KYC_WEBHOOK_SECRET` | Provider webhook verification secret | Secret. Rotate with the provider. |
| `PERSONA_API_KEY`, `PERSONA_API_URL` | Required only for Persona | Secret plus approved URL. |
| `SHUFTI_CLIENT_ID`, `SHUFTI_SECRET_KEY`, `SHUFTI_API_URL` | Required only for Shufti | Secret plus approved URL. |
| `STORAGE_PROVIDER` | Approved object-storage provider | Non-secret. |
| `STORAGE_BUCKET`, `STORAGE_REGION` | Private KYC/object storage location | Non-secret identifiers. Enable encryption, retention, and access logging. |
| `AWS_S3_BUCKET`, `AWS_REGION` | Required for the S3 implementation | Non-secret identifiers. Prefer workload identity over static AWS keys. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Avoid in production when IAM roles are available | Secrets. Do not set if workload identity supplies credentials. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Required for password reset and alert email delivery | Credentials are secret. Use TLS and an approved sender domain. |
| `ALERT_EMAIL_RECIPIENTS` | On-call recipients | Non-secret routing data, but protect from unauthorized edits. |
| `ALERT_WEBHOOK_URL`, `ALERT_SLACK_WEBHOOK_URL` | Approved alert destinations | Secrets. Verify delivery without printing the URL. |
| `HOT_WALLETS` | JSON containing public keys, asset codes, issuers, and thresholds | Public identifiers and policy values. Never include private keys. |
| `HOT_WALLET_CHECK_INTERVAL_MS`, `HOT_WALLET_ALERT_COOLDOWN_SEC` | Approved monitoring cadence and de-duplication window | Non-secret policy values. |
| `ENABLE_KEY_ROTATION_WORKER`, `KEY_ROTATION_WORKER_CRON` | Enable only after a tested KMS rotation procedure exists | Non-secret control. Do not enable during first launch without approval. |

#### 4.4 Dashboard and Observability Services

| Service | Variables and configuration |
| --- | --- |
| Dashboard | `VITE_API_BASE_URL` must point to the production HTTPS API. Build-time values are public and must not contain secrets. |
| Prometheus | Use `prometheus.yml`, scrape `/metrics`, and probe `/health` through `infra/monitoring/blackbox.yml`. Protect Prometheus from public access. |
| Alertmanager | `PAGERDUTY_ROUTING_KEY` is required for the existing PagerDuty receivers. Inject it at runtime with config expansion enabled. |
| OpenTelemetry/Jaeger | Configure `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, and `OTEL_SERVICE_VERSION` only for the approved collector. Do not expose collector ports publicly. |
| Terraform | AWS credentials must come from the approved CI role or short-lived operator session. Do not store them in `terraform.tfvars`. |

Before deployment, compare the actual runtime configuration with this table and fail closed on missing production-critical values. Defaults such as localhost URLs, development JWT secrets, testnet endpoints, mock KYC, and empty alert destinations are not production configuration.

### Gate 5: Hot-Wallet Creation, Funding, and Verification

The application should hold only the minimum operational balance required for its approved settlement window. Keep treasury reserves and long-term funds outside the hot wallet. Use a separate cold or offline-controlled signer for material reserves.

#### 5.1 Establish the Wallet Inventory

- [ ] Assign a unique label and owner for each production wallet.
- [ ] Record only public keys, supported assets, issuer addresses, purpose, daily limit, and low-balance threshold in the change record.
- [ ] Confirm the wallet public keys match `RECEIVING_ACCOUNT`, `DISTRIBUTION_ACCOUNT`, `RELAYER_PUBLIC_KEY`, or the relevant deployment configuration.
- [ ] Confirm the private key custody path, KMS encryption context, access policy, rotation owner, and emergency disable procedure.
- [ ] Confirm no private key is present in `HOT_WALLETS`. `HOT_WALLETS` is a public monitoring configuration.

#### 5.2 Fund in Controlled Steps

1. Confirm the production network and destination public key through two-person verification.
2. Send the minimum XLM needed for account reserve, transaction fees, and the approved initial operating buffer from the approved treasury or funding account.
3. Confirm the funding transaction on the approved Horizon endpoint and record the transaction hash.
4. Establish required trustlines and fund supported issued assets using the same two-person verification.
5. If fee-bump or relayer operations are enabled, fund and verify those accounts separately. Apply the configured relayer maximum amount and allowed-spender policy.
6. Confirm the resulting balances and reserve requirements from an independent read-only account or explorer. Do not rely only on application logs.
7. Perform one low-value, reversible production-network transaction through the intended API/worker path. Confirm the transaction status, destination, fee, ledger inclusion, and database record.
8. Stop funding if any destination, network passphrase, issuer, signer, or transaction result differs from the approved change record.

#### 5.3 Configure and Test Low-Balance Alerts

Example shape for the public monitoring configuration, with real values supplied through the secret/configuration system:

```text
HOT_WALLETS=[{"label":"Production XLM withdrawal wallet","publicKey":"G...","assetCode":"XLM","thresholdAmount":1000}]
```

- [ ] Set thresholds above the minimum needed for safe operation and alert delivery time.
- [ ] Start the monitor with `HOT_WALLET_CHECK_INTERVAL_MS` and `HOT_WALLET_ALERT_COOLDOWN_SEC` approved by operations.
- [ ] Confirm the backend exports `anchorpoint_hot_wallet_balance` and `anchorpoint_hot_wallet_below_threshold`.
- [ ] Lower a non-production test wallet below threshold and verify Slack, email, or the approved custom webhook receives one alert.
- [ ] Verify Redis-backed alert de-duplication suppresses repeated notifications during the cooldown window.
- [ ] Verify the on-call operator can acknowledge and replenish without exposing private keys.

### Gate 6: Application and Worker Deployment

#### 6.1 Build and Validate the Exact Artifact

From `backend`:

```text
npm run build
npm run lint
npm test
```

Build the immutable production artifact from the approved commit. Record the image digest or artifact checksum. Do not build from a dirty workspace or inject secrets during the image build.

#### 6.2 Deploy in a Safe Order

1. Deploy or verify the database and Redis dependencies.
2. Run the pre-approved database migration job and verify migration status.
3. Deploy one API instance with production configuration.
4. Verify `/health`, `/metrics`, database connectivity, Redis connectivity, KMS access, and the configured Stellar endpoints.
5. Run a smoke test for authentication, one safe SEP flow, webhook verification, and the approved low-value transaction path.
6. Deploy additional API instances and confirm load-balancer health.
7. Start only the workers approved for production. The package scripts include:

   ```text
   npm run start:worker:recurring-payments
   npm run start:worker:key-rotation
   ```

8. Deploy the contract queue worker only after the release blocker in `backend/src/workers/contract-queue.worker.ts` is resolved and the worker has passed a production-network test plan.
9. Confirm worker queues are consuming, retrying, and dead-lettering as designed. Confirm no duplicate settlement occurs after restart.
10. Gradually shift traffic while watching error rate, latency, queue depth, database connections, Redis health, KMS errors, Horizon/RPC errors, and hot-wallet balance.

#### 6.3 Smoke-Test Checklist

- [ ] `GET /health` returns healthy only when database and Redis dependencies are healthy.
- [ ] `GET /metrics` is reachable by Prometheus and not publicly exposed.
- [ ] Authentication challenge and signature verification use the production network and signing key.
- [ ] SEP-24 interactive URLs use the production URL and allowed callback domains.
- [ ] KYC provider requests and webhook signatures work in production mode.
- [ ] One deposit or withdrawal smoke test reaches the expected status without using a material amount.
- [ ] Database transaction, Stellar transaction hash, and external reference are correlated.
- [ ] Worker restart does not lose or duplicate a queued job.
- [ ] Logs contain correlation IDs and operational error categories without secret material.

### Gate 7: Monitoring and Alerting Setup

The existing monitoring configuration is in `infra/monitoring/` and `prometheus.yml`.

#### 7.1 Deploy Monitoring Configuration

- [ ] Configure Prometheus to scrape the production API metrics endpoint at `/metrics`.
- [ ] Configure the blackbox exporter to probe the production API `/health` endpoint over HTTPS.
- [ ] Load `infra/monitoring/prometheus-alerts.yml` and verify the API target-down, health-check-failed, and health-check-flapping rules.
- [ ] Configure Alertmanager with `PAGERDUTY_ROUTING_KEY` through runtime secret injection and verify config expansion.
- [ ] Protect Prometheus, Alertmanager, blackbox exporter, and tracing UIs with network controls and authentication.
- [ ] Configure durable storage and retention for metrics and alert state according to the operations policy.
- [ ] Add or separately configure alerts for queue depth, failed jobs, database connections, Redis errors, KMS failures, RPC/Horizon failures, and hot-wallet thresholds.

#### 7.2 Validate the Alert Path

Perform these tests in the maintenance window:

1. Stop or isolate a disposable API instance and confirm `AnchorPointApiTargetDown` fires after the configured interval.
2. Make a disposable health probe fail and confirm `AnchorPointApiHealthCheckFailed` fires.
3. Restore the service and confirm PagerDuty receives the resolved notification.
4. Trigger a controlled hot-wallet low-balance test and confirm the configured alert channel reaches the on-call operator.
5. Introduce a controlled RPC failure in staging and confirm application errors, retries, circuit breakers, and alerts are visible.
6. Confirm every alert has a current runbook link and a named service/team label.

## Launch Completion Criteria

The release owner may declare production live only when:

- [ ] All known release blockers are resolved or formally accepted with an owner and expiry.
- [ ] Security, database, Stellar operations, and release approvals are recorded.
- [ ] KMS and RDS plans were reviewed and applied from immutable plan files.
- [ ] Database migrations are applied with no drift or pending migration.
- [ ] API and approved workers pass smoke tests on the public network.
- [ ] Hot-wallet balances, thresholds, funding transaction hashes, and custody controls are verified.
- [ ] PagerDuty, wallet alerts, logs, metrics, and dashboards have passed live-path tests.
- [ ] Rollback and incident contacts are available for the entire observation window.

Keep the release under heightened observation until the approved stability window has elapsed. Record final versions, artifact digests, migration IDs, KMS key alias, RDS identifier, Redis identifier, public endpoints, and alert-test timestamps without recording secrets.

## Incident Response

### Severity Guidance

| Severity | Example | Immediate posture |
| --- | --- | --- |
| SEV-1 | Suspected hot-wallet compromise, unauthorized signing, or loss of control of production funds | Stop value movement immediately, page security and Stellar operations, preserve evidence. |
| SEV-1 | Production API or RPC outage blocking settlement or causing uncertain transaction state | Pause risky retries and settlement, page platform and Stellar operations, reconcile state. |
| SEV-2 | Partial API outage, degraded RPC, failed workers, low balance, or alert delivery failure | Reduce or pause affected operations, page on-call, investigate within the incident SLA. |

### Hot-Wallet Compromise

Use this procedure when a private key may be exposed, an unexpected signature is observed, a wallet balance changes unexpectedly, or an operator cannot account for a transaction.

1. Declare SEV-1 and record the incident start time. Assign an incident commander and communications lead.
2. Immediately stop withdrawals, settlements, relayer writes, recurring payment workers, contract queue workers, and any other process that can sign or submit transactions. If necessary, remove the affected service from the load balancer.
3. Disable the affected API/worker IAM role's KMS decrypt permission or disable the affected KMS key only after confirming the impact and preserving evidence. Do not delete the key.
4. Revoke or disable the affected workload identity, secret-manager version, signer reference, webhook credentials, and operator sessions. Rotate credentials that may have been reachable from the compromised process.
5. Use an independent read-only path to list recent transactions for every affected public key. Record hashes, ledgers, destinations, asset codes, amounts, fees, and timestamps.
6. Move remaining funds to a pre-approved safe wallet using the emergency custody procedure. Require two-person verification of network, destination, and transaction envelope.
7. Do not attempt repeated retries while transaction state is uncertain. Reconcile Horizon/RPC results with database records before deciding whether a payment is pending, completed, or failed.
8. Preserve CloudTrail KMS events, workload logs, deployment artifacts, database audit records, Redis job state, access logs, and relevant provider responses. Store evidence in the restricted incident location.
9. Notify the security owner, treasury/custody owner, Stellar operations, affected partners, and legal/compliance contacts according to the incident policy.
10. Rotate or replace the signer only after the cause is understood. Update the public signing key and SEP metadata together, test SEP-10, and verify old keys cannot sign.
11. Restore service gradually with zero or minimal hot-wallet balance, enhanced transaction limits, and heightened monitoring.
12. Close the incident only after funds, signer access, database state, alerting, and customer communication are reconciled and a post-incident review has assigned corrective actions.

### RPC or Horizon Outage

Use this procedure when the approved Horizon or Soroban RPC endpoint times out, returns errors, reports stale ledgers, or becomes unreachable.

1. Declare SEV-1 if transaction state or customer funds are uncertain; otherwise declare SEV-2 and page the on-call operator.
2. Confirm the outage from an independent read-only network path. Check provider status, DNS/TLS, latency, latest ledger, and error rate before changing endpoints.
3. Pause new settlement, withdrawal, relayer, and contract-submission jobs if the service cannot determine whether a prior transaction was accepted. Do not blindly retry transaction submissions.
4. Keep read-only status endpoints available when safe, but communicate that settlement status may be delayed.
5. If the approved architecture has a pre-vetted secondary endpoint, switch only through a reviewed configuration change. Verify network passphrase, chain, Horizon/RPC API compatibility, rate limits, and ledger continuity before re-enabling writes.
6. Drain or quarantine retryable jobs. Preserve idempotency keys, transaction envelopes, sequence numbers, and provider responses.
7. Reconcile uncertain transactions from the ledger after service recovery. Compare on-chain results with database records and mark each job exactly once.
8. Resume writes in stages: read-only checks, low-value smoke transaction, one worker, then normal traffic. Monitor duplicate, sequence, timeout, and insufficient-balance errors.
9. If no approved endpoint is available, keep value movement paused and escalate to Stellar operations. Do not substitute a random public endpoint during an incident.
10. Document the outage interval, endpoint changes, affected jobs, customer impact, and any manual reconciliation.

### Database or Redis Failure

- Pause deployments and migrations.
- Preserve the last known-good application artifact and configuration references.
- For PostgreSQL, use the approved snapshot/restore procedure. Do not edit production tables manually unless the incident commander and database approver authorize it.
- For Redis, protect queued jobs from duplicate processing, confirm persistence and replication state, and restart workers only after queue ownership is understood.
- Reconcile database job state, Redis queue state, and on-chain transaction state before resuming settlement.

## Rollback and Recovery

### Application Rollback

1. Stop the rollout and keep the previous immutable artifact available.
2. If the database schema is backward compatible, route traffic to the previous artifact and leave the successful migration applied.
3. If the schema is not backward compatible, stop writes and use the approved migration-specific rollback or database restore plan.
4. Re-run health, KMS, Redis, database, Stellar, and smoke checks before restoring traffic.

### Key Recovery

- Never destroy the KMS key as a rollback action.
- Disable or revoke access first when compromise is suspected.
- Preserve the key for decryption of existing ciphertext until all encrypted data is re-encrypted and verified under the replacement key.
- Rotate the application signing key before any KMS key deletion is scheduled.
- Use the KMS module's deletion window and require a separate approval for key lifecycle changes.

### Database Recovery

- Identify the exact restore point and confirm the resulting data-loss window.
- Restore into an isolated instance first when time permits.
- Verify schema, row counts, indexes, job states, and transaction references.
- Reconcile all on-chain activity after the restore point before re-enabling workers.
- Record any customer-visible discrepancy and follow the incident communication policy.

## Repository References

- KMS provisioning and policy: [`infra/terraform/kms/main.tf`](../infra/terraform/kms/main.tf)
- KMS inputs and production lifecycle controls: [`infra/terraform/kms/variables.tf`](../infra/terraform/kms/variables.tf)
- KMS verification steps: [`infra/terraform/kms/QA_STEPS.md`](../infra/terraform/kms/QA_STEPS.md)
- RDS provisioning and backup settings: [`infra/terraform/rds/main.tf`](../infra/terraform/rds/main.tf)
- RDS variables: [`infra/terraform/rds/variables.tf`](../infra/terraform/rds/variables.tf)
- Migration scripts and integrity checks: [`backend/scripts/README.md`](../backend/scripts/README.md)
- Migration CI validation: [`migration-integrity.yml`](../.github/workflows/migration-integrity.yml)
- Backend environment schema: [`backend/src/config/env.ts`](../backend/src/config/env.ts)
- Backend environment template: [`backend/.env.example`](../backend/.env.example)
- Testnet service topology: [`docs/TESTNET_DEPLOYMENT_ARCHITECTURE.md`](./TESTNET_DEPLOYMENT_ARCHITECTURE.md)
- Hot-wallet monitor and metrics: [`backend/src/services/hot-wallet-monitor.service.ts`](../backend/src/services/hot-wallet-monitor.service.ts)
- Monitoring configuration: [`infra/monitoring/README.md`](../infra/monitoring/README.md)
- Prometheus scrape configuration: [`prometheus.yml`](../prometheus.yml)
- Alert rules and PagerDuty routing: [`infra/monitoring/prometheus-alerts.yml`](../infra/monitoring/prometheus-alerts.yml) and [`infra/monitoring/alertmanager.yml`](../infra/monitoring/alertmanager.yml)
