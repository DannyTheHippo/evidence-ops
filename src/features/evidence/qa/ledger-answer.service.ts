import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  DocumentVersion,
  type DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  type EvidenceChunkDocument,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  type ExtractedFactDocument,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { CellDecision } from '../ledger/resolve-cell';
import { LedgerService, type LedgerResolution } from '../ledger/ledger.service';
import { buildLedgerClaim } from './build-ledger-claim';
import type { AnswerContract, LedgerDecision } from './contracts/answer.contract';
import { QuestionResolverService, type QuestionResolution } from './question-resolver.service';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export type LedgerAnswerResult =
  | { readonly kind: 'unresolved'; readonly reason: string }
  | {
      readonly kind: 'resolved';
      readonly outcome: AnswerContract;
      readonly retrievedChunks: readonly RetrievedChunk[];
      readonly conflictIds?: readonly string[];
    };

/** The representative `ExtractedFact` a resolved ledger cell answers from, plus its own id —
 *  loaded once so the caller never re-queries for what selected it. */
interface RepresentativeFact {
  readonly factId: string;
  readonly fact: ExtractedFactDocument;
}

/** `CellDecision`'s fields (`resolve-cell.ts`) projected onto `ledgerDecisionSchema`'s shape
 *  (`contracts/answer.contract.ts`) — the same fields, `resolvedAt` rendered as an ISO string
 *  rather than a `Date`.
 *
 *  `winningFactId` comes from the representative fact the caller already loaded rather than from
 *  `decision.winningFactId`, because the two are the same id wherever this runs: only an
 *  adjudicated cell carries a decision, and `loadRepresentativeFact` returns for an adjudicated
 *  cell only when `decision.winningFactId` is set, returning exactly that id. Reading it off the
 *  decision again would reintroduce an `undefined` case that cannot occur. */
function toLedgerDecision(decision: CellDecision, winningFactId: string): LedgerDecision {
  return {
    conflictId: decision.conflictId,
    outcome: decision.outcome,
    winningFactId,
    ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    resolvedAt: decision.resolvedAt.toISOString(),
    ...(decision.ruleFired !== undefined ? { ruleFired: decision.ruleFired } : {}),
    ...(decision.followedProposal !== undefined
      ? { followedProposal: decision.followedProposal }
      : {}),
  };
}

/**
 * Answers a question straight from the fact ledger when `QuestionResolverService` pins it to
 * exactly one `(entity, measure, period)` cell — no retrieval, no model call. Every fork fails
 * CLOSED toward `unresolved`: a cell this service cannot back with a citation the grounding gate
 * would itself accept must never reach `AnswerContract` at all, since the caller
 * (`resolveFromLedger`) treats `unresolved` as "run the synthesis path instead", never as a
 * degraded answer.
 */
@Injectable()
export class LedgerAnswerService {
  constructor(
    private readonly questionResolver: QuestionResolverService,
    private readonly ledgerService: LedgerService,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(LedgerAnswerService.name);
  }

  async resolve(input: {
    readonly questionText: string;
    readonly tenantId: string;
  }): Promise<LedgerAnswerResult> {
    const { questionText, tenantId } = input;

    const question = await this.questionResolver.resolve(questionText, tenantId);
    if (question.kind === 'unresolved') {
      return { kind: 'unresolved', reason: question.reason };
    }

    const ledger = await this.ledgerService.resolveValue({
      tenantId,
      entity: question.entity,
      measure: question.measure,
      period: question.period,
    });

    if (ledger.state === 'unknown') {
      return { kind: 'unresolved', reason: 'unknown' };
    }
    if (ledger.state === 'conflicted') {
      return this.buildConflictedResult(tenantId, ledger);
    }
    return this.buildAnsweredResult(tenantId, ledger, ledger.state, question);
  }

