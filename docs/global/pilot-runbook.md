# Pilot Runbook

Operating a single-host pilot deployment: bring-up, migrations, verification, backup/restore,
tenant purge, joining an existing tenant, revoking one user's sessions, upgrades, and the alert-rule
table. This is the single-host Docker
Compose path, not a cloud deployment — see [What a cloud deployment would add](#what-a-cloud-deployment-would-add)
for what is deliberately not built.

## Prerequisites and secrets

There is one compose file, `docker-compose.yml`, and one env file, `.env`. `.env` is short by
design: the secrets (`JWT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`), the
one spend ceiling that bounds what those keys can spend (`MODEL_SPEND_DAILY_LIMIT_USD`),
`MODEL_PROVIDER`, and the optional `MONGO_AUTH` database-credential prefix — empty by default, which
leaves Mongo unauthenticated (`deployment-hardening.md` § Database authentication turns it on, and
`threat-model.md` §14 states what the default posture means). `.env.example` is the copy-and-fill
reference and lists exactly that set. `api`,
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
overridable at all: `MONGO_DB_URI`, `MONGO_MEMORY_SERVER`, `TEMPORAL_ADDRESS`, and `mcp`'s `MCP_PORT`.
These are in-network addresses and container-internal ports; a value set for any of them in `.env`
is ignored.

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
docker compose --profile full up -d --wait --wait-timeout 180
docker compose ps -a migrate   # must read "Exited (0)" — anything else and the stack did not come up
```

**`--profile full` is required.** `docker-compose.yml` gates every application service behind a
profile; the only service with none is `mongo`. Omitting `--profile full` starts `mongo` alone and
nothing else — no error, just a stack that looks like it came up and did not.

**Plain `up -d` returns exit code 0 even when `migrate` fails.** `api`, `worker` and `mcp` depend on
`migrate` via `condition: service_completed_successfully`; if `migrate` exits non-zero none of them
ever leaves `Created`, and Compose does not propagate that failure to the bring-up command's own
exit status — the operator sees success and a dead stack. `--wait` (`docker compose up --help`:
"Wait for services to be running|healthy") is the fix: a service gated on a failed `migrate` can
never reach `running`, so the wait cannot succeed and `up` exits non-zero once `--wait-timeout`
elapses. The help text does not spell out the exact exit-code contract on that path, so treat a
non-zero `up` as the strong signal it is, but do not rely on the exit code alone — `docker compose
ps -a migrate` reading `Exited (0)` is the direct check, and it is what the second command above
does. `--wait-timeout 180` bounds the wait at three minutes so a bring-up that cannot succeed fails
loudly instead of hanging — see Migrations below for why the first bring-up on a fresh volume can
legitimately take tens of seconds of that budget.

What the stack publishes to the host, every port bound to `127.0.0.1`:

| Service       | Host port                   | Notes                                                          |
| ------------- | --------------------------- | -------------------------------------------------------------- |
| `mongo`       | `${MONGO_HOST_PORT:-27018}` | No authentication unless enabled; loopback only, no override.   |
| `api`         | `${API_HOST_PORT:-3001}`    | `/api/v1/...` and `/docs` directly; loopback only, no override. |
| `mcp`         | `${MCP_HOST_PORT:-3002}`    | `POST /mcp`, PAT-authenticated. `MCP_BIND_ADDRESS` widens it.   |
| `web`         | `${WEB_HOST_PORT:-8090}`    | nginx, plain HTTP. `WEB_BIND_ADDRESS` widens it.                |
| `prometheus`  | 9090                        | No authentication. `--profile observability`, not `full`.       |
| `temporal`    | 7233                        | gRPC frontend, no authentication.                               |
| `temporal-ui` | 8233                        | Full workflow history, no authentication. `--profile temporal-ui`, not `full`. |

Mongo publishes 27018 rather than 27017, matching `environment.config.ts`'s dev-default
`MONGO_DB_URI` and `migrate-mongo-config.js`'s fallback, so a host-run process that falls back to
its own default reaches the deployed database instead of connecting nowhere. Overriding
`MONGO_HOST_PORT` breaks that agreement until `MONGO_DB_URI` is overridden to match.

Apart from the session cookie and the MCP surface's personal access tokens, nothing in front of these
ports authenticates anything: anyone who can reach them reads metrics and Temporal workflow history,
and connects to Mongo. (There are no traces to read — this stack runs no tracing; see
`threat-model.md` §6.) What bounds that reach is the loopback bind on every publish above —
so on a single host the surface is empty until an operator widens it, and there is still no firewall
rule, bastion or authenticating proxy in this repository. `WEB_BIND_ADDRESS`/`MCP_BIND_ADDRESS` are
the two widening knobs, and both publish plaintext HTTP, so they belong behind the TLS edge in
`deployment-hardening.md` — which also covers enabling database authentication and the reachability
scan that proves the bind actually held.

Prometheus and the Temporal UI are not in `full`: each reads across every tenant with no login, so
each is started by name (`--profile observability`, `--profile temporal-ui`) rather than arriving
with the application stack.

The application services are the exception — no metrics port is published. `src/instrumentation.ts`
offsets one shared `METRICS_PORT` per process, so `api` binds 9464 inside its own container,
`worker` 9465 and `mcp` 9466, and Prometheus reaches all three in-network. Each has its own scrape
job in `observability/prometheus/prometheus.yml`, and `alert-rules.yml` covers the MCP target's
liveness with `McpDown` exactly as it covers the worker's with `WorkerDown`.

`docker compose ps` should show `mongo`, `temporal` and `api` healthy, `migrate` exited `0`, and
`worker`, `mcp` and `web` running (those three declare no healthcheck, so `running` is as much as
Compose reports for them) — see Migrations below for what blocks that. `prometheus` and
`temporal-ui` appear only when their own profiles are enabled alongside `full`.

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

The surface advertises up to five tools. `search_evidence` and `get_answer` read; `request_resolution`
proposes a conflict resolution for a human to decide; `ask_evidence` starts a new question directly
from a PAT, without going through the API or SPA first; `verify_claims` grades caller-supplied claim
text against the tenant's corpus. `get_answer` is the poll for a question `ask_evidence` started — it
does not start one itself. `ask_evidence` and `verify_claims`, along with `search_evidence`, are
withheld from `tools/list` when the tenant's daily spend ceiling (`MODEL_SPEND_DAILY_LIMIT_USD`) is
disabled, since all three can reach a paid model or embedding call.

`mcp` depends on `mongo`, `temporal` and a successful `migrate`, the same as `api` and `worker` —
`request_resolution` and `ask_evidence` both start a workflow, so this surface needs Temporal even
though it runs no worker itself. `get_answer` and `verify_claims` do not.

## Migrations

Migrations are not a separate manual step for this bring-up path. `migrate` is a one-shot service
in the `full` profile (`command: npm run migrate:up`), gated on `mongo` reporting healthy, and
`api`/`worker`/`mcp` are in turn gated on `migrate` completing successfully
(`depends_on: migrate: condition: service_completed_successfully`). Bringing the stack up with the
command above runs migrations automatically, in order, before any application process starts.

`0001-baseline.ts` is the one worth watching: it creates the `$search`/`$vectorSearch`
indexes (along with every collection and every other index) and then blocks until Atlas reports both
`READY` and `queryable`, which takes tens of seconds on a fresh volume. `api` staying in a "starting"
state for that long during first bring-up is expected, not a hang.

`migrate` has its own `environment:` block rather than the shared anchor, setting `MONGO_DB_URI`
inline to the in-network mongo address. It loads no env file at all, so nothing needs to be set for
it beyond `mongo` being healthy.

If `migrate` exits non-zero, the application services never start — `docker compose ps` shows them
waiting on a dependency that failed rather than crash-looping. `docker compose logs migrate` has
the failing migration's error. This is the failure the `--wait` flag in [Bring-up](#bring-up) exists
to surface as a failing command instead of a silent one.

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
changelog already records `0001-baseline` as applied, so a plain `migrate:up` afterward no-ops and
retrieval silently returns zero rows. The script checks for this itself — after a `--yes` restore it
counts `evidence_chunks`'s search indexes via `$listSearchIndexes` and, if the count is zero, prints
the recovery it expects you to run:

```bash
docker compose exec -T mongo mongosh evidence-ops --eval \
  'db.migrations.deleteOne({fileName: /0001-baseline/})'
npm run migrate:up
```

Clearing that row re-runs the entire baseline migration, not just the search-index build — safely,
because the rest of what it does is idempotent against a store that already has everything but the
search indexes: every `createIndex` call no-ops against an index that already carries the same name
and key pattern, and the tenant registry write is an upsert. `createSearchIndexes` is the one step
that actually does new work, which is exactly the step this recovery needs.

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
[ADR-0013](../adr/0013-tenant-provisioning-and-default-tenant-demotion.md) — keeps that role after
the move, landing as a second admin of the target tenant rather than a member; use an invitation
instead when the target role should be `member`. It also leaves the vacated tenant's own `tenants`
registry row behind; if the moved user was that tenant's only member, the row becomes an orphaned,
empty tenant. `tenant-purge.ts --tenant <vacatedTenantId>` covers cleaning that up, since the
registry row itself carries a matching `tenantId` field.

## Revoking one user's sessions

`User.tokenVersion` is the session epoch every credential carries — minted into each JWT and into
each personal access token at issue, and compared against the row on every request
(`jwt-auth.guard.ts`, `api-keys.service.ts`). Raising it refuses every live browser session and
every personal access token that user holds, immediately, with no other attribute of the account
touched. Reach for it when a credential is suspected compromised or a departing user's access needs
to end now, rather than waiting out `JWT_EXPIRES_IN` (7 days).

```bash
npm run user:revoke-sessions -- --user <email>
```

`scripts/revoke-user-sessions.ts` refuses rather than guesses: an email with no matching row is
reported and nothing changes. The write is a single atomic increment against the row it already
located — never a value the caller supplies — so repeated invocations only ever move the epoch
forward, never set it to an arbitrary number.

What the user experiences: every open browser tab and every personal access token they hold stops
authenticating on its next request, each refused with the guard's generic `401`. The account's
role and tenant are untouched. Signing in again mints a fresh session at the new epoch and works
immediately; a refused personal access token has no revive path — the user mints a new one after
signing back in.

### Host-invoked scripts

`tenant-purge.ts`, `co-tenant-user.ts`, and `revoke-user-sessions.ts` connect to Mongo directly from
the host over TCP. They are not containerized and the runtime image does not contain them — the
`Dockerfile`'s `runtime` stage copies `node_modules`, `dist`, `migrations`,
`migrate-mongo-config.js` and `package.json`, not `scripts/`. Running any of them means a repo
checkout on the host with dependencies installed.

All three fall back to `mongodb://localhost:27018/evidence-ops?directConnection=true` when
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
docker compose --profile full up -d --build --wait --wait-timeout 180
docker compose ps -a migrate   # must read "Exited (0)" — anything else and the upgrade did not land
```

Back up first — an upgrade that includes a migration is not reversible by re-deploying the old
image once the migration has run. `--build` forces every image, including `migrate`'s, to rebuild
from the new source; because `migrate`'s image changes, Compose recreates that one-shot container
and re-runs it before the application services (gated on `service_completed_successfully`) start on
the new code. There is no separate manual migration step for an upgrade any more than there is for
the first bring-up. `--wait` is what fails this command when the new migration breaks — see
[Bring-up](#bring-up) for what it guarantees and what it does not.

**Never run `docker compose down -v`** as part of an upgrade or for any other reason short of the
stale-replica-set recovery the README's [Gotchas](../../README.md#gotchas) section documents — it
drops the `mongo` data volume and every document ingested.

### Upgrades that sign everyone out

A migration can carry a **session epoch** — a counter stamped into every credential and compared on
every request. `User.tokenVersion` and each `ApiKey.tokenVersion` are `0`-defaulting fields
established in `migrations/0001-baseline.ts`, applied and verified against a real `mongod` along
with the rest of the migration chain.

The compose path above is safe by construction: `migrate` completes before any application process
starts, so no request is ever served by code that expects an epoch against rows that do not carry
one. **A deployment that starts the API without running migrations first is not safe** — every login
then mints a credential the guard cannot match, and the failure is total rather than partial: nobody
can sign in, and every existing personal access token stops verifying. If you run the API outside
this compose stack, run `npm run migrate:up` to completion first and confirm it exited zero.

Expect an epoch-bearing upgrade to **sign every browser session out once**. That is the intended
one-time cost, not a fault. Personal access tokens are unaffected by a schema-introduction upgrade
of this kind: `ApiKey.tokenVersion` defaults to `0` alongside a freshly-defaulted user row, so the
two never diverge on their own — only [an operator raising a specific user's
epoch](#revoking-one-users-sessions) or a future migration that bumps the default would move them
apart. The signal that separates the expected invalidation from a real break is the post-deploy 401
rate:
a spike that decays as users sign back in is the migration; a rate that stays elevated is not.
Background on how `tokenVersion` moves a credential is in `threat-model.md` § 13.

Separately, a migration that rewrites derived keys — `0034-nfkc-group-keys` re-computes the
grouping key on every extracted fact and conflict — **is not reversible by redeploying the old
image**, which is why the backup above is the first command and not the last.

## Alert rules

One row per rule in `observability/prometheus/alert-rules.yml`, mounted read-only into the
`prometheus` service and loaded via `prometheus.yml`'s `rule_files`.

| Alert                | Symptom                                                                             | Probable cause                                                                                                             | First action                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkerDown`          | Prometheus has not scraped `evidence-ops-worker` for over a minute.                  | The worker container crashed or stopped; nothing is polling the Temporal task queue, so every started workflow queues forever. | `docker compose ps worker`, then `docker compose logs worker` for a crash reason before restarting.                                                     |
| `McpDown`             | Prometheus has not scraped `evidence-ops-mcp` for over a minute.                     | The MCP container crashed or stopped answering. Every MCP client integration is dark; the SPA and REST surfaces are unaffected, which is why it is `warning` — nobody inside the product notices. | `docker compose ps mcp`, then `docker compose logs mcp`.                                                                                                |
| `WorkflowFailures`    | A durable workflow run was recorded as failed.                                       | At pilot volume there is no defensible noise floor for this counter — any sustained failure rate is a real incident.        | Check the Temporal UI (`localhost:8233`) for the failed run's history and stack trace, then `docker compose logs worker` for the activity that raised.  |
| `GroundingRejectSpike`| The grounding gate is dropping claims well above its own recent 2-hour baseline.     | The failure most invisible to users — an answer still comes back, just with more of it cut for lacking a citation.          | Break down recent drops by the `rule` attribute (the four-value `GroundingViolationKind`) to see whether one violation kind dominates, then check for a recent source or model change. |
| `EmptyRetrievals`     | Retrieval has returned zero chunks more than isolated no-evidence questions explain. | A broken index, a corpus that stopped ingesting, or tenant scoping excluding everything.                                    | Confirm the `$search`/`$vectorSearch` indexes report `READY` (`0001-baseline.ts`), then check whether the most recent ingestion runs actually completed. |
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
- **Network boundary.** Every published port in the table above binds `127.0.0.1`, which is the
  whole of the boundary: Mongo and the Temporal UI included, and only the MCP surface authenticates
  callers at all. A firewall, a bastion, or an authenticating reverse proxy is assumed to exist
  around this stack and is defined nowhere in it —
  [`deployment-hardening.md`](./deployment-hardening.md) gives a reference edge to build one from,
  not one this repository operates.
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
