# ADR-0018 — Metrics and alerting shape: six signals, no dashboard, no pager

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

`src/instrumentation.ts` has run a `PrometheusExporter` in both the API and the worker process for a
while — `METRICS_PORT` for the API, `METRICS_PORT + 1` for the worker, so the two processes never
collide on one host. `src/providers/telemetry/domain-metrics.ts` defines five instruments against
that exporter: claims dropped by the grounding gate, empty retrievals, failed durable workflow runs,
approval timeouts, and a per-call model cost histogram. None of it was scraped. The threat model
already named this gap before this ADR closes any of it: § 6 states plainly that tracing exists,
alerting does not, and every fail-closed control in this codebase — a canary leak, a grounding
refusal, a budget cap being hit — "is visible only to someone already looking."

The failures this ADR targets share one property that makes "someone already looking" an
unacceptable answer: they are silent by construction. A grounding rejection, an empty retrieval, a
timed-out approval — none of these throw, none of these 500, none of these produce a support ticket.
Each one produces a response that looks like a normal one, to a caller who has no way to tell the
difference. A trace of the one request that hit any of these looks unremarkable in isolation; what
distinguishes a normal rate of grounding rejections from a model quietly losing its grounding is the
*rate*, not any single span. That is a metrics question, and Jaeger — already wired, per-request by
design — is the wrong tool to answer it. This ADR is the decision to scrape the instruments that
already exist and alert on the six that turn a threshold crossing into something a human sees
without first having a reason to go looking.

## Decision

### Metrics close the gap tracing structurally cannot

Every one of these six failure modes is defined by its aggregate behavior over a window, not by
any property a single request carries. One dropped claim is the grounding gate doing exactly what
ADR-0004 built it to do; a sustained rise in dropped claims is the model quietly losing its
grounding. One empty retrieval is a genuinely unanswerable question; a sustained rise is a broken
index or a corpus that stopped ingesting (the exact failure `docker-compose.yml`'s own `mongot`
comment documents having actually happened once, silently, before anyone measured it). Tracing
records what happened in one request; it has no notion of a rate crossing a threshold, and building
that notion on top of a trace backend would mean reimplementing exactly the counters and histograms
`domain-metrics.ts` already exports. Metrics are not a replacement for the tracing this codebase
already has — they answer a question tracing cannot, not a question tracing answers slowly.

### Six signals, each tied to something already emitted

`observability/prometheus/alert-rules.yml` defines exactly six rules, deliberately not one more:

- **WorkerDown**, from Prometheus's own `up{job="evidence-ops-worker"}` series. This is the only
  alert that depends on no application code emitting anything — it fires the moment the scrape
  target itself goes away — which also makes it the one alert provably testable without driving the
  application into a failure state: stop the worker container, watch it fire.
- **McpDown**, from the same `up{job="evidence-ops-mcp"}` mechanism as `WorkerDown` above. Every
  MCP client integration is dark while this holds, but the SPA and REST surfaces are unaffected —
  which is why it carries `severity: warning` rather than `critical`.
- **WorkflowFailures**, from `evidence_ops_workflow_run_failed_total`
  (`workflowRunFailedCounter`). A durable pipeline recording its own run as failed is already an
  application-level judgment that something broke; this alert just makes sure a human hears about
  it without polling Temporal's UI.
- **GroundingRejectSpike**, from `evidence_ops_grounding_claims_dropped_total`
  (`groundingClaimsDroppedCounter`). Named first among the six silent failures in the task this ADR
  responds to, and for good reason: a claim the grounding gate drops never reaches the caller as an
  error, it just makes the answer shorter. This is the alert that catches a model quietly losing its
  grounding — the threat model's own words for the failure mode nothing previously watched for.
- **EmptyRetrievals**, from `evidence_ops_retrieval_empty_total` (`emptyRetrievalCounter`). A
  sustained rise means the corpus, the search index, or tenant scoping broke, not that a run of
  questions happened to be unanswerable — the distinction only a rate, not a single request, can
  make.
