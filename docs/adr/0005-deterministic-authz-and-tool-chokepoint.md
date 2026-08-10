# ADR-0005 — Deterministic authorization behind one tool chokepoint

- **Status:** Accepted — `ToolExecutorService` implemented, unit-tested to 100% branch coverage, and
  exercised by the canary security suite; **not yet wired into the Q&A path** — nothing in
  `src/features/evidence/**` calls it today
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

"The model proposes, the application disposes" applies to citations (ADR-0004) and equally to
action. The moment a model is allowed to call a tool — read a file, query a system, take an action
with a side effect — the same principle demands that *whether* the call is allowed is decided by
deterministic code the model has no path to influence, not by the model's own judgment about what
it should be permitted to do. No tool exists in this codebase yet. This ADR is about building the
chokepoint before the first tool, not after, so refusal is the default a future caller inherits
rather than a control someone has to remember to add under deadline.

## Decision

One service, `ToolExecutorService` (`src/features/platform/authz/tool-executor.service.ts`),
deliberately thin: a tool registry, a per-step allowlist, an injected deterministic authz hook, and
zod-strict argument validation. No tool ecosystem invented ahead of a real consumer.

### Four gates, fail CLOSED, evaluated in this order

1. **Tool registered?** An unrecognized tool name is refused before anything else runs.
2. **Tool on the current step's allowlist?** `ToolExecutionStep.allowedTools` is per-step, not
   global — a tool available in one step of a multi-step plan is refused in every other step unless
   that step lists it too. A model that successfully argues its way into a permission it does not
   have for the current step still cannot invoke it, because the allowlist is presented by the
   caller, not read from anything the model produced.
3. **Deterministic authz hook.** `ToolAuthzHook.authorize({ step, toolName })` is injected via a DI
   token (`TOOL_AUTHZ_HOOK`), the same seam `MODEL_PROVIDER` uses — swappable, but never supplied
   per call, because a per-call hook is itself a bypass vector (a caller that forgets to pass one,
   or passes a permissive stub under time pressure, silently reopens the gate). The interface is
   **synchronous** on purpose: an access decision is a computation over already-known facts, not an
   I/O operation, and keeping it synchronous removes a whole class of timeout/TOCTOU bugs from the
   one place this codebase can least afford one. A hook that throws is treated identically to a
   hook that returns `allowed: false` — refused, never treated as "no opinion, so allow". A broken
   permission check is not an open one; that is the failure-direction rule in
   `rules/code-hygiene.md` applied literally.
4. **zod-strict argument validation.** `ToolDefinition.argsSchema` is wrapped with `.strict()`
   **unconditionally and recursively**, at `registerTool`, rather than trusted to each tool author
   to remember — otherwise "unknown args are a refusal" is a convention the next tool eventually
   forgets rather than a chokepoint-wide guarantee. Plain `.strict()` only sets `unknownKeys:
   'strict'` on the top-level `ZodObject` it is called on; a nested object schema keeps zod's
   default `strip` and silently drops an unrecognized key one level down. `registerTool` closes
   that gap itself, recursing `.strict()` over every nested `ZodObject`, `ZodArray` element, and
   `ZodOptional`/`ZodNullable` wrapper. An argument key the schema does not name at any covered
   depth, or a value of the wrong type, is refused; nothing is ever silently stripped and passed
   through for the shapes this recursion covers (plain nested objects, arrays of objects,
   optional/nullable wrappers — see the doc comment on `applyStrictRecursively` in
   `tool-executor.service.ts` for what is deliberately not covered).

Checks run in this order — registry, then allowlist, then authz, then argument parsing —
deliberately before any work happens on the untrusted argument payload: access is decided on tool
identity and step context alone, before the call's own arguments (still fully attacker-controlled at
that point) are even parsed. Only a call surviving all four reaches the tool's own `handler`; a
handler-level exception at that point is the tool's own failure and is left to propagate rather than
folded into a refusal shape, so a real bug in a tool's implementation is never mistaken for a routine
access denial.

### The default binding is deny-all

`AuthzModule` binds `TOOL_AUTHZ_HOOK` to `DenyAllAuthzHook`, which refuses every call with a stated
reason ("no authorization policy is configured"). No authorization policy has been designed yet, so
the only honest default is refusal — an "allow until told otherwise" default is exactly the failure
mode `rules/code-hygiene.md`'s fail-closed rule exists to prevent. Wiring a real policy is a decision
a future caller makes explicitly by providing its own `TOOL_AUTHZ_HOOK` binding, not a default
anyone falls into by omission.

## The worked example this posture is built from

A recently found-and-fixed bug in `assemble-answer-messages.ts`'s `formatLabel` is the concrete case
for *why* this kind of validation has to be deterministic and server-side, not left to prompt
wording. A DOCX heading (attacker-controlled document text) was being placed into the evidence fence
as `locator="..."` — an attribute-value position. A heading crafted as
`Summary"> ... <x id="` could close the attribute early, using its own quote character as the
delimiter, and inject text the model would then read as being outside the evidence fence entirely.

The fix was not to escape the quote character better — it was to remove the attribute-value position
from the format altogether. Both `chunkId` and `locator` moved to their own bare lines
(`chunkId: ...`, `locator: ...`) inside the fence, with embedded newlines collapsed to a single
space. There is no longer a quote character anywhere in the format that a label could use as a
structural delimiter to escape from, because there is no attribute syntax left to escape out of.
`test/features/evidence/qa/synthesis.service.spec.ts`'s DOCX-heading-attribute-breakout test
reproduces the exploit's practical vector end-to-end and asserts the payload stays confined to its
one line.

The lesson generalizes directly to this ADR: a defense that depends on correctly escaping untrusted
input into a delimiter-based format is one crafted input away from breaking, no matter how careful
the escaping. Removing the delimiter position — or, for tool calls, removing the model's ability to
make the access decision at all — is what makes the defense structural rather than a race against the
next encoding trick. That is the same reason `ToolExecutorService`'s authz hook is not something the
model can pass arguments into or influence: there is no "escape" from a decision it never gets to
touch.

## Consequences

**Good.** When a tool is eventually wired, the chokepoint it must route through already exists,
already fails closed on all four axes, and already has 100% branch coverage on every refusal path.
Nothing has to be retrofitted under pressure once the first real tool shows up.

**Costs.** A service with no consumer is dead weight until one exists — justified here only because
the alternative (designing authz alongside the first tool, under the pressure of shipping that
tool's actual functionality) is how permission checks end up as an afterthought.

**Deferred, deliberately.** No real `ToolAuthzHook` implementation exists — only the deny-all
default. No tool is registered anywhere. Whether the eventual Q&A path calls tools via a workflow
activity (keeping side effects out of deterministic workflow code, per ADR-0003) or via a service
call is not decided here; this ADR is scoped to the chokepoint's own shape, not to where it gets
called from.

## Interview framing

> The thing I'd point at is the order of the four checks — access is decided before the arguments
> are even parsed, because parsing is doing work on an attacker-controlled payload and I wanted zero
> of that work to happen before the call is known to be allowed at all. The second thing: the authz
> hook is synchronous and injected once via DI, not passed per call. A per-call hook is a bypass
> vector — the one caller who forgets to pass a real one, or passes a stub while testing something
> else, silently reopens the gate. And the worked example I'd use to justify "deterministic and
> server-side" isn't hypothetical: the evidence-fence attribute-breakout was a real bug in this
> repo, fixed by removing the delimiter position a crafted string could exploit, not by escaping it
> more carefully. That's the same principle this chokepoint applies to tool access before the first
> tool exists to test it against.
