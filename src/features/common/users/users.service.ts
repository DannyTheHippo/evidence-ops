import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  Tenant,
  TenantDocument,
} from '../../../database/schemas/administration/tenant/tenant.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import {
  DEFAULT_USER_SORT_DIRECTION,
  DEFAULT_USER_SORT_FIELD,
  type ListUsersRequestDto,
} from './dtos/request/list-users.request.dto';
import {
  AdminGuardUnavailableException,
  LastAdminException,
  SelfRemovalException,
  UserNotFoundException,
} from './exceptions/users.exception';

export interface UserSummaryResult {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(UsersService.name);
  }

  async list(
    pagination: ListUsersRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<UserSummaryResult>> {
    const filter = { tenantId };

    const [users, count] = await Promise.all([
      this.userModel.find(filter, null, {
        sort: resolveSort(
          pagination.sort,
          pagination.sortDir,
          DEFAULT_USER_SORT_FIELD,
          DEFAULT_USER_SORT_DIRECTION,
        ),
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.userModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'users.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: users.map((user) => this.toResult(user)), count };
  }

  /**
   * Guarded only on a write that can actually reduce the tenant's admin count —
   * `previous.role === Admin && role !== Admin`. Every other transition (admin→admin,
   * member→admin, member→member) writes the role and returns without touching the tenant's
   * admin-guard marker or counting anything, because none of those can take the tenant to zero
   * admins.
   *
   * The guarded write, the marker touch (`touchAdminGuard`), and the admin count all run inside
   * one transaction on `session`, in that order. The marker touch is what makes two concurrent
   * guarded writes in the same tenant collide: MongoDB gives snapshot isolation rather than
   * serializability, so two transactions demoting two different admins would otherwise never
   * conflict with each other — each only touches its own user document, and each would
   * independently see the other's admin still standing. Touching one document every guarded
   * caller in the tenant shares forces whichever transaction loses the write race to abort with a
   * write conflict and retry the whole callback against newly committed state, where it re-reads
   * the real admin count and refuses correctly.
   *
   * Because the write, the marker touch, and the count share one transaction, there is no instant
   * at which the database durably holds a demoted row without also having validated the count
   * that demotion produced: an abort — a write conflict, a failed count, or the process dying
   * before commit — leaves the tenant exactly as it stood before this call. Only
   * `LastAdminException` gets audited as a refusal; any other abort (a missing user, a missing
   * tenant registry row) propagates without one, since neither ever put this tenant's admin count
   * at risk.
   */
  async changeRole(
    id: string,
    role: UserRole,
    actorId: string,
    tenantId: string,
  ): Promise<UserSummaryResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    const session = await this.userModel.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const previous = await this.userModel.findOneAndUpdate(
          { _id: id, tenantId },
          { $set: { role } },
          { session },
        );
        if (!previous) {
          throw new UserNotFoundException(`User '${id}' not found`);
        }

        const canReduceAdminCount = previous.role === UserRole.Admin && role !== UserRole.Admin;
        if (canReduceAdminCount) {
          await this.touchAdminGuard(tenantId, session);
          const adminCount = await this.userModel.countDocuments(
            { tenantId, role: UserRole.Admin },
            { session },
          );
          if (adminCount === 0) {
            throw new LastAdminException(
              `Tenant '${tenantId}' must always keep at least one admin; changing user '${id}' to '${role}' would leave none`,
            );
          }
        }

        return {
          id: previous._id.toString(),
          email: previous.email,
          role,
          createdAt: previous.createdAt,
        };
      });

      await this.auditService.record({
        action: 'users.role-changed',
        actorId,
        subject: { entityType: 'User', entityId: id },
        tenantId,
      });
      this.logger.debug(`Changed role for user '${id}' to '${role}' in tenant '${tenantId}'`);

      return result;
    } catch (error) {
      if (error instanceof LastAdminException) {
        await this.auditService.record({
          action: 'users.role-change-refused',
          actorId,
          subject: { entityType: 'User', entityId: id },
          tenantId,
        });
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Same guarded-transaction shape as `changeRole` — see that method's doc comment for the
   * write-conflict mechanics. Guarded only when `removed.role === Admin`; removing a member never
   * touches the admin count, so it skips straight past the marker touch and the count.
   *
   * Because the delete and the count share one transaction, an abort — a write conflict, a failed
   * count, or the process dying before commit — rolls the delete back along with it: there is no
   * instant at which a refused removal is durably deleted while its refusal is only decided
   * afterwards, so nothing needs restoring.
   *
   * A caller targeting their own id is refused with `SelfRemovalException` before the session
   * opens: no transaction, no database call and no audit record, since only `LastAdminException`
   * is audited. That refusal fails closed and applies however many other admins the tenant has.
   */
  async remove(id: string, actorId: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    if (new Types.ObjectId(id).equals(actorId)) {
      throw new SelfRemovalException(`User '${id}' cannot remove themselves from the tenant`);
    }

    const session = await this.userModel.startSession();
    try {
      await session.withTransaction(async () => {
        const removed = await this.userModel.findOneAndDelete({ _id: id, tenantId }, { session });
        if (!removed) {
          throw new UserNotFoundException(`User '${id}' not found`);
        }

        if (removed.role === UserRole.Admin) {
          await this.touchAdminGuard(tenantId, session);
          const adminCount = await this.userModel.countDocuments(
            { tenantId, role: UserRole.Admin },
            { session },
          );
          if (adminCount === 0) {
            throw new LastAdminException(
              `Tenant '${tenantId}' must always keep at least one admin; removing user '${id}' would leave none`,
            );
          }
        }
      });

      await this.auditService.record({
        action: 'users.removed',
        actorId,
        subject: { entityType: 'User', entityId: id },
        tenantId,
      });
      this.logger.debug(`Removed user '${id}' from tenant '${tenantId}'`);
    } catch (error) {
      if (error instanceof LastAdminException) {
        await this.auditService.record({
          action: 'users.remove-refused',
          actorId,
          subject: { entityType: 'User', entityId: id },
          tenantId,
        });
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Raises the target user's session epoch by exactly one — the same driver-level `$inc` as
   * `scripts/lib/revoke-user-sessions.ts`, never a client-supplied value, so this can only move
   * the epoch forward and can never send it backwards to un-revoke a token already invalidated.
   * `JwtAuthGuard` and `ApiKeysService.verify` both compare a caller's stored epoch against this
   * row on every request, so one raise refuses every cookie session and every API key this user
   * holds that predates it.
   *
   * Scoped to `tenantId` exactly like `changeRole`/`remove`, and refuses with the same
   * `UserNotFoundException` a caller gets for an id that does not exist at all — a cross-tenant id
   * is not distinguishable from a missing one.
   */
  async revokeSessions(id: string, actorId: string, tenantId: string): Promise<UserSummaryResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    const revoked = await this.userModel.findOneAndUpdate(
      { _id: id, tenantId },
      { $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    );
    if (!revoked) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    await this.auditService.record({
      action: 'users.sessions-revoked',
      actorId,
      subject: { entityType: 'User', entityId: id },
      tenantId,
    });

    this.logger.debug(`Revoked sessions for user '${id}' in tenant '${tenantId}'`);

    return this.toResult(revoked);
  }

  /**
   * Increments the tenant registry row's guard counter by one, inside the caller's transaction.
   * `$inc` always registers a write — unlike a `$set` of a value that might already match, which
   * MongoDB is free to skip, leaving no write intent and nothing for a concurrent transaction to
   * collide with. Every guarded caller in a tenant touches the same row, so the first to commit
   * forces every other concurrent guarded caller to abort with a write conflict and retry against
   * the state that commit produced.
   *
   * Fails closed: a tenant with no registry row cannot be a real caller path (every tenant is
   * created before its first user), so a `matchedCount` of zero here means the invariant this
   * guard exists to protect cannot be evaluated, not that it holds — it throws rather than letting
   * the calling transaction commit unguarded.
   */
  private async touchAdminGuard(tenantId: string, session: ClientSession): Promise<void> {
    const result = await this.tenantModel.updateOne(
      { tenantId },
      { $inc: { adminGuardEpoch: 1 } },
      { session },
    );
    if (result.matchedCount === 0) {
      throw new AdminGuardUnavailableException(
        `Tenant '${tenantId}' has no registry row to guard its admin count with`,
      );
    }
  }

  private toResult(user: UserDocument): UserSummaryResult {
    return {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
