import { createHash } from 'node:crypto';

export const sha256Hex = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');
