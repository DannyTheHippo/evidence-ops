import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** The token travels in the body, not a query parameter — a query string reaches proxy and access
 *  logs the URL fragment it is carried in client-side exists to stay out of. */
export class PreviewInvitationRequestDto {
  @ApiProperty({
    example: 'eo_inv_9f8c12ab34cd56ef',
    description: 'Single-use invitation token, read from the invite link.',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}
