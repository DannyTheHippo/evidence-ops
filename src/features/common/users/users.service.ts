import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import {
  LastAdminException,
  UserNotFoundException,
  UserRestoreFailedException,
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

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(UsersService.name);
  }

  async list(
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<UserSummaryResult>> {
    const filter = { tenantId };

    const [users, count] = await Promise.all([
      this.userModel.find(filter, null, {
        sort: { createdAt: -1 },
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
   * Write-then-verify-then-compensate, but only on a write that can actually reduce the tenant's
   * admin count — `previous.role === Admin && role !== Admin`. Every other transition
   * (admin→admin, member→admin, member→member) writes the role and returns without paying for a
   * count query or a compensation, because none of those can take the tenant to zero admins.
   *
   * On a guarded write, the role is written first, then the tenant's admin count is read fresh —
   * never a count taken before the write, which a second concurrent caller could invalidate
   * before either write lands. The compensation always restores `previous.role`, and the guard
   * only ever runs when `previous.role` was `Admin`, so every compensation this method performs
   * writes `admin` back. Compensations can therefore only add admins, never remove one, under any
   * interleaving of concurrent callers — see `test/features/common/users/users.service.spec.ts`
   * for the branch-level proof.
   *
   * The one gap this leaves: between the unconditional write and the count-check that follows it,
   * the database genuinely holds zero admins for that instant. A process death in that window
   * makes the demotion permanent, with no path back through the API. That is a separate, tracked
   * follow-up — a transaction would not close it either, since MongoDB gives snapshot isolation
   * rather than serializability, and two transactions demoting two different admins never
   * conflict with each other.
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

    const previous = await this.userModel.findOneAndUpdate(
      { _id: id, tenantId },
      { $set: { role } },
    );
    if (!previous) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    const canReduceAdminCount = previous.role === UserRole.Admin && role !== UserRole.Admin;
    if (canReduceAdminCount && !(await this.hasRemainingAdmin(tenantId))) {
      await this.userModel.updateOne({ _id: id, tenantId }, { $set: { role: previous.role } });
      await this.auditService.record({
        action: 'users.role-change-refused',
        actorId,
        subject: { entityType: 'User', entityId: id },
        tenantId,
      });
      throw new LastAdminException(
        `Tenant '${tenantId}' must always keep at least one admin; changing user '${id}' to '${role}' would leave none`,
      );
    }

    await this.auditService.record({
      action: 'users.role-changed',
      actorId,
      subject: { entityType: 'User', entityId: id },
      tenantId,
    });

    this.logger.debug(`Changed role for user '${id}' to '${role}' in tenant '${tenantId}'`);

    return {
      id: previous._id.toString(),
      email: previous.email,
      role,
      createdAt: previous.createdAt,
    };
  }

  /**
   * Same guarded write-then-verify-then-compensate shape as `changeRole` — see that method's doc
   * comment for the concurrency argument and its one remaining gap. Guarded only when
   * `removed.role === Admin`; removing a member never touches the admin count, so it skips
   * straight to the audit record.
   *
   * `create` cannot stand in for the revert here: `AuditableDocument`'s `pre('save')` hook stamps
   * a fresh `createdBy`/`updatedBy` (and Mongoose mints a fresh `createdAt`/`updatedAt`) on every
   * document it treats as new, which a refused removal must not do — the row is being restored
   * exactly as it stood, not created. The compensating insert goes through the driver directly,
   * bypassing `auditablePlugin` and `tenantScopePlugin` entirely. That is correct only because the
   * document being restored is one this same call just read back out of a tenant-scoped query —
   * nothing about it needs either plugin's help.
   */
  async remove(id: string, actorId: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    const removed = await this.userModel.findOneAndDelete({ _id: id, tenantId });
    if (!removed) {
      throw new UserNotFoundException(`User '${id}' not found`);
    }

    if (removed.role === UserRole.Admin && !(await this.hasRemainingAdmin(tenantId))) {
      try {
        await this.userModel.collection.insertOne(removed.toObject());
      } catch (error) {
        throw new UserRestoreFailedException(
          `Removing user '${id}' from tenant '${tenantId}' was refused to keep the tenant's last ` +
            `admin, but restoring the row failed; the account is deleted and needs manual recovery`,
          error,
        );
      }

      await this.auditService.record({
        action: 'users.remove-refused',
        actorId,
        subject: { entityType: 'User', entityId: id },
        tenantId,
      });
      throw new LastAdminException(
        `Tenant '${tenantId}' must always keep at least one admin; removing user '${id}' would leave none`,
      );
    }

    await this.auditService.record({
      action: 'users.removed',
      actorId,
      subject: { entityType: 'User', entityId: id },
      tenantId,
    });

    this.logger.debug(`Removed user '${id}' from tenant '${tenantId}'`);
  }

  private async hasRemainingAdmin(tenantId: string): Promise<boolean> {
    const adminCount = await this.userModel.countDocuments({ tenantId, role: UserRole.Admin });
    return adminCount > 0;
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
