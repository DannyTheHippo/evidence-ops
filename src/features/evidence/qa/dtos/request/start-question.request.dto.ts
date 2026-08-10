import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class StartQuestionRequestDto {
  @ApiProperty({
    example: 'What is the cap rate for Northgate Business Park in Q1 2025?',
    description: 'Natural-language question to answer from the evidence corpus.',
  })
  @IsString()
  @IsNotEmpty()
  questionText: string;
}
