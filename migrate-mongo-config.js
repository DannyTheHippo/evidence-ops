import { config } from 'dotenv';
config();

export const mongodb = {
  url: process.env.MONGO_DB_URI || 'mongodb://localhost:27017/evidence-ops?directConnection=true',

  options: {},
};

export const migrationsDir = 'migrations';
export const migrationFileExtension = '.ts';
export const changelogCollectionName = 'migrations';
