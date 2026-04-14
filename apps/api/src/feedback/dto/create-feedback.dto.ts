import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateFeedbackDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsIn(['bug', 'suggestion', 'question'])
  type!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  page?: string;
}
