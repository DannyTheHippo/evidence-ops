import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import type { StringValue } from 'ms';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  Tenant,
  TenantSchema,
} from '../../../database/schemas/administration/tenant/tenant.schema';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
    JwtModule.registerAsync({
      global: true,
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService) => {
        const { jwtSecret, jwtExpiresIn } = config.auth;

        return {
          secret: jwtSecret,
          signOptions: { expiresIn: jwtExpiresIn as StringValue },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: JwtAuthGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
