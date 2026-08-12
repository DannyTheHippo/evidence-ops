import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  User,
  UserSchema,
} from '../../../../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../../../../src/shared/enums/user-role.enum';

// MongoMemoryServer boot (binary spin-up + replica init) regularly exceeds Jest's 5s default.
jest.setTimeout(60000);

describe('User schema', () => {
  describe('validation (offline — no database connection)', () => {
    // Unconnected model: `validateSync` runs local schema validators only, no network needed.
    // Generic is the schema's own class (`User`), matching what `SchemaFactory.createForClass`
    // produced — not the `HydratedDocument<WithTimestamps<...>>` alias, which the `.model()`
    // overloads do not structurally accept as a type argument.
    const UserModel = mongoose.model<User>('UserValidationOnly', UserSchema);

    it('requires email and password', () => {
      const user = new UserModel({});

      const error = user.validateSync();

      expect(error?.errors.email).toBeDefined();
      expect(error?.errors.password).toBeDefined();
    });

    it('defaults tenantId and role when neither is supplied', () => {
      const user = new UserModel({ email: 'demo@example.com', password: 'hashed' });

      expect(user.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(user.role).toBe(UserRole.Member);
      expect(user.validateSync()).toBeUndefined();
    });

    it('keeps an explicit role rather than overriding it with the default', () => {
      const user = new UserModel({
        email: 'admin@example.com',
        password: 'hashed',
        role: UserRole.Admin,
      });

      expect(user.role).toBe(UserRole.Admin);
      expect(user.validateSync()).toBeUndefined();
    });

    it('rejects a role outside admin/member', () => {
      const user = new UserModel({
        email: 'demo@example.com',
        password: 'hashed',
        role: 'owner',
      });

      const error = user.validateSync();

      expect(error?.errors.role).toBeDefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let UserModel: Model<User>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      UserModel = connection.model<User>(User.name, UserSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a user with its tenant and role defaults', async () => {
      const created = await UserModel.create({ email: 'demo@example.com', password: 'hashed' });

      const found = await UserModel.findById(created._id);

      expect(found?.email).toBe('demo@example.com');
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(found?.role).toBe(UserRole.Member);
    });
  });
});
