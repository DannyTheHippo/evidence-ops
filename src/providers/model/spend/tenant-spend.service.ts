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
      throw new TenantSpendLimitExceededError(tenantId, amountUsd, limitUsd, windowStart);
    }

    return windowStart;
  }

  /**
   * Releases a completed call's reservation and records what it actually cost, against the exact
   * `windowStart` the matching `reserve` returned — never a freshly computed one, which could name
   * a different UTC day than the reservation it is meant to close out.
   *
   * Fails OPEN: a write failure here is logged, never thrown. The delegate call this closes out
   * already happened and was already billed by the vendor — surfacing this failure to the caller
   * would mask the delegate's own result (success or error) behind a bookkeeping error, and a
   * caller that retries on that error would re-issue and pay for the same call a second time. The
   * cost of failing open is a reservation this write should have cleared but didn't; that is
   * exactly the leak `sweepStaleReservations` below exists to reconcile, not a reason to
   * double-bill.
   */
  async settle(
    tenantId: string,
    windowStart: Date,
    amountUsd: number,
    actualUsd: number,
  ): Promise<void> {
    try {
      await this.modelSpendWindowModel.updateOne(
        { tenantId, windowStart },
        { $inc: { reservedUsd: -amountUsd, spentUsd: actualUsd } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `settle failed for tenant '${tenantId}', window ${windowStart.toISOString()}: ${message}`,
      );
    }
  }

  /**
   * Releases a reservation with no spend recorded, for a call that threw before it settled —
   * against the exact `windowStart` the matching `reserve` returned, for the same reason `settle`
   * takes it rather than recomputing.
   *
   * Fails OPEN, for the same reason `settle` does: the delegate call already threw its own error,
   * and a release failure here must not replace that error with a bookkeeping one — the caller
   * needs to see why the call actually failed, not why the reservation cleanup did.
   */
  async release(tenantId: string, windowStart: Date, amountUsd: number): Promise<void> {
    try {
      await this.modelSpendWindowModel.updateOne(
        { tenantId, windowStart },
        { $inc: { reservedUsd: -amountUsd } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `release failed for tenant '${tenantId}', window ${windowStart.toISOString()}: ${message}`,
      );
    }
  }

  /**
   * Releases every reservation this ledger has no per-reservation record of, so it cannot tell
   * apart from a reservation still genuinely in flight, except by how long it has sat untouched.
   * `ModelSpendWindow` tracks only the aggregate `reservedUsd` per `(tenantId, windowStart)` — a
   * crash between `reserve` and its matching `settle`/`release` leaves that aggregate permanently
   * inflated with no record of which call caused it, wedging the ceiling for every tenant sharing
   * that window until `windowStart` rolls over at UTC midnight. A window's `updatedAt` (Mongoose
   * `timestamps: true`) advances on every `reserve`/`settle`/`release` touching it; one that has
   * gone untouched for `staleAfterMs` — comfortably past `ANTHROPIC_TIMEOUT_MS`/
   * `VOYAGE_REQUEST_TIMEOUT_MS`, so no genuinely in-flight call is ever this old — can only be
   * carrying an orphaned reservation, and this zeroes `reservedUsd` back to reopen that headroom.
   *
   * Fails OPEN like `settle`/`release`: this is a self-healing sweep, not a request-path gate: a
   * caller with no in-flight reservation is unaffected either way, so a swallowed write failure
   * here costs nothing beyond leaving the same wedge in place until the next sweep or UTC midnight
   * — whichever comes first — never a reason to throw out of a maintenance pass.
   *
   * A known, accepted imprecision from working off the aggregate alone rather than per-reservation
   * records: any write to a window (even an unrelated concurrent reservation settling normally)
   * refreshes `updatedAt` and can delay this sweep from catching a genuinely stale reservation
   * sitting alongside it. That is strictly better than the status quo of no sweep at all, and the
   * UTC-midnight rollover remains the hard backstop regardless.
   *
   * Returns the number of windows swept, for a caller (e.g. a periodic worker task) to log.
   */
  async sweepStaleReservations(staleAfterMs: number, now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - staleAfterMs);

    try {
      const result = await this.modelSpendWindowModel.updateMany(
        { reservedUsd: { $gt: 0 }, updatedAt: { $lt: staleBefore } },
        { $set: { reservedUsd: 0 } },
      );
      return result.modifiedCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`sweepStaleReservations failed: ${message}`);
      return 0;
    }
  }

  /** UTC start of the current day — the key every reservation, settlement, and release for
   * "today" shares, regardless of which local timezone the caller runs in. */
  private getWindowStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
