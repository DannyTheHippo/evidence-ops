import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import type { EvidenceLocator } from '../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../embedding/embedding-provider.interface';
import type { RetrievalHit, RetrievalQuery, RetrievalStore } from './retrieval-store.interface';

// Duplicated from `migrations/0003-search-indexes.ts` rather than imported: `tsconfig.build.json`
// scopes `rootDir` to `src`, so `src` importing from `migrations/` would break `nest build`.
// `search-indexes.integration-spec.ts` is what keeps these two definitions honest against a live
// server — see that file rather than an import for the cross-check.
const COLLECTION = 'evidence_chunks';
const SEARCH_INDEX = 'evidence_chunks_search';
const VECTOR_INDEX = 'evidence_chunks_vector';

type PipelineName = 'search' | 'vector';
const PIPELINE_NAMES: readonly PipelineName[] = ['search', 'vector'];

// Equal, explicit weighting rather than the server's implicit per-pipeline default of 1: neither
// pipeline is known in advance to be more trustworthy than the other, and writing the weights out
// makes that a documented, tunable decision instead of an accident of omission. Revisit once an
// eval run (`eval/`) has data on which signal actually predicts a correct citation.
const PIPELINE_WEIGHTS: Record<PipelineName, number> = { search: 1, vector: 1 };

// Verified against a live `mongodb/mongodb-atlas-local:8.3.4`: the server's own $rankFusion
// description string is `sum(weight * (1 / (60 + rank)))`. The app-side fallback below
// (`searchAppSide`) uses this exact same constant for the exact same reason `PIPELINE_WEIGHTS`
// is explicit — 'server' and 'app' fusion only mean the same thing experimentally if every knob
// but the execution site is identical.
const RRF_K = 60;

// Each input pipeline pulls a wider candidate pool than the caller's final `limit` so RRF/
// $rankFusion has enough overlap between the two signals to fuse meaningfully; a pool the same
// size as `limit` would mean a document ranked #1 by vector search but outside the lexical
// pipeline's top-`limit` never gets a chance to be seen by both.
const PIPELINE_CANDIDATE_MULTIPLIER = 4;
const MIN_PIPELINE_CANDIDATES = 20;

// Atlas Vector Search guidance: `numCandidates` should be well above `limit` (approximate
// nearest-neighbour search trades recall for speed) — 10x with a floor is the documented rule of
// thumb absent a benchmark run against the real corpus.
const VECTOR_NUM_CANDIDATES_MULTIPLIER = 10;
const MIN_VECTOR_NUM_CANDIDATES = 100;

export interface PipelineScoreBreakdown {
  readonly pipeline: PipelineName;
  /** 1-based rank within that pipeline's own result order; `null` when the pipeline did not
   *  return this document at all (the server reports this case as the string `"NA"`). */
  readonly rank: number | null;
  readonly weight: number;
  /** This pipeline's RRF contribution to the fused score; `null` alongside `rank: null`. */
  readonly value: number | null;
}

export interface HybridRetrievalHitMetadata {
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly tenantId: string;
  readonly scoreBreakdown: readonly PipelineScoreBreakdown[];
}

interface RawEvidenceChunkDoc {
  readonly _id: mongo.ObjectId;
  readonly documentId: mongo.ObjectId;
  readonly documentVersionId: mongo.ObjectId;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly tenantId: string;
}

/**
 * `$meta: 'scoreDetails'` payload shape for a `$rankFusion` stage with `scoreDetails: true`,
 * verified live: `{inputPipelineName, rank, weight, value}` per input pipeline, with the literal
 * string `"NA"` (not absence, not `null`) standing in for `rank`/`value` on a pipeline that did
 * not return the document. Not part of any published driver typing, hence hand-declared here.
 */
interface RawScoreDetailEntry {
  readonly inputPipelineName: string;
  readonly rank: number | 'NA';
  readonly weight: number;
  readonly value: number | 'NA';
}

interface RawScoreDetails {
  readonly value: number;
  readonly details: readonly RawScoreDetailEntry[];
}

interface RawFusionResultDoc extends RawEvidenceChunkDoc {
  readonly fusionScore: number;
  readonly fusionScoreDetails?: RawScoreDetails;
}