- **ApprovalTimeouts**, from `evidence_ops_approval_timeout_total` (`approvalTimeoutCounter`). The
  odd one out on purpose: this is an operational fact about a person, not a technical failure —
  ADR-0009 built durable approval specifically so a human decides, and this alert exists for when
  that human doesn't, in time. It carries `severity: warning`, not `critical`, in the committed
  rules, matching that it names a process gap rather than a system defect.

`modelCostHistogram` gets no alert rule. Per-call cost is a distribution to look at, not a threshold
to cross — `SpendGuardModelProvider` already enforces `MODEL_SPEND_DAILY_LIMIT_USD` as a hard,
in-process budget cap, so an alert rule here would either duplicate that control or, worse, drift
from it if the two were ever tuned independently. This histogram exists for a dashboard this ADR
deliberately does not build (see § Deliberately out of scope below), not for this alerting pass.

### The low-cardinality attribute rule, restated as an alerting constraint

`domain-metrics.ts`'s own module comment already states the rule these instruments follow: every
attribute recorded is drawn from a small, fixed set — a violation rule, a rule-fired outcome, a
provider name — never a tenant id, user id, document id, or any text a user or a model produced. This
ADR does not relax that rule to make a "per-tenant empty-retrieval rate" alert possible, and that is
a deliberate omission, not an oversight the next cycle should fill in. A tenant id in a Prometheus
label is two problems at once, not one: a cardinality problem, because Prometheus keeps every
distinct label combination as its own time series indefinitely for the life of the metric, so a
per-tenant label turns five bounded instruments into a number of series that grows with the customer
list; and a privacy problem, because a tenant id in a metrics backend is the same category of leak
`OTEL_CAPTURE_MODEL_CONTENT` already exists as an opt-in, carefully bounded exception for — except a
metric label has no "attach as an event, not an attribute" mitigation available at all, since a
Prometheus label *is* the indexed, retained, queryable thing by construction. If a future cycle needs
per-tenant alerting, the correct instrument is a new, tenant-scoped counter built and reviewed for
that purpose specifically, not a label bolted onto one of these five.

### Committed config, container DNS, no volume for the TSDB

`observability/prometheus/prometheus.yml` scrapes `api:9464` and `worker:9465` by container DNS name
on `evidence_ops_net` — the same pattern `MONGO_DB_URI`/`TEMPORAL_ADDRESS`/
`OTEL_EXPORTER_OTLP_ENDPOINT` already use in `docker-compose.yml`, not a new one introduced for this
service. The `prometheus` compose service mounts `observability/prometheus/` read-only rather than
baking configuration into the image, so a rule change is a config edit and a container restart, not a
rebuild. It carries no named volume for its TSDB data, matching the call `qdrant` already makes for
the same reason: this is alerting infrastructure for a pilot, not a metrics archive, and losing
history across a recreate costs nothing an operator needs back. It sits in the `observability` and
`full` profiles, alongside `jaeger` — `docker compose up -d mongo` for a test run must not also start
a monitoring stack, so it is deliberately absent from the default, profile-less service.

## Deliberately out of scope

Grafana, Alertmanager, and paging are not in this change, and the omission is the point, not a gap to
close next. This is a pilot's minimum viable alerting — a way for the six silent failures above to
become visible to whoever is watching Prometheus's own alert list — not an SRE stack. Each of the
three has a real cost this pilot has no use for yet:

- **Grafana** turns these five counters into dashboards, which is a genuine need once there is
  someone whose job is to watch trends over days or weeks. Nobody has that job yet. A dashboard
  nobody looks at is strictly worse than no dashboard: it is another surface area to keep correct as
  `domain-metrics.ts` changes, for a return of zero, since Prometheus's own `/graph` already answers
  any ad hoc question this pilot has needed answered so far.
- **Alertmanager** turns a firing rule into routing, grouping, silencing, and deduplication —
  necessary once alerts fire often enough, or to enough people, that raw noise becomes the problem.
  At pilot scale, one rule firing is itself the entire signal; there is no fan-out to route and no
  noise to deduplicate. The `severity` label on every rule in `alert-rules.yml` is there so a future
  Alertmanager binding is additive, not a rewrite — the same seam-first shape ADR-0016 used for
  `TOKEN_VERIFIER` — but no such binding exists today.
