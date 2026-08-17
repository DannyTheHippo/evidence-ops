import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { getTestServer } from './create-test-app';

export interface RegisterTestUserCredentials {
  email: string;
  password: string;
}

export interface RegisterTestUserOptions {
  role?: 'admin' | 'member';
  tenantId?: string;
}

export interface RegisterTestUserResult {
  token: string;
  userId: string;
  tenantId: string;
}

interface RegisterResponseBody {
  id: string;
}

interface LoginResponseBody {
  accessToken: string;
}

/**
 * Registers a user through `POST /api/v1/auth/register` — which provisions a brand-new tenant per
 * registrant with the registrant as that tenant's `admin` — then logs in through
 * `POST /api/v1/auth/login` and returns the resulting token alongside the user's real id and
 * tenant id.
 *
 * `options.role: 'member'` demotes the persisted row to `UserRole.Member` before login;
 * `options.tenantId` overwrites the persisted row's tenant, co-tenanting this user with whichever
 * fixtures already carry that id. Both mutations are applied before the single login call this
 * function makes, so the returned token's `role`/`tenantId` claims — signed at login — always
 * match the row's final state.
 */
export const registerTestUser = async (
  app: INestApplication,
  credentials: RegisterTestUserCredentials,
  options: RegisterTestUserOptions = {},
): Promise<RegisterTestUserResult> => {
  const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

  const registerResponse = await request(getTestServer(app))
    .post('/api/v1/auth/register')
    .send(credentials);
  const userId = (registerResponse.body as RegisterResponseBody).id;

  const rowUpdate: Partial<Pick<User, 'role' | 'tenantId'>> = {};
  if (options.role === 'member') {
    rowUpdate.role = UserRole.Member;
  }
  if (options.tenantId !== undefined) {
    rowUpdate.tenantId = options.tenantId;
  }
  if (Object.keys(rowUpdate).length > 0) {
    await userModel.updateOne({ email: credentials.email }, rowUpdate);
  }

  const persistedUser = await userModel.findOne({ email: credentials.email });
  if (!persistedUser) {
    throw new Error(`registerTestUser: no persisted row for '${credentials.email}'`);
  }

  const loginResponse = await request(getTestServer(app))
    .post('/api/v1/auth/login')
    .send(credentials);
  const { accessToken } = loginResponse.body as LoginResponseBody;

  return { token: accessToken, userId, tenantId: persistedUser.tenantId };
};
