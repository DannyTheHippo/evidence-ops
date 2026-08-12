import { Expose } from 'class-transformer';
import { Schema, model } from 'mongoose';

import { MeResponseDto } from '../../../src/features/common/auth/dtos/response/me.response.dto';
import { toResponseDto } from '../../../src/shared/utils/to-response-dto.util';

// Ad-hoc response shape mirroring what `toPlain`'s Document branch hands to `plainToInstance` —
// only `email`, so the assertion isn't tangled up in how class-transformer separately handles a
// raw ObjectId value (a different concern from whether `toJSON()` ran at all).
class DocumentSourcedResponseDto {
  @Expose()
  email: string;
}

class TagsResponseDto {
  @Expose()
  tags: string[];
}

describe('toResponseDto', () => {
  it('serializes a Mongoose Document via toJSON before mapping onto the response DTO', () => {
    // A real Document (not a mock) exercises the `instanceof Document` branch that a plain object
    // fixture never reaches — construction alone needs no DB connection.
    const ToResponseDtoTestModel = model('ToResponseDtoTestModel', new Schema({ email: String }));
    const doc = new ToResponseDtoTestModel({ email: 'user@example.com' });

    const result = toResponseDto(DocumentSourcedResponseDto, doc);

    expect(result).toEqual({ email: 'user@example.com' });
  });

  it('recursively converts each element of a nested array field (e.g. `citations`, `conflictIds`)', () => {
    const result = toResponseDto(TagsResponseDto, { tags: ['rent-roll', 'q3'] });

    expect(result).toEqual({ tags: ['rent-roll', 'q3'] });
  });

  it('drops extraneous keys not declared with @Expose on the target DTO', () => {
    const source = {
      id: '65f1c2e4a1b2c3d4e5f6a7b8',
      email: 'user@example.com',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      password: 'hashed-secret',
    };

    const result = toResponseDto(MeResponseDto, source);

    expect(result).not.toHaveProperty('password');
  });

  it('preserves every declared @Expose property from the source', () => {
    const source = {
      id: '65f1c2e4a1b2c3d4e5f6a7b8',
      email: 'user@example.com',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const result = toResponseDto(MeResponseDto, source);

    expect(result).toEqual(source);
  });
});
