# Pilot Runbook

Operating a single-host pilot deployment: bring-up, migrations, verification, backup/restore,
tenant purge, joining an existing tenant, upgrades, and the alert-rule table. This is the single-host Docker
Compose path, not a cloud deployment — see [What a cloud deployment would add](#what-a-cloud-deployment-would-add)
for what is deliberately not built.

## Prerequisites and secrets

There is one compose file, `docker-compose.yml`, and one env file, `.env`. `.env` is short by
design: the secrets (`JWT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`), the
one spend ceiling that bounds what those keys can spend (`MODEL_SPEND_DAILY_LIMIT_USD`), and
`MODEL_PROVIDER`. `.env.example` is the copy-and-fill reference and lists exactly that set. `api`,
`worker` and `mcp` each load `.env` with `required: false`, so a missing file does not fail `up`;
the application's own config validation catches what actually matters (below).

Every non-secret knob the stack runs under is declared in `docker-compose.yml` itself, in the
top-level `x-app-environment` anchor merged into all three application services, with worker-only
knobs (Voyage embedding settings, extraction concurrency, inbox path, source sync interval) added
on `worker` and MCP-only knobs on `mcp`. Most use `${VAR:-default}`, so an operator overrides from
the shell without editing the file.

Two mechanics decide which value a container actually sees, and they point in opposite directions:

- An inline `environment:` value **always beats** `env_file`. That is why the knobs live in compose
  and not in `.env` — and equally why the spend ceiling is deliberately **absent** from compose.
  Declaring it inline would silently override the one an operator set in `.env`, which is the
  opposite of what a ceiling is for.
- Compose also reads `.env` when interpolating `${VAR:-default}`. For every knob written in that
  form, a `.env` entry does not lose to the inline value — it *becomes* it. A stray `NODE_ENV` or
  `MONGO_HOST_PORT` line in `.env` therefore changes the deployment, quietly. Keep the file to the
  keys `.env.example` lists.

A handful of values are written literally inline, with no `${}` around them, and are therefore not
overridable at all: `MONGO_DB_URI`, `MONGO_MEMORY_SERVER`, `TEMPORAL_ADDRESS`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, and `mcp`'s `MCP_PORT`. These are in-network addresses and
container-internal ports; a value set for any of them in `.env` is ignored.

`environmentSchema`'s `superRefine` (`src/config/environment/environment.config.ts`) is where the
application refuses to boot. The anchor sets `NODE_ENV: ${NODE_ENV:-production}`, and under
production the schema requires exactly two variables:

- `JWT_SECRET` — blank or unset aborts boot with a Zod validation error naming the field, before
  the process opens a port. This is the one variable an operator must put in `.env`.
- `MONGO_DB_URI` — the same refusal applies, but the anchor sets it inline to the in-network mongo
  address, so the requirement is satisfied by the compose file rather than by anything set by hand.

Everything else is functionally necessary for a working pilot but **not** enforced at construction:

- `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` parse as optional. The process boots and reports healthy
  with either blank — every ingestion and question-answering call then fails at the provider call,
  not at startup, because there is no model/embedding credential to send. Nothing at the config
  layer stops you from forgetting one.
- `CORS_ORIGIN` and `URL` each default to `http://localhost:8090` in the anchor. `URL` is log-only
  (`main.ts`'s boot banner); `CORS_ORIGIN` is functional — it is the single origin `app.enableCors`
  permits, so a pilot served from any other origin gets its cross-origin requests rejected by the
  browser with nothing wrong in the logs.

Config refusing to boot on a missing `JWT_SECRET`/`MONGO_DB_URI` is deliberate: a half-configured
process that starts anyway and fails requests one at a time is harder to diagnose than one that
refuses outright and names exactly what is missing.

## Bring-up

```bash
docker compose --profile full up -d
```

**`--profile full` is required.** `docker-compose.yml` gates every application service behind a
profile; the only service with none is `mongo`. Omitting `--profile full` starts `mongo` alone and
nothing else — no error, just a stack that looks like it came up and did not.

What the stack publishes to the host:

| Service       | Host port                   | Notes                                     |
| ------------- | --------------------------- | ----------------------------------------- |
| `mongo`       | `${MONGO_HOST_PORT:-27018}` | No authentication.                        |
| `api`         | `${API_HOST_PORT:-3001}`    | `/api/v1/...` and `/docs` directly.       |
| `mcp`         | `${MCP_HOST_PORT:-3002}`    | `POST /mcp`, PAT-authenticated.           |
| `web`         | `${WEB_HOST_PORT:-8090}`    | nginx, plain HTTP.                        |
| `jaeger`      | 16686 (UI), 4318 (OTLP)     | No authentication.                        |
| `prometheus`  | 9090                        | No authentication.                        |
| `temporal`    | 7233                        | gRPC frontend, no authentication.         |
| `temporal-ui` | 8233                        | Full workflow history, no authentication. |

Mongo publishes 27018 rather than 27017, matching `environment.config.ts`'s dev-default
`MONGO_DB_URI` and `migrate-mongo-config.js`'s fallback, so a host-run process that falls back to
its own default reaches the deployed database instead of connecting nowhere. Overriding
`MONGO_HOST_PORT` breaks that agreement until `MONGO_DB_URI` is overridden to match.

Apart from the MCP surface's personal access tokens, nothing in front of these ports authenticates
anything, and nothing in this repository bounds who can reach them: there is no firewall rule, no
bastion, no authenticating reverse proxy, and no host-binding restriction anywhere in the compose
file. Anyone who can reach the host on those ports can read traces, metrics and Temporal workflow
history, talk to the API, and connect to Mongo. Bounding that reach is entirely the operator's
concern.

The application services are the exception — no metrics port is published. `src/instrumentation.ts`
offsets one shared `METRICS_PORT` per process, so `api` binds 9464 inside its own container,
`worker` 9465 and `mcp` 9466, and Prometheus reaches all three in-network. Each has its own scrape
job in `observability/prometheus/prometheus.yml`, and `alert-rules.yml` covers the MCP target's
liveness with `McpDown` exactly as it covers the worker's with `WorkerDown`.

`docker compose ps` should show `mongo`, `prometheus`, `temporal` and `api` healthy, `migrate`
exited `0`, and `worker`, `mcp`, `web` and `temporal-ui` running (those four declare no
healthcheck, so `running` is as much as Compose reports for them) — see Migrations below for what
blocks that.

## The MCP surface

`mcp` is a third application process in the `full` profile, running `dist/mcp/main.js` from the
same image as `api` and `worker`. It exists separately because it speaks JSON-RPC over Streamable
HTTP on its own listener and authenticates with personal access tokens rather than the API's
bearer session — a different protocol and a different credential.

An MCP client posts to `http://<host>:${MCP_HOST_PORT:-3002}/mcp`. The container port is fixed at
3002 and only the host side is overridable, so an override cannot desynchronise the published
mapping from what the process binds. `GET` and `DELETE` on that path return a JSON-RPC "method not
allowed" — the transport runs stateless, generating no session id, so neither has anything to do.

Every call is gated before any MCP work starts, both gates failing closed: a missing, malformed,
revoked or expired PAT is a `401`, and a rate-limit hit is a `429`. The limit is charged per
JSON-RPC request found in the body rather than per HTTP POST, so a batch array cannot drive
hundreds of tool calls against a single decrement.

Operators mint a PAT from the SPA's **API keys** page (`/api-keys`), signed in as the user whose
tenant the token should act for. The token carries that user's tenant and identity; there is no
separate MCP account to provision.

The surface advertises three tools: `search_evidence` and `get_answer` read, and
`request_resolution` proposes a conflict resolution for a human to decide. Starting a question is
not among them — `get_answer` fetches a question someone already started through the API or SPA, by
its `answerId`.

`mcp` depends on `mongo`, `temporal` and a successful `migrate`, the same as `api` and `worker` —
`request_resolution` starts a workflow, so this surface needs Temporal even though it runs no
worker itself. The read tools do not.

## Migrations

Migrations are not a separate manual step for this bring-up path. `migrate` is a one-shot service
in the `full` profile (`command: npm run migrate:up`), gated on `mongo` reporting healthy, and
`api`/`worker`/`mcp` are in turn gated on `migrate` completing successfully
(`depends_on: migrate: condition: service_completed_successfully`). Bringing the stack up with the
command above runs migrations automatically, in order, before any application process starts.

`0003-search-indexes.ts` is the one worth watching: it creates the `$search`/`$vectorSearch`
indexes and then blocks until Atlas reports both `READY` and `queryable`, which takes tens of
seconds on a fresh volume. `api` staying in a "starting" state for that long during first bring-up
is expected, not a hang.

`migrate` has its own `environment:` block rather than the shared anchor, setting `MONGO_DB_URI`
inline to the in-network mongo address. It loads no env file at all, so nothing needs to be set for
it beyond `mongo` being healthy.

If `migrate` exits non-zero, the application services never start — `docker compose ps` shows them
waiting on a dependency that failed rather than crash-looping. `docker compose logs migrate` has
the failing migration's error.

## Verification

Confirm the stack is actually serving, not merely running:

1. **Every service up.**

   ```bash
   docker compose --profile full ps
   ```

2. **The application answers.** Both paths work — directly against the API's published port, or
   through `web`'s nginx proxy (`web/nginx.conf` proxies `location /api/` to `http://api:3000`):

   ```bash
   curl http://localhost:${API_HOST_PORT:-3001}/api/v1/health
   curl http://localhost:${WEB_HOST_PORT:-8090}/api/v1/health
   ```

   The proxied form is the one that also proves `web` is serving and its upstream resolves; the
   direct form isolates the API when the proxied one fails. A healthy response is
   `{"status":"ok","mongo":"up"}` (`HealthService.getHealth`). `"degraded"` / `"mongo":"down"` means
   the API process is up but cannot reach Mongo — the endpoint fails open and reports that rather
   than throwing, so a `200` with `"degraded"` is itself the failure signal, not a false positive.

   Swagger UI at `/docs` is reachable on the API's published port. It is **not** proxied by
   `web/nginx.conf`, which forwards only `/api/` — so there is no `/docs` behind the web port.

3. **The MCP listener is up and refusing unauthenticated calls.** `mcp` has no healthcheck, so this
   is the check that distinguishes a running container from a serving one:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:${MCP_HOST_PORT:-3002}/mcp
   ```

   `401` is the pass: the listener is bound and the PAT gate is failing closed. A connection refused
   means the process is not serving. Proving the surface end to end needs a real client and a PAT
   minted from the SPA's `/api-keys` page.

4. **The metrics pipeline is actually being scraped.** No application service publishes a metrics
   port to the host; Prometheus, running in-network, is the operator's window onto them:

   ```text
   http://localhost:9090/targets
   ```

   All three of `evidence-ops-api`, `evidence-ops-worker` and `evidence-ops-mcp` should show
   `State: UP`. This is the
   same proof `WorkerDown` (see the alert table below) is built on — `up{job="evidence-ops-worker"}`
   is Prometheus's own liveness series, present the moment a target is scraped successfully, before
   the application has ever processed a request. The four domain counters in
   `observability/prometheus/alert-rules.yml` (`evidence_ops_*_total`) only appear once the code path
   that increments them has actually run at least once — their absence at this point is expected on
   a fresh deploy, not a scrape failure.

5. **End to end.** Register a user, log in, upload a document, and ask a question — the walkthrough
   in the README's [Demo runbook](../../README.md#demo-runbook) is the authoritative version of
   these steps; the only difference here is the base URL (`http://localhost:${WEB_HOST_PORT:-8090}`
   instead of the host dev loop's `:5173`/`:3001`).

## Backup, restore, and tenant purge

Backup and restore operate against the compose-run `mongo` service via `docker compose exec`, not
over a published host port. That makes them independent of `MONGO_HOST_PORT` and of whether `mongo`
came up alone or under `--profile full`: `docker compose exec` targets an already-running container
by service name within the resolved project.

**Backup** (`scripts/backup/mongo-backup.sh`, wrapped as `npm run backup:mongo`):

```bash
npm run backup:mongo -- /path/outside/the/repo/evidence-ops-backup.gz
```

A single gzip `mongodump --archive` scoped to the `evidence-ops` database only. No default output
path inside the repo tree — an archive is real tenant data. It refuses to keep a partial or corrupt
archive: an empty file or a failed `gzip -t` integrity check both abort with the temp file removed,
never renamed into place. If the `mongo` image ships no `mongodump` binary, the script fails loudly
and prints the equivalent invocation against the official `mongodb/mongodb-database-tools` image,
attached to the mongo container's network namespace.

**Restore** (`scripts/backup/mongo-restore.sh`, wrapped as `npm run restore:mongo`):

```bash
npm run restore:mongo -- /path/outside/the/repo/evidence-ops-backup.gz         # dry run
npm run restore:mongo -- /path/outside/the/repo/evidence-ops-backup.gz --yes   # restores for real
```

Without `--yes` it prints exactly what would be dropped and replaced — every collection currently
in the database and its document count — and changes nothing. `--drop --nsInclude='evidence-ops.*'`
means only collections present in the archive are dropped and replaced; a live collection the
archive does not mention is left alone.

`--drop` also drops each restored collection's Atlas Search indexes, and the restored `migrations`
changelog already records `0003-search-indexes` as applied, so a plain `migrate:up` afterward
no-ops and retrieval silently returns zero rows. The script checks for this itself — after a
`--yes` restore it counts `evidence_chunks`'s search indexes via `$listSearchIndexes` and, if the
count is zero, prints the recovery it expects you to run:

```bash
docker compose exec -T mongo mongosh evidence-ops --eval \
  'db.migrations.deleteOne({fileName: /0003-search-indexes/})'
npm run migrate:up
```

Both lines work against a default bring-up. The first goes through `docker compose exec` and is
port-independent. The second runs on the host: `migrate-mongo-config.js` loads `.env` and otherwise
falls back to `mongodb://localhost:27018/evidence-ops?directConnection=true`, the port `mongo`
publishes by default — so from a repo checkout with dependencies installed, it reaches the deployed
database as printed.

It stops being correct in two cases, each with the same fix: if `MONGO_HOST_PORT` is overridden, or
if a `MONGO_DB_URI` line has been added to `.env`, pass the URI explicitly
(`MONGO_DB_URI="mongodb://localhost:<published-port>/evidence-ops?directConnection=true" npm run migrate:up`).
Where the host has no repo checkout or no Node toolchain, run the migration through the `migrate`
service instead — it uses the in-network address and needs no published port at all:

```bash
docker compose --profile full run --rm migrate
```

**Tenant purge** (`scripts/tenant-purge.ts`, wrapped as `npm run tenant:purge`) removes every
document belonging to one tenant, across every collection, including the GridFS bytes backing
document uploads — enumerated from `db.listCollections()` rather than a hardcoded list, so a
collection added later is covered automatically. It is driver-level, bypassing Mongoose and
`tenantScopePlugin` entirely, so nothing can silently re-scope or skip a query here.

```bash
npm run tenant:purge -- --tenant <tenantId>          # dry run: reports counts, changes nothing
npm run tenant:purge -- --tenant <tenantId> --yes    # deletes
```

See [Host-invoked scripts](#host-invoked-scripts) below for what these need from the host and when
`MONGO_DB_URI` has to be passed explicitly.

The `tenants` registry row itself is purged along with everything else — `Tenant` documents carry
their own `tenantId` field, so the same generic per-collection filter matches the tenant's own
registry entry, not only the data underneath it.

## Joining an existing tenant

Registration on its own always provisions a brand-new tenant per registrant
(`AuthService.register`). Two paths put a second user into a tenant someone else already
provisioned, and they cover different starting points: one for an invitee who has not registered
anywhere yet, one for a user who already has an account.

**Invitations, for someone who has not registered.** A tenant's own admin mints an invitation —
the SPA's Invitations page, or `POST /api/v1/invitations` with an `email` and a `role` — and gets
back a single-use token exactly once (`MintedInvitationResponseDto`; nothing persists it
server-side, so a lost response means minting again). The admin shares
`https://<host>/invite#token=<token>` with the invitee out of band; the token lives in the URL
fragment, never sent to the server as a query parameter, so it never reaches an access log. The
invitee opens that link, sets a password, and the SPA's redemption call
(`POST /api/v1/auth/register` with `invitationToken`) creates the account directly in the admin's
tenant, with the role the admin chose — `UserRole.Member` included, no host shell, no direct Mongo
access, no operator script. The token expires after `INVITATION_TTL_DAYS` (7 days) and is refused
if the invitee's email already has an account anywhere.

There is no revoke or recall for a pending invitation — `InvitationsController` exposes mint and
list only, and no operator script touches the `invitations` collection. An admin who mints one for
the wrong address cannot un-send it: the token stays redeemable by whoever holds the link until it
expires on its own, seven days out. The only earlier stop is deleting the `Invitation` document
directly against Mongo, which nothing in this repo wraps or documents further than that sentence.

**`scripts/co-tenant-user.ts`, for a user who already has an account.** Invitation redemption
refuses an email that is already registered, so moving an existing account into a different tenant
is still the operator script's job:

```bash
npm run tenant:co-tenant-user -- --user <email> --tenant <tenantId>
```

It refuses rather than guesses: the target tenant must already exist in the `tenants` registry and
the user must already exist, or nothing changes. It sets `tenantId` on the user row and on that
user's `api_keys` rows, and nothing else. The keys move so they stay listable and revocable by
their owner after the move; they also act in the new tenant from that point on, so review whether
the moved user should still hold them. It never touches `role`, so a user who arrives already
holding `UserRole.Admin` — every self-registered account does, per
[ADR-0014](../adr/0014-tenant-provisioning-and-default-tenant-demotion.md) — keeps that role after
the move, landing as a second admin of the target tenant rather than a member; use an invitation
instead when the target role should be `member`. It also leaves the vacated tenant's own `tenants`
registry row behind; if the moved user was that tenant's only member, the row becomes an orphaned,
empty tenant. `tenant-purge.ts --tenant <vacatedTenantId>` covers cleaning that up, since the
registry row itself carries a matching `tenantId` field.

### Host-invoked scripts

`tenant-purge.ts` and `co-tenant-user.ts` connect to Mongo directly from the host over TCP. They
are not containerized and the runtime image does not contain them — the `Dockerfile`'s `runtime`
stage copies `node_modules`, `dist`, `migrations`, `migrate-mongo-config.js` and `package.json`,
not `scripts/`. Running either means a repo checkout on the host with dependencies installed.

Both fall back to `mongodb://localhost:27018/evidence-ops?directConnection=true` when
`MONGO_DB_URI` is unset, which is the port `mongo` publishes by default — so against a default
bring-up they connect to the deployed database with no environment prefix at all. Two things break
that agreement, and both are fixed by passing the URI explicitly:

```bash
MONGO_DB_URI="mongodb://localhost:<published-port>/evidence-ops?directConnection=true" \
  npm run tenant:purge -- --tenant <tenantId>
```

- `MONGO_HOST_PORT` overridden, moving the published port away from 27018. `docker compose ps mongo`
  reports where it actually landed.
- A `MONGO_DB_URI` line added to `.env`. These scripts load it, so a host-loop or stale value there
  silently wins over the default — one more reason to keep `.env` to the keys `.env.example` lists.

## Upgrade

```bash
npm run backup:mongo -- /path/outside/the/repo/pre-upgrade.gz
git pull
docker compose --profile full up -d --build
```

Back up first — an upgrade that includes a migration is not reversible by re-deploying the old
image once the migration has run. `--build` forces every image, including `migrate`'s, to rebuild
from the new source; because `migrate`'s image changes, Compose recreates that one-shot container
and re-runs it before the application services (gated on `service_completed_successfully`) start on
the new code. There is no separate manual migration step for an upgrade any more than there is for
the first bring-up.

**Never run `docker compose down -v`** as part of an upgrade or for any other reason short of the
stale-replica-set recovery the README's [Gotchas](../../README.md#gotchas) section documents — it
drops the `mongo` data volume and every document ingested.

## Alert rules

One row per rule in `observability/prometheus/alert-rules.yml`, mounted read-only into the
`prometheus` service and loaded via `prometheus.yml`'s `rule_files`.

| Alert                | Symptom                                                                             | Probable cause                                                                                                             | First action                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkerDown`          | Prometheus has not scraped `evidence-ops-worker` for over a minute.                  | The worker container crashed or stopped; nothing is polling the Temporal task queue, so every started workflow queues forever. | `docker compose ps worker`, then `docker compose logs worker` for a crash reason before restarting.                                                     |
| `McpDown`             | Prometheus has not scraped `evidence-ops-mcp` for over a minute.                     | The MCP container crashed or stopped answering. Every MCP client integration is dark; the SPA and REST surfaces are unaffected, which is why it is `warning` — nobody inside the product notices. | `docker compose ps mcp`, then `docker compose logs mcp`.                                                                                                |
| `WorkflowFailures`    | A durable workflow run was recorded as failed.                                       | At pilot volume there is no defensible noise floor for this counter — any sustained failure rate is a real incident.        | Check the Temporal UI (`localhost:8233`) for the failed run's history and stack trace, then `docker compose logs worker` for the activity that raised.  |
| `GroundingRejectSpike`| The grounding gate is dropping claims well above its own recent 2-hour baseline.     | The failure most invisible to users — an answer still comes back, just with more of it cut for lacking a citation.          | Break down recent drops by the `rule` attribute (the four-value `GroundingViolationKind`) to see whether one violation kind dominates, then check for a recent source or model change. |
| `EmptyRetrievals`     | Retrieval has returned zero chunks more than isolated no-evidence questions explain. | A broken index, a corpus that stopped ingesting, or tenant scoping excluding everything.                                    | Confirm the `$search`/`$vectorSearch` indexes report `READY` (`0003-search-indexes.ts`), then check whether the most recent ingestion runs actually completed. |
| `ApprovalTimeouts`    | An approval gate timed out with no human decision.                                   | An operational fact about a person, not a technical error — a pending conflict resolution went unattended.                  | Check who the approval was routed to and whether they are unavailable, then decide whether to re-route it or extend the wait for that tenant.           |

## What a cloud deployment would add

This is a single Docker Compose stack on one host. Deliberately not built, and not to be assumed
present:

- **Managed Mongo with point-in-time recovery.** `mongo` is one container on one volume; the only
  restore point is whatever `scripts/backup/mongo-backup.sh` was last run against, taken whenever an
  operator remembered to run it — there is no continuous backup, no automated schedule, and no
  replica beyond the single node the image self-manages.
- **Secret management.** Every credential sits in `.env`, a plaintext file on the host readable by
  anything with host filesystem access. There is no vault, no rotation, and no audit trail for who
  read or changed it.
- **Network boundary.** Every published port in the table above is bound on the host, Mongo and the
  Temporal UI included, and only the MCP surface authenticates callers at all. A firewall, a
  bastion, or an authenticating reverse proxy is assumed to exist around this stack and is defined
  nowhere in it.
- **TLS termination.** `web/nginx.conf` listens on plain HTTP (`:80`) only, the MCP surface serves
  plain HTTP too, and the compose defaults for `CORS_ORIGIN`/`URL` are `http://localhost:8090`.
  Nothing in this stack terminates TLS; a reverse proxy or load balancer doing that in front of it
  is entirely outside what is defined here.
- **Horizontal scaling.** Every service is a single `docker compose` replica; there is no
  load balancer, no multi-node orchestration, and no story for running two `worker` processes
  against the same task queue beyond Temporal's own worker-side concurrency within that one process.
- **Log aggregation.** Logs live in each container's own stdout, reachable only via `docker compose
  logs <service>` on the host that is running it. There is no shipping to a central store, no
  retention policy beyond the Docker daemon's own log driver defaults, and no cross-service search.
