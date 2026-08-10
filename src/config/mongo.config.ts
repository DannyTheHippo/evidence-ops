import type { MongooseModuleAsyncOptions } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection, ConnectOptions } from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { auditablePlugin } from '../database/plugins/auditable.plugin';
import { AlsContext } from '../shared/types/als-context.type';
import { TypedConfigService } from './environment/typed-config.service';

// Held so it can be stopped again. Spawning a mongod and dropping the handle leaves an
// orphaned process alive for the lifetime of the parent — under Jest that surfaces as
// "a worker process has failed to exit gracefully". Whoever starts it owns stopping it.
let inMemoryMongo: MongoMemoryReplSet | undefined;

/** Stops the in-memory replica set, if one was started. Safe to call when none was. */
export const stopInMemoryMongo = async (): Promise<void> => {
  await inMemoryMongo?.stop();
  inMemoryMongo = undefined;
};

/**
 * Async Mongoose options. When `MONGO_MEMORY_SERVER=true` (local dev / quick
 * runs without docker) an in-memory replica set is started. In every other case
 * the configured URI is used.
 */
export const mongooseModuleOptions: MongooseModuleAsyncOptions = {
  inject: [TypedConfigService, AsyncLocalStorage],
  useFactory: async (config: TypedConfigService, als: AsyncLocalStorage<AlsContext>) => {
    let uri: string = config.mongo.uri;
    if (config.mongo.memoryServer) {
      inMemoryMongo = await MongoMemoryReplSet.create();
      uri = inMemoryMongo.getUri();
    }

    const options: ConnectOptions = {
      minPoolSize: 5,
      maxPoolSize: 100,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      waitQueueTimeoutMS: 10000,
      maxIdleTimeMS: 60000,
      autoIndex: !config.mongo.memoryServer,
    };

    return {
      uri,
      ...options,
      connectionFactory: (connection: Connection) => {
        connection.plugin(auditablePlugin(als));
        return connection;
      },
    };
  },
};
