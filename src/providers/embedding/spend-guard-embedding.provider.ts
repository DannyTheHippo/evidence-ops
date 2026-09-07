import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AlsContext } from '../../shared/types/als-context.type';
import { estimateTokenCount } from '../model/model-output-validation.util';
import { TenantSpendService } from '../model/spend/tenant-spend.service';
import { EmbeddingRequestMissingTenantError } from './errors/embedding-request-missing-tenant.error';
import type {
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-provider.interface';
import { computeVoyageCostUsd } from './voyage-pricing.table';

/**
 * Sums each input's `estimateTokenCount` — the same chars-per-token heuristic
 * `openai-model.provider.ts`/`anthropic-model.provider.ts` use to pre-flight a budget check
 * before a call is made. Exported so its arithmetic is pinned by a spec independent of the
 * decorator around it. Never used for billing — the actual cost always comes from Voyage's own
 * `usage.totalTokens` after the call.
 */
export function estimateEmbeddingTokens(inputs: readonly string[]): number {
  return inputs.reduce((sum, text) => sum + estimateTokenCount(text), 0);
}

/**
 * Enforces a tenant's daily spend ceiling around a delegate `EmbeddingProvider`, reusing the same
 * `TenantSpendService` ledger `SpendGuardModelProvider` reserves against — one combined ledger per
 * tenant across model and embedding spend, not a second one. `dailyLimitUsd` bounds every
 * reservation; `document` (ingest) embeds additionally reserve against `ingestDailyLimitUsd` when
 * one is configured, so a backfill can never crowd out the headroom `query` embeds depend on — see
 * `limitUsdFor`.
 *
 * `dailyLimitUsd <= 0` disables the ceiling — the one deliberate fail-OPEN path here, mirroring
 * `TenantSpendService.reserve`'s own disable convention.
 *
 * Otherwise fails CLOSED: `EmbeddingRequest` carries no tenant field of its own (unlike
 * `ModelRequest`), so the tenant is read from `AsyncLocalStorage` the same way `AuditService`
 * reads it. A call with no tenant in scope is refused outright rather than let through unmetered
 * or attributed to the wrong tenant, because the thing being gated — money leaving the account —
 * is irreversible once the delegate call runs.
 *
 * Reserves a worst-case token estimate before calling the delegate, then either settles with the
 * actual cost (from the delegate's real `usage.totalTokens`) on success or releases the
 * reservation on any delegate failure, so a reservation can never leak against a call that never
 * happened. The 1-char-per-4-tokens heuristic is only an approximation — dense-script text (CJK)
 * tokenizes closer to 1 char per token, so a large CJK input can reserve well under its actual
 * cost. `settle` still writes the real cost from `usage.totalTokens` afterward, so an
 * undercount's only consequence is a transient one: spend can push past the ceiling for the
 * duration of one in-flight call before the next `reserve` sees the corrected total and catches it
 * up.
 */
@Injectable()
export class SpendGuardEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly spendService: TenantSpendService,
    private readonly dailyLimitUsd: number,
    private readonly als: AsyncLocalStorage<AlsContext>,
    // Sub-ceiling for `document` (ingest) embeds only — see `SpendGuardModelProvider`'s identical
    // parameter for why this mirrors the model-spend split. `undefined` (the default) reserves
    // ingest embeds against the full `dailyLimitUsd`, same as before this parameter existed.
    // `query` embeds always reserve against `dailyLimitUsd`.
    private readonly ingestDailyLimitUsd?: number,
    // Defaults to Voyage's pricing table so every existing caller is unaffected; a delegate priced
    // outside that table (the OpenAI-compatible provider's configured per-token rate) supplies its
    // own function instead of forcing an unrelated model id into `VOYAGE_PRICING`.
    private readonly computeCostUsd: (
      model: string,
      totalTokens: number,
    ) => number = computeVoyageCostUsd,
  ) {}

  get info(): EmbeddingProviderInfo {
    return this.inner.info;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.dailyLimitUsd <= 0) {
      return this.inner.embed(request);
    }

    const tenantId = this.als.getStore()?.tenant;
    if (!tenantId) {
      throw new EmbeddingRequestMissingTenantError(request.inputType);
    }

    const estimatedCostUsd = this.computeCostUsd(
      this.inner.info.model,
      estimateEmbeddingTokens(request.inputs),
    );
    const limitUsd = this.limitUsdFor(request.inputType);
    const windowStart = await this.spendService.reserve(tenantId, estimatedCostUsd, limitUsd);

    let result: EmbeddingResult;
    try {
      result = await this.inner.embed(request);
    } catch (error) {
      await this.spendService.release(tenantId, windowStart, estimatedCostUsd);
      throw error;
    }

    const actualCostUsd = this.computeCostUsd(this.inner.info.model, result.usage.totalTokens);
    await this.spendService.settle(tenantId, windowStart, estimatedCostUsd, actualCostUsd);
    return result;
  }

  /** `document` is the only ingest inputType; `query` is interactive and always reserves against
   * the full `dailyLimitUsd`. */
  private limitUsdFor(inputType: EmbeddingRequest['inputType']): number {
    if (inputType === 'document' && this.ingestDailyLimitUsd !== undefined) {
      return this.ingestDailyLimitUsd;
    }
    return this.dailyLimitUsd;
  }
}
