import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterRequestDto {
  @ApiProperty({ example: 'user@example.com', description: 'Account email address.' })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'correct-horse-battery-staple',
    description: 'Account password (8-72 characters).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
