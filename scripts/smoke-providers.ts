import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { z } from 'zod/v4';

import { AppConfigModule } from '../src/config/config.module';
import { mongooseModuleOptions } from '../src/config/mongo.config';
import type { AlsContext } from '../src/shared/types/als-context.type';
import { SharedModule } from '../src/shared/shared.module';
import { ProvidersModule } from '../src/providers/providers.module';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../src/providers/embedding/embedding-provider.interface';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../src/providers/model/model-provider.interface';

/**
 * Live end-to-end check of the vendor-facing providers. Everything else in the provider layer is
 * unit-tested against fakes and a stubbed transport — which proves the wiring but says nothing
 * about whether the real APIs still accept our request shape or report usage where we read it.
 * That is what this script is for, and why it is a script rather than a test: it costs money and
 * needs network, so it must never run in CI.
 *
 *   npm run smoke:providers
 */
// `MongooseModule.forRootAsync` for the same reason `app.module.ts`, `worker.module.ts` and
// `mcp.module.ts` all carry it: `ProvidersModule`'s spend guard and audit trail resolve
// Mongoose models, so the graph does not build without a `DatabaseConnection`. This script
// therefore needs Mongo reachable, the same as every other process in the stack.
@Module({
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    SharedModule,
    ProvidersModule,
  ],
})
class SmokeModule {}

// This script runs outside any real tenant's request scope, but `SpendGuardModelProvider` still
// requires a `tenantId` to attribute spend to (fails closed on a missing one). A fixed, clearly
// non-production id keeps a smoke run's spend attributable and out of any real tenant's ceiling.
const SMOKE_TENANT_ID = 'smoke-providers';

const CapRate = z.object({
  propertyName: z.string(),
  capRatePercent: z.number(),
});

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SmokeModule, { logger: ['error'] });

  try {
    const model = app.get<ModelProvider>(MODEL_PROVIDER);
    const embedding = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    console.log(`model:     ${model.info.provider} / ${model.info.model}`);
    console.log(
      `embedding: ${embedding.info.provider} / ${embedding.info.model} (${embedding.info.dimensions}d)`,
    );

    // Structured output: the parse succeeding is the real assertion. If Anthropic's
    // `output_format` contract drifts, this throws rather than quietly returning prose.
    const answer = await model.generate({
      taskClass: 'fact_extraction',
      system: 'Extract the requested figure. Respond only via the provided output schema.',
      messages: [
        {
          role: 'user',
          content:
            'Northgate Business Park transacted at a cap rate of 5.25%. Extract the property name and cap rate.',
        },
      ],
      outputSchema: CapRate,
      maxTokens: 256,
      maxCostUsd: 0.05,
      tenantId: SMOKE_TENANT_ID,
    });

    console.log(`\n— ${model.info.provider} —`);
    console.log(`parsed:  ${JSON.stringify(answer.output)}`);
    console.log(
      `usage:   in=${answer.usage.inputTokens} out=${answer.usage.outputTokens} ` +
        `cacheWrite=${answer.usage.cacheCreationInputTokens} cacheRead=${answer.usage.cacheReadInputTokens}`,
    );
    console.log(`cost:    $${answer.costUsd.toFixed(6)}`);

    // `embed` carries no `tenantId` of its own — `SpendGuardEmbeddingProvider` reads the tenant
    // from AsyncLocalStorage and fails CLOSED without one, so the call opens the same scope
    // `activities.ts` opens around every tenant-carrying activity.
    const als = app.get<AsyncLocalStorage<AlsContext>>(AsyncLocalStorage);
    const vectors = await als.run({ 'correlation-id': randomUUID(), tenant: SMOKE_TENANT_ID }, () =>
      embedding.embed({
        inputs: ['cap rate for the subject property', 'lease expiry schedule by tenant'],
        inputType: 'document',
      }),
    );

    const [first] = vectors.embeddings;
    if (!first) {
      fail(`${embedding.info.provider} returned no embeddings`);
    }
    if (first.length !== embedding.info.dimensions) {
      fail(
        `${embedding.info.provider} returned ${first.length}d vectors but info.dimensions reports ${embedding.info.dimensions} — ` +
          'index creation reads info.dimensions, so this mismatch would produce an unusable vector index',
      );
    }

    console.log(`\n— ${embedding.info.provider} —`);
    console.log(`vectors: ${vectors.embeddings.length} x ${first.length}d`);
    console.log(`usage:   ${vectors.usage.totalTokens} tokens`);
    console.log('\n✓ both providers responded and reported usage');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // A missing key surfaces here as the provider's own typed error, which already names the
  // variable — no need to pre-check and duplicate that message.
  console.error(error instanceof Error ? `✗ ${error.message}` : error);
  process.exit(1);
});
