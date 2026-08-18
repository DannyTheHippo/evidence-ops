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
 * `TenantSpendService` ledger `SpendGuardModelProvider` reserves against — one combined daily
 * ceiling per tenant across model and embedding spend, not a second one.
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
 * happened. The estimate can only overstate cost, never understate it — an undercount would let a
 * call transiently push spend past the ceiling before the next reserve catches it up, where an
 * overcount only ever refuses a call early that would have fit.
 */
@Injectable()
export class SpendGuardEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly spendService: TenantSpendService,
    private readonly dailyLimitUsd: number,
    private readonly als: AsyncLocalStorage<AlsContext>,
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

    const estimatedCostUsd = computeVoyageCostUsd(
      this.inner.info.model,
      estimateEmbeddingTokens(request.inputs),
    );
    const windowStart = await this.spendService.reserve(
      tenantId,
      estimatedCostUsd,
      this.dailyLimitUsd,
    );

    let result: EmbeddingResult;
    try {
      result = await this.inner.embed(request);
    } catch (error) {
      await this.spendService.release(tenantId, windowStart, estimatedCostUsd);
      throw error;
    }

    const actualCostUsd = computeVoyageCostUsd(this.inner.info.model, result.usage.totalTokens);
    await this.spendService.settle(tenantId, windowStart, estimatedCostUsd, actualCostUsd);
    return result;
  }
}
