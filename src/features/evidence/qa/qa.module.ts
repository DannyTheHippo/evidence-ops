import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../../providers/providers.module';
import { GroundingGateService } from './grounding-gate.service';
import { SynthesisService } from './synthesis.service';

// `GroundingGateService` has no Mongoose/model dependency of its own (see its doc comment: it
// verifies, never queries), so it needs no `ProvidersModule` import — only `SynthesisService`
// does, for `MODEL_PROVIDER`.
@Module({
  imports: [ProvidersModule],
  providers: [SynthesisService, GroundingGateService],
  exports: [SynthesisService, GroundingGateService],
})
export class QaModule {}
