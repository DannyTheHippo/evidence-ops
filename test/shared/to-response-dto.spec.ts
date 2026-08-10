import { MeResponseDto } from '../../src/features/common/auth/dtos/response/me.response.dto';
import { toResponseDto } from '../../src/shared/utils/to-response-dto.util';

describe('toResponseDto', () => {
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