  private async buildAnsweredResult(
    tenantId: string,
    ledger: LedgerResolution,
    state: 'single' | 'adjudicated',
    question: Extract<QuestionResolution, { kind: 'resolved' }>,
  ): Promise<LedgerAnswerResult> {
    const representative = await this.loadRepresentativeFact(tenantId, ledger, state);
    if (!representative) {
      return { kind: 'unresolved', reason: 'representative-fact-not-found' };
    }
    const { factId, fact } = representative;

    const [chunk, version] = await Promise.all([
      this.evidenceChunkModel.findOne({ _id: fact.chunkId, tenantId }),
      this.documentVersionModel.findOne({ _id: fact.documentVersionId, tenantId }),
    ]);
    if (!chunk) {
      return { kind: 'unresolved', reason: 'chunk-not-found' };
    }
    if (!version) {
      return { kind: 'unresolved', reason: 'document-version-not-found' };
    }

    const claim = buildLedgerClaim({
      fact: {
        factKey: fact.factKey,
        value: fact.value,
        rawText: fact.rawText,
        chunkId: fact.chunkId,
        documentVersionId: fact.documentVersionId.toString(),
        locator: fact.locator,
      },
      chunkText: chunk.text,
      sha256: version.sha256,
      entityLabel: ledger.entity,
      measureLabel: ledger.measure,
    });
    if (!claim) {
      return { kind: 'unresolved', reason: 'ledger-claim-unverifiable' };
    }

    return {
      kind: 'resolved',
      outcome: {
        kind: 'answered',
        claims: [claim],
        ledger: {
          entity: ledger.entity,
          measure: ledger.measure,
          ...(question.period !== undefined ? { period: question.period } : {}),
          state,
          factId,
          ...(ledger.winnerWithdrawn !== undefined
            ? { winnerWithdrawn: ledger.winnerWithdrawn }
            : {}),
          ...(ledger.decision !== undefined
            ? { decision: toLedgerDecision(ledger.decision, factId) }
            : {}),
        },
      },
      retrievedChunks: [
        {
          chunkId: fact.chunkId,
          docVersionId: fact.documentVersionId.toString(),
          sha256: version.sha256,
          text: chunk.text,
          locator: chunk.locator,
          documentId: chunk.documentId.toString(),
        },
      ],
    };
  }

  /** Adjudicated: the conflict's own `decision.winningFactId` — the human decision stands even
   *  when its version was later withdrawn (`winnerWithdrawn`, ADR-0021), so this never re-checks
   *  the fact's lifecycle. Single: the first `factIds` entry whose loaded `value.amount` equals
   *  the resolution's own amount, falling back to the first entry when none matches or none load —
   *  never a guess at which fact the cell's `value` actually came from. */
  private async loadRepresentativeFact(
    tenantId: string,
    ledger: LedgerResolution,
    state: 'single' | 'adjudicated',
  ): Promise<RepresentativeFact | undefined> {
    if (state === 'adjudicated') {
      const factId = ledger.decision?.winningFactId;
      if (!factId) {
        return undefined;
      }
      const fact = await this.extractedFactModel.findOne({ _id: factId, tenantId });
      return fact ? { factId, fact } : undefined;
    }

    if (ledger.factIds.length === 0) {
      return undefined;
    }
    const facts = await this.extractedFactModel.find({
      _id: { $in: ledger.factIds },
      tenantId,
    });
    const factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
    const matchingFactId = ledger.factIds.find(
      (factId) => factById.get(factId)?.value.amount === ledger.value?.amount,
    );
    const factId = matchingFactId ?? ledger.factIds[0];
    const fact = factById.get(factId);
    return fact ? { factId, fact } : undefined;
  }

  private async buildConflictedResult(
    tenantId: string,
    ledger: LedgerResolution,
  ): Promise<LedgerAnswerResult> {
    if (ledger.factIds.length === 0) {
      return { kind: 'unresolved', reason: 'conflicted-with-no-facts' };
    }
    const facts = await this.extractedFactModel.find({
      _id: { $in: ledger.factIds },
      tenantId,
    });
    if (facts.length < 2) {
      return { kind: 'unresolved', reason: 'conflicted-facts-not-found' };
    }

    return {
      kind: 'resolved',
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: ledger.entity, metric: ledger.measure, period: ledger.period },
        values: facts.map((fact) => ({
          value: fact.value.amount,
          unit: fact.value.unit,
          sourceChunkId: fact.chunkId,
        })),
      },
      retrievedChunks: [],
      ...(ledger.conflictId !== undefined ? { conflictIds: [ledger.conflictId] } : {}),
    };
  }
}
