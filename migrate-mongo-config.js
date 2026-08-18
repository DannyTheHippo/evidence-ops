import { config } from 'dotenv';
config();

export const mongodb = {
  // 27018 matches both `environment.config.ts`'s dev-default `MONGO_DB_URI` and the host port
  // `docker-compose.yml` publishes. All three have to agree: this file bypasses the zod schema
  // entirely, so a port that differs here migrates a database nobody is reading, and reports
  // success doing it.
  url: process.env.MONGO_DB_URI || 'mongodb://localhost:27018/evidence-ops?directConnection=true',

  options: {},
};

export const migrationsDir = 'migrations';
export const migrationFileExtension = '.ts';
export const changelogCollectionName = 'migrations';
