import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { HealthResponseDto } from './dtos/response/health.response.dto';

const MONGO_PING_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async getHealth(): Promise<HealthResponseDto> {
    const mongoUp = await this.pingMongo();

    return { status: mongoUp ? 'ok' : 'degraded', mongo: mongoUp ? 'up' : 'down' };
  }

  // Measurement-only endpoint: fails OPEN. A broken ping (missing db handle, rejection,
  // or timeout) reports 'degraded' — it must never throw and take the app down with it.
  private async pingMongo(): Promise<boolean> {
    const db = this.connection.db;
    if (!db) {
      return false;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.admin().ping(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Mongo ping timed out')),
            MONGO_PING_TIMEOUT_MS,
          );
        }),
      ]);

      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
