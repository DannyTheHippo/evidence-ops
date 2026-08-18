import { MeResponseDto } from '../dtos/response/me.response.dto';

/**
 * Internal return shape of `AuthService.login`, distinct from `AuthTokenResponseDto`: `accessToken`
 * never reaches the HTTP response body — the DTO excludes it — but the controller still needs the
 * raw JWT to decode `exp` and mint the session cookie.
 */
export interface LoginResult {
  accessToken: string;
  user: MeResponseDto;
}
