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
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
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
    const windowStart = await this.spendService.reserve(tenantId, maxCostUsd, this.dailyLimitUsd);

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
}
