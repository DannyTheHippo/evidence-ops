import type { ClassConstructor } from 'class-transformer';
import { plainToInstance } from 'class-transformer';
import { Document } from 'mongoose';

const toPlain = (value: unknown): unknown => {
  if (value instanceof Document) {
    return value.toJSON();
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toPlain(nested)]));
  }
  return value;
};

export const toResponseDto = <T extends object>(cls: ClassConstructor<T>, data: unknown): T =>
  plainToInstance(cls, toPlain(data), { excludeExtraneousValues: true });
