import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ModelSpendWindow,
  type ModelSpendWindowDocument,
} from '../../../database/schemas/platform/model-spend-window/model-spend-window.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { TenantSpendLimitExceededError } from '../errors/tenant-spend-limit-exceeded.error';

/**
 * Aggregate, cross-request spend ledger for a tenant — distinct from `ModelBudgetExceededError`'s
 * per-call cap, which bounds a single `ModelRequest`. This bounds the sum of every model call a
 * tenant issues within a day. Fails CLOSED: `reserve` refuses whenever it cannot prove the
 * reservation still fits under the ceiling, because the thing being gated — money leaving the
 * account — is irreversible once the underlying model call runs.
 */
@Injectable()
export class TenantSpendService {
  constructor(
    @InjectModel(ModelSpendWindow.name)
    private readonly modelSpendWindowModel: Model<ModelSpendWindowDocument>,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(TenantSpendService.name);
  }

  /**
   * Reserves `amountUsd` of a tenant's daily ceiling ahead of a model call, atomically against
   * concurrent callers.
   *
   * `limitUsd <= 0` disables the ceiling — the one deliberate fail-OPEN path in this service, for
   * a tenant that has not been given a spend cap.
   *
   * Two steps, in this order, for two different reasons:
   *   1. `updateOne` with `upsert: true` idempotently ensures the window document exists, so a
   *      tenant's first call of the day does not need a separate "create" branch.
   *   2. `findOneAndUpdate` with NO `upsert` performs the budget check and the increment as one
   *      atomic operation: `$expr` in the filter matches only when
   *      `spentUsd + reservedUsd + amountUsd` still fits under `limitUsd`, and the `$inc` in the
   *      same call only ever applies to a document that passed that check in the same round trip.
   *      A read of the current totals followed by a separate write would leave a window in which
   *      a concurrent caller's reservation is invisible — exactly the race this two-step design
   *      exists to close. Step 2 must not upsert: an upsert on a filter that includes `$expr`
   *      would create a fresh zero-balance row whenever no existing row matches, satisfying the
   *      check trivially and bypassing the ceiling it exists to enforce.
   *
   * A `null` result from step 2 means the filter matched no document — the reservation would have
   * exceeded the ceiling — and this throws rather than silently permitting the call.
   *
   * Returns the `windowStart` this reservation keyed. A caller crossing UTC midnight between
   * `reserve` and its matching `settle`/`release` must pass this value back rather than let those
   * methods recompute a fresh window from the current clock, which would settle against a window
   * this reservation never touched and leave the reserved one permanently short.
   */
  async reserve(tenantId: string, amountUsd: number, limitUsd: number): Promise<Date> {
    const windowStart = this.getWindowStart();

    if (limitUsd <= 0) {
      return windowStart;
    }

    await this.modelSpendWindowModel.updateOne(
      { tenantId, windowStart },
      { $setOnInsert: { spentUsd: 0, reservedUsd: 0 } },
      { upsert: true },
    );

    const reserved = await this.modelSpendWindowModel.findOneAndUpdate(
      {
        tenantId,
        windowStart,
        $expr: { $lte: [{ $add: ['$spentUsd', '$reservedUsd', amountUsd] }, limitUsd] },
      },
      { $inc: { reservedUsd: amountUsd } },
      { returnDocument: 'after' },
    );

    if (reserved === null) {
      throw new TenantSpendLimitExceededError(tenantId, amountUsd, limitUsd);
    }

    return windowStart;
  }

  /**
   * Releases a completed call's reservation and records what it actually cost, against the exact
   * `windowStart` the matching `reserve` returned — never a freshly computed one, which could name
   * a different UTC day than the reservation it is meant to close out.
   */
  async settle(
    tenantId: string,
    windowStart: Date,
    amountUsd: number,
    actualUsd: number,
  ): Promise<void> {
    await this.modelSpendWindowModel.updateOne(
      { tenantId, windowStart },
      { $inc: { reservedUsd: -amountUsd, spentUsd: actualUsd } },
    );
  }

  /**
   * Releases a reservation with no spend recorded, for a call that threw before it settled —
   * against the exact `windowStart` the matching `reserve` returned, for the same reason `settle`
   * takes it rather than recomputing.
   */
  async release(tenantId: string, windowStart: Date, amountUsd: number): Promise<void> {
    await this.modelSpendWindowModel.updateOne(
      { tenantId, windowStart },
      { $inc: { reservedUsd: -amountUsd } },
    );
  }

  /** UTC start of the current day — the key every reservation, settlement, and release for
   * "today" shares, regardless of which local timezone the caller runs in. */
  private getWindowStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
