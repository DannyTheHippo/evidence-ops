import { Injectable } from '@nestjs/common';
import type { z } from 'zod/v4';
import { ModelRequestMissingTenantError } from './errors/model-request-missing-tenant.error';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';
import { TenantSpendService } from './spend/tenant-spend.service';

/**
 * Enforces a tenant's daily spend ceiling around a delegate `ModelProvider`.
 *
 * `dailyLimitUsd <= 0` disables the ceiling — the one deliberate fail-OPEN path here, mirroring
 * `TenantSpendService.reserve`'s own disable convention.
 *
 * Otherwise fails CLOSED: a request with no `tenantId` is refused outright rather than let
 * through unmetered or attributed to the wrong tenant, because the thing being gated — money
 * leaving the account — is irreversible once the delegate call runs.
 *
 * Reserves `request.maxCostUsd` before calling the delegate, then either settles with the actual
 * cost on success or releases the reservation on any delegate failure, so a reservation can never
 * leak against a call that never happened.
 */
@Injectable()
export class SpendGuardModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly spendService: TenantSpendService,
    private readonly dailyLimitUsd: number,
    // Sub-ceiling for `fact_extraction` calls only, reserved against the same ledger `reserve`
    // already atomically checks — `undefined` (the default) reserves ingest against the full
    // `dailyLimitUsd`, same as before this parameter existed. Every other task class always
    // reserves against `dailyLimitUsd`, so a backfill's own ingest spend can never crowd out the
    // headroom interactive calls (`qa_answer`, `claim_verification`) depend on.
    private readonly ingestDailyLimitUsd?: number,
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
  }

  /** Forwards to the delegate — see `ModelProvider.resolveModel`'s own doc comment for why every
   * decorator in the chain must do this rather than let it fall back silently. */
  resolveModel(taskClass: ModelRequest['taskClass']): string {
    return this.inner.resolveModel?.(taskClass) ?? this.inner.info.model;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    if (this.dailyLimitUsd <= 0) {
      return this.inner.generate(request);
    }

    if (!request.tenantId) {
      throw new ModelRequestMissingTenantError(request.taskClass);
    }

    const { tenantId, maxCostUsd } = request;
    const limitUsd = this.limitUsdFor(request.taskClass);
    const windowStart = await this.spendService.reserve(tenantId, maxCostUsd, limitUsd);

    let result: ModelResult<TSchema>;
    try {
      result = await this.inner.generate(request);
    } catch (error) {
      await this.spendService.release(tenantId, windowStart, maxCostUsd);
      throw error;
    }

    await this.spendService.settle(tenantId, windowStart, maxCostUsd, result.costUsd);
    return result;
  }

  /** `fact_extraction` is the only ingest task class; everything else is interactive and always
   * reserves against the full `dailyLimitUsd`. */
  private limitUsdFor(taskClass: ModelRequest['taskClass']): number {
    if (taskClass === 'fact_extraction' && this.ingestDailyLimitUsd !== undefined) {
      return this.ingestDailyLimitUsd;
    }
    return this.dailyLimitUsd;
  }
}