/**
 * `RetrievalStore` backed by `evidence_chunks_search` (lexical) and `evidence_chunks_vector`
 * (vector) Atlas Search indexes (`migrations/0003-search-indexes.ts`), fused either server-side
 * via `$rankFusion` or, when `config.retrieval.fusion === 'app'`, by running both searches
 * separately and applying the identical RRF formula in code (`searchAppSide`). Both modes return
 * the same `HybridRetrievalHitMetadata` shape so a caller (and an eval comparing the two modes)
 * never has to branch on which one produced a hit.
 *
 * Tenant scoping happens *inside* both input pipelines (`$search`'s `compound.filter` and
 * `$vectorSearch`'s `filter`), not as a `$match` on the fused result — filtering after fusion
 * would rank a candidate set that includes other tenants' evidence before throwing most of it
 * away, which is both slower and, worse, changes which documents make the final top-k versus
 * filtering the candidate set the ranking is computed over in the first place.
 */
@Injectable()
export class MongoHybridRetrievalStore implements RetrievalStore {
  private readonly db: mongo.Db;

  constructor(
    @InjectConnection() connection: Connection,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
    private readonly config: TypedConfigService,
  ) {
    // Same invariant, same fail-closed reasoning as `GridFsDocumentStore`'s constructor: by the
    // time any consumer of `@InjectConnection()` is constructed, `connection.db` is always set in
    // practice (Mongoose resolves the `Connection` provider from `connection.asPromise()`), but a
    // store that can't reach its database must refuse to construct rather than hand back a store
    // that fails on every call.
    if (!connection.db) {
      throw new Error('Mongo connection has no active database handle');
    }
    this.db = connection.db;
  }

  async search<TMetadata = Record<string, unknown>>(
    query: RetrievalQuery,
  ): Promise<RetrievalHit<TMetadata>[]> {
    const tenantId = this.extractTenantId(query.filter);
    const vector = query.vector ?? (await this.embedQuery(query.text));
    const pipelineLimit = Math.max(
      query.limit * PIPELINE_CANDIDATE_MULTIPLIER,
      MIN_PIPELINE_CANDIDATES,
    );

    const hits =
      this.config.retrieval.fusion === 'app'
        ? await this.searchAppSide(query.text, vector, tenantId, query.limit, pipelineLimit)
        : await this.searchServerSide(query.text, vector, tenantId, query.limit, pipelineLimit);

    // This store only ever produces `HybridRetrievalHitMetadata`; the interface stays generic so
    // a caller can narrow to its own shape, same as `FakeRetrievalStore.search`.
    return hits as RetrievalHit<TMetadata>[];
  }

