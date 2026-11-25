# ReachInbox Email Scheduler

A full-stack email scheduling demo built with TypeScript, Express, PostgreSQL, BullMQ/Redis, Elasticsearch, React, and Tailwind CSS. The dashboard uses real Google OAuth; Slack rate-limit alerts use Slack OAuth and send real `chat.postMessage` requests. SMTP delivery uses Ethereal Email.

## Features

| Area | Implemented |
| --- | --- |
| API | Authenticated sender and email scheduling APIs, status/search APIs, request validation, per-user idempotency |
| Durable scheduling | BullMQ delayed jobs in Redis with AOF persistence, PostgreSQL email records and queue recovery |
| Delivery | Ethereal SMTP, multiple configured senders, scheduled/sent/failed states |
| Throughput | Configurable BullMQ worker concurrency, Redis-atomic per-user and sender-wide hourly caps, sender-wide minimum inter-send delay |
| Slack | Connect/reconnect/disconnect OAuth flow; encrypted token storage; direct-message notification when a sender hits its hourly cap |
| Search | Elasticsearch indexing on scheduling and status changes; authenticated dashboard search |
| Queue visibility | Bull Board at `/admin/queues`, protected with HTTP Basic Auth |
| Frontend | Google login, responsive dashboard, CSV/TXT lead upload and email parsing, compose/schedule form, scheduled/sent tables, Slack controls |

## Prerequisites

