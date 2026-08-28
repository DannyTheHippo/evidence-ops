import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import packageJSON from '../package.json';

/**
 * Emits the API's OpenAPI document to `web/src/api/openapi.json`, the input the SPA's response
 * types are generated from.
 *
 * Runs the Nest graph in preview mode: modules and controller metadata are assembled, but no
 * provider is instantiated and no lifecycle hook runs, so nothing opens a Mongo connection or a
 * Temporal client. The document therefore builds with neither service running.
 *
 * MUST run under `ts-node` with `tsconfig.ts-node.json`, never `tsx`: `@nestjs/swagger` reads a
 * property's type from `emitDecoratorMetadata` wherever an `@ApiProperty` omits an explicit
 * `type`, and esbuild does not emit that metadata — under `tsx` those properties silently vanish
 * from the schema.
 */
const OUTPUT_PATH = resolve(__dirname, '..', 'web', 'src', 'api', 'openapi.json');

const generate = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setVersion(packageJSON.version)
      .setTitle('Evidence Ops API')
      .setDescription('Evidence Ops API specification')
      .build(),
  );

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`);

  await app.close();
};

void generate();
