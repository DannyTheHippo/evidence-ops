import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class RegisterRequestDto {
  @ApiProperty({
    example: 'user@example.com',
    description:
      'Account email address. Required unless invitationToken is present — a token carries its own email, so this field is ignored when one is supplied.',
    required: false,
  })
  @ValidateIf((dto: RegisterRequestDto) => !dto.invitationToken)
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'correct-horse-battery-staple',
    description: 'Account password (8-72 characters).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @ApiProperty({
    example: 'eo_inv_9f8c12ab34cd56ef',
    description:
      'Single-use invitation token. When present, the invitation determines the tenant, role and email the account joins with.',
    required: false,
  })
  @IsOptional()
  @IsString()
  invitationToken?: string;
}