- Node.js 22+ and npm
- Docker Desktop / Docker Compose
- Google OAuth web client credentials
- A Slack app configured for OAuth v2
- One or more SMTP test accounts from [Ethereal Email](https://ethereal.email)

## Local setup

1. Copy `backend/.env.example` to `backend/.env`.
2. Set the required secrets in `backend/.env`:
   - `JWT_SECRET`: at least 32 random characters.
   - `TOKEN_ENCRYPTION_KEY`: 64 hex characters (32 bytes). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `EMAIL_SENDERS`: JSON array of SMTP sender objects. Example:
     ```json
     [{"email":"reachinbox.demo@example.test","name":"ReachInbox Demo","user":"ETHEREAL_USER","pass":"ETHEREAL_PASSWORD","host":"smtp.ethereal.email","port":587}]
     ```
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   - `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`.
3. Configure Google OAuth:
   - Create an OAuth client of type **Web application**.
   - Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
   - Add the frontend origin (`http://localhost:5173` for local development) as an authorized JavaScript origin if requested.
4. Configure the Slack app:
   - Add redirect URL `http://localhost:4000/auth/slack/callback`.
   - Add bot token scopes `chat:write` and `im:write`, then install/reinstall the app in a workspace.
5. Start infrastructure:
   ```sh
   docker compose --env-file backend/.env up -d postgres redis elasticsearch
   ```
6. Install packages, generate Prisma Client, and apply the database migration:
   ```sh
   npm ci
   npm run db:generate
   npm run db:migrate
   ```
7. Start the API/worker and frontend:
   ```sh
   npm run dev
   ```
   Open `http://localhost:5173`. Configure `FRONTEND_URL=http://localhost:5173` and the OAuth callback URLs as above.

The backend runs at `http://localhost:4000`; its health endpoint is `/health`, and Bull Board is `/admin/queues`. Set `BULL_BOARD_PASSWORD` to a non-default value to enable the queue dashboard.

### Environment variables

See [`backend/.env.example`](backend/.env.example) for the complete list. Throughput controls:

- `WORKER_CONCURRENCY` sets BullMQ worker parallelism.
- `MIN_DELAY_BETWEEN_EMAILS_MS` is the minimum enforced interval between sends from the same configured sender across all tenants (default **2,000 ms**). The form can request a longer delay; the server always enforces at least this configured minimum.
- `DEFAULT_MAX_EMAILS_PER_HOUR` is both the per-user/sender ceiling and the sender-wide ceiling. The form's hourly value may choose a lower per-user limit; the server clamps it to this configured maximum.
- Schedule requests must include an `Idempotency-Key`. The UI generates one for each submission and the API returns the same saved records when that request is retried.

## Docker deployment / demo

After creating and configuring `backend/.env`, build and start the complete stack:

```sh
docker compose --env-file backend/.env up --build -d
```

Open `http://localhost:8080`. For the Docker demo, register Google and Slack callbacks at `http://localhost:4000/auth/google/callback` and `http://localhost:4000/auth/slack/callback`; set `FRONTEND_URL=http://localhost:8080`. The API is also exposed on port 4000 for OAuth callbacks. Before internet-facing deployment, use HTTPS, set `COOKIE_SECURE=true`, replace all demo passwords, and set OAuth callbacks and `FRONTEND_URL` to the actual HTTPS domains. Persist the Postgres, Redis, and Elasticsearch volumes or use managed services. Do not expose Redis, Postgres, Elasticsearch, or Bull Board publicly.

The backend container applies committed Prisma migrations before starting. The frontend Nginx container serves the app and proxies `/api`, `/auth`, `/health`, and `/admin` to the backend, keeping the browser session same-origin.

## API outline

- `GET /auth/google` and `GET /auth/google/callback` — Google OAuth login.
- `GET /api/me` — current user and Slack connection.
- `GET /api/senders` — configured senders and throughput defaults.
- `POST /api/emails` — schedule recipients; requires `Idempotency-Key`. JSON body:
  ```json
  {
    "senderEmail": "reachinbox.demo@example.test",
    "subject": "Hello",
    "body": "A message",
    "recipients": ["lead@example.com"],
    "startAt": "2026-12-01T10:00:00.000Z",
    "delayMs": 2000,
    "hourlyLimit": 100
  }
  ```
- `GET /api/emails?status=scheduled|sent|failed|all&search=lead` — list/search emails. Search terms are evaluated by Elasticsearch.
- `GET /auth/slack`, `GET /auth/slack/callback`, `DELETE /api/slack` — connect and disconnect Slack.
- `POST /auth/logout` — clear the session cookie.

All `/api` endpoints require a signed-in Google user. Sender credentials are server-side only; callers may schedule only senders configured by the operator.

## Architecture and operational behavior

1. The API validates the request and atomically saves email records plus the idempotency record in PostgreSQL.
2. It creates BullMQ jobs using the email UUID as the job ID and uses BullMQ delayed execution for the requested send time. Redis AOF and its named Docker volume persist queue data; Postgres independently persists the message records.
3. On startup, BullMQ restores delayed/waiting work from Redis, and the backend reindexes persisted email records into Elasticsearch. The application does not use cron or periodic polling. The queue retains completed/failed jobs for operational inspection.
4. Each worker reserves a send slot through one Redis Lua script. The script serializes both the per-user/sender and sender-wide hourly counters plus the sender-wide minimum spacing decision across worker processes. The active per-user/sender/hour cap is the lowest request limit observed during that UTC hour, clamped to the configured sender-wide maximum. When either hourly cap is full, BullMQ delays the job until the next UTC hour; the job is not dropped. When the spacing window is not yet open, it is delayed until the sender's next slot.
5. The configured concurrency controls parallel workers. Redis slot reservations limit start spacing even when workers run concurrently. A burst of 1,000 jobs is accepted in bulk and remains queued; the hourly cap and minimum spacing govern the drain rate. Ordering is best-effort across concurrent workers and delayed jobs.
6. On the first cap hit for a user/sender/hour, the backend opens a Slack DM and sends a real message if that user connected Slack. No connection is a normal no-notification case. The token is stored encrypted with AES-256-GCM; notification failures are logged and do not discard or fail the email job.
7. PostgreSQL status changes are indexed in Elasticsearch, which powers user-scoped dashboard search. Keep Elasticsearch available when creating schedules and searching.

### Delivery/idempotency trade-off

The database and queue make scheduled work durable, and stable BullMQ job IDs plus API idempotency prevent duplicate scheduling from client retries. The worker claims a record by changing `scheduled` to `sending` before SMTP I/O and skips an already-`sending` or `sent` record after a redelivery. This favors **at-most-once SMTP attempts**: a process crash after the claim but before SMTP can leave a record in `sending`, and a crash after the SMTP server accepts a message but before the DB update cannot be distinguished from a failed send. SMTP/Ethereal do not provide a transactional idempotency key, so true exactly-once delivery across those two systems is not possible. A production provider with idempotent send APIs or a reconciler/manual review workflow is needed to remove that boundary safely.

## Demo checklist

1. Sign in with Google and connect Slack from the dashboard.
2. Compose a message, upload a CSV/TXT file, confirm detected recipients, and schedule it.
3. Show the Scheduled table, then the Sent table and Ethereal preview URL logged by the worker.
4. Restart the backend while a future email is queued; confirm it still sends after the restart.
5. For a rate-limit demo, set a small hourly limit and zero requested delay, schedule more emails than the limit, and show that the extra jobs wait for the next hour and Slack gets a DM. The configured minimum send delay still applies.

The assignment did not include a Figma URL, so the dashboard uses an original, responsive layout rather than claiming pixel-perfect Figma matching.

### Five-minute demonstration

Before the demo, configure `backend/.env` with valid Google OAuth credentials and callback, one Ethereal SMTP sender, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and a non-empty Bull Board password. Slack is optional unless demonstrating notifications.

1. Start the stack and confirm service health:
   ```sh
   docker compose --env-file backend/.env up --build -d
   docker compose ps
   ```
   Continue when PostgreSQL, Redis, Elasticsearch, backend, and frontend show healthy/running status.
2. Open `http://localhost:8080`, select **Continue with Google**, and show the signed-in name/email in the dashboard.
3. Open **Compose new email**. Paste two addresses you control (or upload a small CSV), set the start time about one minute ahead, keep the configured delay, and schedule. Show both rows in **Scheduled** and open the protected **Queue dashboard**.
4. In another terminal, run `docker compose --env-file backend/.env logs -f backend`. After delivery, show the rows in **Sent emails** and open the Ethereal preview URL printed by the backend.
5. To demonstrate deferral without waiting an hour, schedule two recipients with an hourly limit of `1`; show the second job remains queued for the next UTC hour. If Slack is connected, show its direct-message alert. The lower per-user limit is combined with the configured sender-wide ceiling.

For local development instead of the Docker frontend, use the setup steps above and open `http://localhost:5173`.

## Environment variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | Backend HTTP port (default `4000`). |
| `FRONTEND_URL` | No | Browser origin used for CORS and OAuth redirects (default `http://localhost:5173`). |
| `DOCKER_FRONTEND_URL` | No | Compose frontend origin (default `http://localhost:8080`). |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Compose replaces this with the internal database URL. |
| `POSTGRES_PASSWORD` | Yes for Compose | PostgreSQL password; Compose reads it from `backend/.env` via `--env-file`. |
| `REDIS_URL` | No | BullMQ, rate-limit, and Slack-notice Redis connection. |
| `ELASTICSEARCH_URL` | No | Elasticsearch endpoint. Elasticsearch is required for application startup and search. |
| `ELASTICSEARCH_INDEX` | No | Search index (default `emails`). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Google OAuth; login returns a configuration error if unset. |
| `GOOGLE_CALLBACK_URL` | No | Google OAuth callback URL. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | No | Slack OAuth; Slack features are disabled if unset. |
| `SLACK_CALLBACK_URL` | No | Slack OAuth callback URL. |
| `JWT_SECRET` | Yes | Session signing key, at least 32 random characters. |
| `TOKEN_ENCRYPTION_KEY` | Yes | AES-256-GCM key, exactly 64 hexadecimal characters. |
| `COOKIE_SECURE` | Production | Set `true` when accessed through HTTPS. |
| `TRUST_PROXY_HOPS` | No | Trusted reverse-proxy count (default `1`). |
| `EMAIL_SENDERS` | No | JSON array of SMTP sender credentials; leave `[]` to run without scheduling. |
| `DEFAULT_MAX_EMAILS_PER_HOUR` | No | Per-user/sender and sender-wide hourly ceiling (default `100`). |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | No | Minimum send-start spacing (default `2000`). |
| `WORKER_CONCURRENCY` | No | BullMQ worker concurrency (default `5`). |
| `AUTH_REQUESTS_PER_MINUTE` | No | Per-IP auth endpoint limit (default `20`). |
| `SCHEDULE_REQUESTS_PER_MINUTE` | No | Per-user scheduling endpoint limit (default `30`). |
| `READ_REQUESTS_PER_MINUTE` | No | Per-user read endpoint limit (default `120`). |
| `BULL_BOARD_USER`, `BULL_BOARD_PASSWORD` | Password required to enable | HTTP Basic Auth for Bull Board; dashboard returns 503 when password is empty. |

## Automated checks and known limitations

Run the focused offline unit tests and production builds with:

```sh
npm test
npm run build
```

The tests cover scheduling-input validation, stable idempotency request hashing, and lead parsing. They do **not** establish PostgreSQL persistence, BullMQ recovery/retries/concurrency, Redis multi-worker rate limiting, SMTP delivery, Elasticsearch behavior, OAuth, or Slack notifications. Those service-level checks require the corresponding services and credentials; they were not run as part of this offline suite. `npm run db:migrate` applies the committed Prisma migrations.

The worker's delivery model is at-most-once after it claims a record. If the process crashes while a message is `sending`, or SMTP accepts a message immediately before the process crashes, the final outcome is ambiguous; there is no safe automatic retry without a provider idempotency API or manual reconciliation. Sender ordering is best-effort with concurrent workers and future scheduled jobs. Elasticsearch and PostgreSQL are required dependencies, not optional services.
