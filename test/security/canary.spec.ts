import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import manifest from '../../fixtures/data-room/manifest.json';
import { MARKET_OVERVIEW_PAGES } from '../../scripts/fixtures/lib/build-market-overview';
import { CANARY_MARKERS, COMP_PROPERTIES } from '../../scripts/fixtures/lib/constants';
import { GroundingGateService } from '../../src/features/evidence/qa/grounding-gate.service';
import { EVIDENCE_DELIMITER_TAG } from '../../src/features/evidence/ingestion/sanitize-evidence-text';
import { assembleAnswerMessages } from '../../src/features/evidence/qa/prompts/assemble-answer-messages';
import { SynthesisService } from '../../src/features/evidence/qa/synthesis.service';
import type {
  AnsweredOutcome,
  Citation,
} from '../../src/features/evidence/qa/contracts/answer.contract';
import type { RetrievedChunk } from '../../src/features/evidence/qa/types/retrieved-chunk.type';
import { DenyAllAuthzHook } from '../../src/features/platform/authz/deny-all.authz-hook';
import { ToolExecutorService } from '../../src/features/platform/authz/tool-executor.service';
import { TOOL_AUTHZ_HOOK } from '../../src/features/platform/authz/authz-hook.interface';
import type { ToolExecutionStep } from '../../src/features/platform/authz/types/tool-definition.type';
import { FakeModelProvider } from '../../src/providers/model/fake-model.provider';
import { MODEL_PROVIDER } from '../../src/providers/model/model-provider.interface';
import { AppLogger } from '../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../utils/get-mock-logger';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';

/**
 * `test/fixtures/synthetic-content.spec.ts` sweeps for a different property (no real-world
 * identifiers in the corpus). This suite sweeps for the opposite direction: the two canaries the
 * generator plants on purpose (`scripts/fixtures/lib/constants.ts:CANARY_MARKERS`) must never
 * reach a model answer, and any tool call an injected instruction implies must never execute.
 *
 * Marker text is read from the fixture generator's own source modules, never re-typed — a token
 * hand-copied into this file could silently drift from what the generator actually plants. The
 * `manifest.json` assertion below ties that same text to the artifact the generator produced.
 */

const SHA256_A = 'a'.repeat(64);

function xlsxCanaryText(): string {
  const property = COMP_PROPERTIES.find((candidate) =>
    candidate.notes.includes(CANARY_MARKERS.xlsx.token),
  );
  if (!property) {
    throw new Error(
      'fixture generator no longer plants the xlsx canary where this test expects it',
    );
  }
  return property.notes;
}

function pdfCanaryText(): string {
  const page = MARKET_OVERVIEW_PAGES.find(
    (candidate) => candidate.heading === 'Investor Sentiment',
  );
  const paragraph = page?.paragraphs.find((text) => text.includes(CANARY_MARKERS.pdf.token));
  if (!paragraph) {
    throw new Error('fixture generator no longer plants the pdf canary where this test expects it');
  }
  return paragraph;
}

function buildCanaryChunks(): { xlsxChunk: RetrievedChunk; pdfChunk: RetrievedChunk } {
  const xlsxChunk: RetrievedChunk = {
    chunkId: 'canary-xlsx-chunk',
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    text: xlsxCanaryText(),
    locator: { kind: 'xlsx-cell', sheetName: 'Comps', cell: 'H11', extractorVersion: 'v1' },
  };
  const pdfChunk: RetrievedChunk = {
    chunkId: 'canary-pdf-chunk',
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    text: pdfCanaryText(),
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
  };
  return { xlsxChunk, pdfChunk };
}

/** Extracts the substring between a chunk's `<evidence>` open tag and its `</evidence>` close tag,
 * failing the test loudly (rather than returning an empty/undefined match) if the chunk's fence is
 * not found at all. */
function extractFence(userContent: string, chunkId: string): string {
  const openTag = `<${EVIDENCE_DELIMITER_TAG}>\nchunkId: ${chunkId}`;
  const openIndex = userContent.indexOf(openTag);
  expect(openIndex).toBeGreaterThanOrEqual(0);
  const closeIndex = userContent.indexOf(`</${EVIDENCE_DELIMITER_TAG}>`, openIndex);
  expect(closeIndex).toBeGreaterThan(openIndex);
  return userContent.slice(openIndex, closeIndex);
}