  private extractTenantId(filter: RetrievalQuery['filter']): string {
    const tenantId = filter?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      // Fails CLOSED: tenant scoping happens inside each input pipeline, not as a post-fusion
      // filter (see class doc), so a missing tenant id here would silently query across every
      // tenant's evidence instead of refusing to run at all.
      throw new Error('MongoHybridRetrievalStore requires a non-empty filter.tenantId');
    }
    return tenantId;
  }

  private async embedQuery(text: string): Promise<readonly number[]> {
    // `input_type: 'query'` (not `'document'`, which `IngestionService` uses to embed chunks) is
    // Voyage's asymmetric-embedding parameter — using the wrong side degrades retrieval quality
    // without ever raising an error, so this is the one call site in the app that must pass
    // `'query'`.
    const result = await this.embeddingProvider.embed({ inputs: [text], inputType: 'query' });
    return result.embeddings[0];
  }

  private collection(): mongo.Collection<RawEvidenceChunkDoc> {
    return this.db.collection<RawEvidenceChunkDoc>(COLLECTION);
  }

  private buildSearchStages(
    text: string,
    tenantId: string,
    pipelineLimit: number,
  ): mongo.Document[] {
    return [
      {
        $search: {
          index: SEARCH_INDEX,
          compound: {
            must: [{ text: { query: text, path: 'text' } }],
            filter: [{ equals: { path: 'tenantId', value: tenantId } }],
          },
        },
      },
      { $limit: pipelineLimit },
    ];
  }

  private buildVectorStages(
    vector: readonly number[],
    tenantId: string,
    pipelineLimit: number,
  ): mongo.Document[] {
    return [
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'embedding',
          queryVector: vector,
          numCandidates: Math.max(
            pipelineLimit * VECTOR_NUM_CANDIDATES_MULTIPLIER,
            MIN_VECTOR_NUM_CANDIDATES,
          ),
          limit: pipelineLimit,
          // Only `tenantId` is declared `type: 'filter'` on the vector index (see the migration)
          // — that is the sole field `$vectorSearch.filter` can pre-filter on here.
          filter: { tenantId: { $eq: tenantId } },
        },
      },
    ];
  }

  private async searchServerSide(
    text: string,
    vector: readonly number[],
    tenantId: string,
    limit: number,
    pipelineLimit: number,
  ): Promise<RetrievalHit<HybridRetrievalHitMetadata>[]> {
    const docs = await this.collection()
      .aggregate<RawFusionResultDoc>([
        {
          $rankFusion: {
            input: {
              pipelines: {
                search: this.buildSearchStages(text, tenantId, pipelineLimit),
                vector: this.buildVectorStages(vector, tenantId, pipelineLimit),
              },
            },
            combination: { weights: PIPELINE_WEIGHTS },
            scoreDetails: true,
          },
        },
        { $limit: limit },
        // `$rankFusion` output is already sorted by fused score descending; this stage only
        // attaches the metadata `$rankFusion` computed, it does not re-rank anything.
        {
          $addFields: {
            fusionScore: { $meta: 'score' },
            fusionScoreDetails: { $meta: 'scoreDetails' },
          },
        },
      ])
      .toArray();

    return docs.map((doc) =>
      this.toRetrievalHit(doc, doc.fusionScore, this.normalizeScoreDetails(doc.fusionScoreDetails)),
    );
  }

  private normalizeScoreDetails(raw: RawScoreDetails | undefined): PipelineScoreBreakdown[] {
    if (!raw) {
      return [];
    }
    return raw.details.map((detail) => ({
      pipeline: detail.inputPipelineName === 'vector' ? 'vector' : 'search',
      rank: detail.rank === 'NA' ? null : detail.rank,
      weight: detail.weight,
      value: detail.value === 'NA' ? null : detail.value,
    }));
  }

  /**
   * Application-side RRF fallback for `config.retrieval.fusion === 'app'`: runs the two input
   * pipelines as standalone aggregations and fuses their results in code with the same formula
   * and `k` the server uses (see `RRF_K`). `$search`/`$vectorSearch` both return results already
   * sorted by relevance descending, so cursor position doubles as the 1-based rank the RRF
   * formula needs — the same convention the server's own `$rankFusion` uses.
   */
  private async searchAppSide(
    text: string,
    vector: readonly number[],
    tenantId: string,
    limit: number,
    pipelineLimit: number,
  ): Promise<RetrievalHit<HybridRetrievalHitMetadata>[]> {
    const [searchDocs, vectorDocs] = await Promise.all([
      this.collection()
        .aggregate<RawEvidenceChunkDoc>(this.buildSearchStages(text, tenantId, pipelineLimit))
        .toArray(),
      this.collection()
        .aggregate<RawEvidenceChunkDoc>(this.buildVectorStages(vector, tenantId, pipelineLimit))
        .toArray(),
    ]);

    const ranked = new Map<
      string,
      { readonly doc: RawEvidenceChunkDoc; ranks: Partial<Record<PipelineName, number>> }
    >();
    const registerRanks = (docs: RawEvidenceChunkDoc[], pipeline: PipelineName): void => {
      docs.forEach((doc, index) => {
        const id = doc._id.toString();
        const entry = ranked.get(id) ?? { doc, ranks: {} };
        entry.ranks[pipeline] = index + 1;
        ranked.set(id, entry);
      });
    };
    registerRanks(searchDocs, 'search');
    registerRanks(vectorDocs, 'vector');

    const fused = [...ranked.values()].map(({ doc, ranks }) => {
      const scoreBreakdown: PipelineScoreBreakdown[] = PIPELINE_NAMES.map((pipeline) => {
        const rank = ranks[pipeline] ?? null;
        const weight = PIPELINE_WEIGHTS[pipeline];
        const value = rank === null ? null : weight * (1 / (RRF_K + rank));
        return { pipeline, rank, weight, value };
      });
      const score = scoreBreakdown.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
      return { doc, score, scoreBreakdown };
    });

    fused.sort((a, b) => b.score - a.score);

    return fused
      .slice(0, limit)
      .map(({ doc, score, scoreBreakdown }) => this.toRetrievalHit(doc, score, scoreBreakdown));
  }

  private toRetrievalHit(
    doc: RawEvidenceChunkDoc,
    score: number,
    scoreBreakdown: readonly PipelineScoreBreakdown[],
  ): RetrievalHit<HybridRetrievalHitMetadata> {
    return {
      id: doc._id.toString(),
      score,
      metadata: {
        text: doc.text,
        locator: doc.locator,
        documentId: doc.documentId.toString(),
        documentVersionId: doc.documentVersionId.toString(),
        tenantId: doc.tenantId,
        scoreBreakdown,
      },
    };
  }
}