- **Paging** assumes an on-call rotation this pilot does not have. A page with nobody carrying the
  pager is worse than a page nobody sent: it trains whoever eventually reads the tool that alerts
  don't mean anything, which is the exact failure mode the task brief's own words warn about — "a
  threshold nobody can justify gets muted, and a muted alert is worse than none." The six thresholds
  in `alert-rules.yml` are sized to be watchable by a person checking Prometheus's alert list
  directly, not to page anyone.

Adding any of the three later is a legitimate next step once there is a rotation to page, an audience
for a dashboard, or enough alert volume to need routing — none of which this pilot has today. Building
them now, ahead of that need, is exactly the over-engineering this cycle exists to avoid.

## Consequences

**Good.** Every failure the threat model's § 6 called out as invisible without someone already
looking now has a rule that surfaces it without that precondition — worker and MCP liveness provably
(kill either container, watch it fire), the other four by the same instruments the application
already emits.
The scrape config and alert rules are both plain committed text, reviewable in a diff like any other
change, not state accumulated by hand in a dashboard UI nobody exported.

**Costs.** A fourth long-running container in the `full`/`observability` profiles, with its own
memory budget to track alongside the seven services `docker-compose.yml` already runs. Six
thresholds chosen without production traffic to tune them against — each is defensible for a pilot,
none is validated by real incident data yet, and a threshold that turns out wrong in either direction
(too twitchy, muted; too loose, silent) is a config edit away from correct once real signal exists to
correct it against. A subtler cost: an OTel counter emits no sample at all until its first `add()`
call, so `WorkflowFailures`/`GroundingRejectSpike`/`EmptyRetrievals`/`ApprovalTimeouts` are absent
from `/metrics` in a freshly started deployment, and `rate()`/`increase()` cannot see a jump from
"series does not exist" to its first value — only a *second* increment inside the same window is
guaranteed to fire. `WorkerDown` and `McpDown` do not share this gap, because `up` is Prometheus's
own series and exists the moment a target is scraped at all, which is part of why `WorkerDown` is the
rule this cycle proves end to end rather than one of the four counter-backed rules.

**Deferred, deliberately.** Two residual risks from threat-model.md § 6 are unchanged by this ADR:
`OTEL_CAPTURE_MODEL_CONTENT` remains unwatched (it is a boolean flag, not a rate, and does not fit
this ADR's threshold-crossing shape), and `MODEL_SPEND_DAILY_LIMIT_USD` being hit is enforced but
still not alerted on — `SpendGuardModelProvider` refuses the call, but nothing tells a human it
happened. Both are legitimate next increments to this same alerting surface, not gaps this ADR
claims to close.

## Interview framing

> The reason this is six rules and not a dashboard: every one of these failures produces a plausible
> response and no error, which means the only thing that turns it into an event a human sees is an
> alert — a trace or a log line just sits there until someone already suspects a problem goes looking
> for it, and the threat model already said as much before I wrote a line of this. The one I'd defend
> hardest is `GroundingRejectSpike`, because it's the alert for the failure with no error path at
> all — the gate doing its job and the model quietly losing its grounding look identical in a single
> response, and only the rate tells them apart. And I'd be upfront about what I left out on purpose:
> Grafana, Alertmanager, and paging would all be real infrastructure for a system with an on-call
> rotation and enough alert volume to need routing. This pilot has neither, and building for them now
> would be solving a problem that doesn't exist yet at the cost of the one that does.

## Related

- `docs/global/threat-model.md` § 6 — the residual risk ("tracing exists; alerting does not") this
  ADR is the direct follow-up to; two of its named risks remain open, see § Consequences above.
- `docs/adr/0003-temporal-from-day-one.md` — the OTel/Jaeger tracing wiring this ADR deliberately
  does not duplicate for rate-based failures.
- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the verification whose per-claim
  rejections `GroundingRejectSpike` watches.
- `docs/adr/0009-durable-human-approval-gates.md` — the two-key approval control
  `ApprovalTimeouts` reports the human-side outcome of.
- `docs/adr/0016-mcp-server-surface.md` — the seam-first pattern (`TOKEN_VERIFIER`) `severity`
  labels here echo for a future Alertmanager binding this ADR does not build.