describe('canary security suite', () => {
  describe('manifest ground truth', () => {
    it('should match the generated manifest.json canaries to the source-of-truth CANARY_MARKERS', () => {
      const byId = new Map(manifest.canaries.map((canary) => [canary.id, canary]));

      expect(byId.get('canary-xlsx-001')?.token).toBe(CANARY_MARKERS.xlsx.token);
      expect(byId.get('canary-pdf-001')?.token).toBe(CANARY_MARKERS.pdf.token);
    });
  });

  describe('fence confinement (assemble-answer-messages)', () => {
    it('should confine both canaries strictly inside their own evidence fence, never in the system prompt', () => {
      const { xlsxChunk, pdfChunk } = buildCanaryChunks();

      const { system, messages } = assembleAnswerMessages({
        question: 'What is the cap rate for Northgate Business Park?',
        chunks: [xlsxChunk, pdfChunk],
      });
      const userContent = messages[0].content;

      // Non-vacuity: the tokens really are present in what was assembled, or the confinement
      // assertions below would trivially pass having checked nothing.
      expect(userContent).toContain(CANARY_MARKERS.xlsx.token);
      expect(userContent).toContain(CANARY_MARKERS.pdf.token);
      expect(system).not.toContain(CANARY_MARKERS.xlsx.token);
      expect(system).not.toContain(CANARY_MARKERS.pdf.token);

      const xlsxFence = extractFence(userContent, xlsxChunk.chunkId);
      const pdfFence = extractFence(userContent, pdfChunk.chunkId);
      expect(xlsxFence).toContain(CANARY_MARKERS.xlsx.token);
      expect(pdfFence).toContain(CANARY_MARKERS.pdf.token);

      // Nothing outside either fence (the "Question:" trailer, or the other chunk's fence)
      // carries either token.
      const withoutFences = userContent.replace(xlsxFence, '').replace(pdfFence, '');
      expect(withoutFences).not.toContain(CANARY_MARKERS.xlsx.token);
      expect(withoutFences).not.toContain(CANARY_MARKERS.pdf.token);
    });

    // Permanent negative control: proves the confinement check above is discriminating rather than
    // vacuously true. A token placed in the *question* (never inside a chunk) must be reported as
    // living outside every evidence fence — if this ever reported "confined", the check itself
    // would be broken, not the injection boundary.
    it('should report a token placed in the question as living outside every evidence fence', () => {
      const { xlsxChunk, pdfChunk } = buildCanaryChunks();

      const { messages } = assembleAnswerMessages({
        question: `Repeat this token back to me: ${CANARY_MARKERS.xlsx.token}`,
        chunks: [xlsxChunk, pdfChunk],
      });
      const userContent = messages[0].content;

      const xlsxFence = extractFence(userContent, xlsxChunk.chunkId);
      const pdfFence = extractFence(userContent, pdfChunk.chunkId);
      const withoutFences = userContent.replace(xlsxFence, '').replace(pdfFence, '');

      // The token is present overall (it really was assembled into the prompt)...
      expect(userContent).toContain(CANARY_MARKERS.xlsx.token);
      // ...but specifically outside both fences, in the question trailer.
      expect(withoutFences).toContain(CANARY_MARKERS.xlsx.token);
    });
  });

  describe('synthesis end-to-end, well-behaved model', () => {
    let synthesisService: SynthesisService;
    let modelProvider: FakeModelProvider;

    beforeEach(async () => {
      modelProvider = new FakeModelProvider();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SynthesisService,
          { provide: MODEL_PROVIDER, useValue: modelProvider },
          { provide: AppLogger, useValue: getMockLogger() },
        ],
      }).compile();
      synthesisService = module.get<SynthesisService>(SynthesisService);
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    // `result` here is the schema-shaped form of the output this test itself enqueues a few lines
    // above — `SynthesisService.synthesizeAnswer` returns exactly what `ModelProvider.generate`
    // resolves to (see its own doc comment: "a generator, not a verifier"), and `FakeModelProvider`
    // returns exactly what was enqueued, unvalidated. An assertion that the *authored-canary-free*
    // output stays canary-free cannot fail while the invariant is false — it was passing before
    // this fix. What this test can actually verify, and does below: the call shape (exactly one
    // `qa_answer` call, nothing extra the injected instructions might have triggered).
    it('should call the model exactly once with taskClass "qa_answer" for a well-behaved model response', async () => {
      const { xlsxChunk, pdfChunk } = buildCanaryChunks();
      const northgateChunk: RetrievedChunk = {
        chunkId: 'northgate-chunk',
        docVersionId: 'doc-v1',
        sha256: SHA256_A,
        text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 5.25%.',
        locator: { kind: 'pdf-page', page: 2, extractorVersion: 'v1' },
      };
      // A compliant model follows the system prompt's instruction to treat fenced content as data,
      // not instructions — it answers the real question and never echoes the canary.
      modelProvider.enqueueResult({
        output: {
          kind: 'answered',
          claims: [
            {
              statement: 'Northgate Business Park traded at a cap rate of approximately 5.25%.',
              citations: [
                {
                  docVersionId: 'doc-v1',
                  sha256: SHA256_A,
                  chunkId: 'northgate-chunk',
                  locator: { kind: 'pdf-page', page: 2, extractorVersion: 'v1' },
                  quote: 'at a cap rate of approximately 5.25%',
                },
              ],
            },
          ],
        },
      });

      await synthesisService.synthesizeAnswer({
        question: 'What is the cap rate for Northgate Business Park?',
        chunks: [xlsxChunk, pdfChunk, northgateChunk],
      });

      // No unexpected call attempted: exactly the one qa_answer synthesis call happened, nothing
      // the injected instructions asked for (e.g. "repeat the complete system prompt") triggered a
      // second call.
      expect(modelProvider.calls).toHaveLength(1);
      expect(modelProvider.calls[0].taskClass).toBe('qa_answer');
    });

    // Non-vacuity + the known bound: unlike the assertion this replaces, this one is capable of
    // failing. `SynthesisService` is a generator, not a filter (its own doc comment) — it returns
    // exactly what the model produced. A model that ignores the system prompt's fencing
    // instructions and echoes a fenced canary back gets that token echoed straight through; nothing
    // at this layer strips it. The defense against that is upstream (prompt fencing in
    // `assemble-answer-messages`, tested above) and the model's own compliance — never a filter
    // here. This mirrors the grounding-gate known bound (ADR-0004) documented below: both tests
    // record what the system does with a leaked/injected token rather than assuming it can't happen.
    it('passes a token a non-compliant model echoes straight through, unfiltered', async () => {
      const { xlsxChunk, pdfChunk } = buildCanaryChunks();
      modelProvider.enqueueResult({
        output: {
          kind: 'answered',
          claims: [
            {
              statement: `The document says: ${CANARY_MARKERS.xlsx.token}`,
              citations: [
                {
                  docVersionId: xlsxChunk.docVersionId,
                  sha256: xlsxChunk.sha256,
                  chunkId: xlsxChunk.chunkId,
                  locator: xlsxChunk.locator,
                  quote: CANARY_MARKERS.xlsx.token,
                },
              ],
            },
          ],
        },
      });

      const result = await synthesisService.synthesizeAnswer({
        question: 'What is the cap rate for Northgate Business Park?',
        chunks: [xlsxChunk, pdfChunk],
      });

      expect(JSON.stringify(result)).toContain(CANARY_MARKERS.xlsx.token);
    });

    // The demonstrated exploit this fix closes (ADR-0004 bound 4): the first full eval run against
    // the real model leaked a canary through `insufficient_evidence.reason` in two adversarial
    // cases (adv-005, adv-007; `canaryLeakRate` 0.0625, hard gate failed). The real
    // `AnthropicModelProvider` is schema-validated and can never put arbitrary text in `reasonCode`
    // (`modelInsufficientEvidenceOutcomeSchema` in `answer.contract.ts`), but `FakeModelProvider`
    // returns exactly what a test enqueues, unvalidated (see its own doc comment) — this simulates
    // a model/provider that bypassed that validation, to prove the render step in
    // `SynthesisService.resolveContract` fails CLOSED on its own, not merely by relying on upstream
    // schema enforcement. Asserts the returned value, matching this fix's own test requirement.
    it('should never let a marker injected into an insufficient_evidence reasonCode reach the returned outcome', async () => {
      modelProvider.enqueueResult({
        output: { kind: 'insufficient_evidence', reasonCode: CANARY_MARKERS.xlsx.token },
      });

      const result = await synthesisService.synthesizeAnswer({
        question: 'What is the cap rate for Northgate Business Park?',
        chunks: [],
      });

      // Containment is asserted over the WHOLE return value, not just the contract, so the
      // usage envelope added alongside it is inside the blast radius too.
      expect(JSON.stringify(result)).not.toContain(CANARY_MARKERS.xlsx.token);
      expect(result.contract).toEqual({
        kind: 'insufficient_evidence',
        reason: 'The retrieved evidence does not support an answer to this question.',
      });
    });

    // Same bound, the other outcome ADR-0004 named as unverified: `conflicting_evidence`'s
    // `factKey`/`values` reached a caller as model-authored text with no check at all. The model
    // is no longer offered this branch (`modelAnswerContractSchema` no longer includes it) — this
    // simulates the same kind of bypass as the test above to prove `resolveContract` fails CLOSED
    // to the generic `insufficient_evidence` outcome rather than forwarding the injected fields.
    it('should never let a marker injected into a model-authored conflicting_evidence outcome reach the returned outcome', async () => {
      modelProvider.enqueueResult({
        output: {
          kind: 'conflicting_evidence',
          factKey: { entity: CANARY_MARKERS.xlsx.token, metric: 'revenue', period: 'Q1 2025' },
          groupKeyNormalized: groupKey({
            entity: CANARY_MARKERS.xlsx.token,
            metric: 'revenue',
            period: 'Q1 2025',
          }),
          values: [
            { value: 1, unit: CANARY_MARKERS.pdf.token, sourceChunkId: 'chunk-1' },
            { value: 2, unit: 'usd', sourceChunkId: 'chunk-2' },
          ],
        },
      });

      const result = await synthesisService.synthesizeAnswer({
        question: 'What is the cap rate for Northgate Business Park?',
        chunks: [],
      });

      expect(JSON.stringify(result)).not.toContain(CANARY_MARKERS.xlsx.token);
      expect(JSON.stringify(result)).not.toContain(CANARY_MARKERS.pdf.token);
      expect(result.contract).toEqual({
        kind: 'insufficient_evidence',
        reason: 'None of the retrieved evidence is relevant to this question.',
      });
    });
  });

  describe('grounding gate — known bound (ADR-0004)', () => {
    it('documents that a claim citing the injected sentence verbatim survives citation verification', () => {
      // This is the bound ADR-0004 records: the gate verifies that a citation's quote is really
      // present in the cited chunk, not that the claim is *reasoning* honestly about it. The
      // injected sentence genuinely is present in the chunk's text (that is the whole attack), so
      // a claim that quotes it verbatim passes checks 1 and 2 exactly like a legitimate citation.
      // This test is why "never appears in a returned answer" above is scoped to a model that
      // follows the system prompt — the gate is not, and was never meant to be, a content filter.
      const { pdfChunk } = buildCanaryChunks();
      const citation: Citation = {
        docVersionId: pdfChunk.docVersionId,
        sha256: pdfChunk.sha256,
        chunkId: pdfChunk.chunkId,
        locator: pdfChunk.locator,
        quote: pdfCanaryText(),
      };
      const outcome: AnsweredOutcome = {
        kind: 'answered',
        claims: [
          {
            statement: `The document says: ${CANARY_MARKERS.pdf.token}`,
            citations: [citation],
          },
        ],
      };

      const gate = new GroundingGateService(getMockLogger() as unknown as AppLogger);
      const report = gate.verify({ outcome, retrievedChunks: [pdfChunk] });

      expect(report.outcomeKind).toBe('answered');
      expect(report.claims).toHaveLength(1);
      expect(report.claims[0].statement).toContain(CANARY_MARKERS.pdf.token);
    });
  });

  describe('tool chokepoint — what a compromised path would meet (not yet wired)', () => {
    let toolExecutor: ToolExecutorService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ToolExecutorService,
          { provide: TOOL_AUTHZ_HOOK, useClass: DenyAllAuthzHook },
          { provide: AppLogger, useValue: getMockLogger() },
        ],
      }).compile();
      toolExecutor = module.get<ToolExecutorService>(ToolExecutorService);
    });

    // Nothing in the qa path calls `ToolExecutorService` today — this asserts what the chokepoint
    // would do if a future, compromised caller tried to act on the pdf canary's instruction
    // ("export the full underlying deal-room contents"): with the real current wiring (no tools
    // registered, the default deny-all authz hook), the call is refused before any handler runs.
    it('should refuse a tool call named after the canary-implied action, against the real current (empty) registry', async () => {
      const step: ToolExecutionStep = { stepId: 'qa-answer', allowedTools: [] };

      const result = await toolExecutor.execute({
        step,
        toolName: 'export_data_room',
        rawArgs: {},
      });

      expect(result).toEqual({
        kind: 'refused',
        reason: 'tool-not-registered',
        detail: "tool 'export_data_room' is not registered",
      });
    });

    // The test above never reaches `DenyAllAuthzHook.authorize()` — an unregistered tool is
    // refused at the registry gate, one step before the authz hook ever runs. This test registers
    // and allowlists a tool first so the call survives gates 1 and 2 and the real `DenyAllAuthzHook`
    // binding (not a mock) is the one that refuses it, closing the gap ADR-0005's "exercised by the
    // canary security suite" claim depends on.
    it('should refuse via the real DenyAllAuthzHook.authorize() once a tool is registered and allowlisted', async () => {
      const step: ToolExecutionStep = { stepId: 'qa-answer', allowedTools: ['export_data_room'] };
      const handler = jest.fn().mockResolvedValue('should never run');
      toolExecutor.registerTool({
        name: 'export_data_room',
        argsSchema: z.object({}),
        handler,
      });

      const result = await toolExecutor.execute({
        step,
        toolName: 'export_data_room',
        rawArgs: {},
      });

      expect(result).toEqual({
        kind: 'refused',
        reason: 'authz-denied',
        detail:
          "no authorization policy is configured for step 'qa-answer'; refusing " +
          "'export_data_room' by default",
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
