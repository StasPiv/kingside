import {
  IsEnum,
  IsOptional,
  IsString,
  IsNumber,
} from 'class-validator';

export enum ClientLogType {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  EVENT = 'event',
}

export class ClientLogEventDto {
  @IsEnum(ClientLogType)
  type!: ClientLogType;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  stack?: string;

  @IsNumber()
  timestamp!: number;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
