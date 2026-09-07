import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Verification,
  VerificationSchema,
} from '../../../database/schemas/evidence/verification/verification.schema';
import { VerificationsController } from './verifications.controller';
import { VerificationsService } from './verifications.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Verification.name, schema: VerificationSchema }])],
  controllers: [VerificationsController],
  providers: [VerificationsService],
  exports: [VerificationsService],
})
export class VerificationsModule {}
