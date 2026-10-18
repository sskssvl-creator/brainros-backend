import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BulkStudentUploadQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class ConfirmBulkStudentRegistrationDto {
  @IsNotEmpty()
  @IsUUID()
  uploadId: string;
}

export class UpdateBulkStudentRowDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  class?: string;

  @IsOptional()
  @IsString()
  examTarget?: string;

  @IsOptional()
  @IsString()
  preferredLanguage?: string;

  @IsOptional()
  @IsString()
  schoolCollege?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  jee?: boolean;

  @IsOptional()
  cet?: boolean;

  @IsOptional()
  neet?: boolean;

  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}

export interface BulkStudentRowNormalized {
  name: string;
  mobile: string;
  email?: string | null;
  passwordHash?: string | null;
  jee?: boolean;
  cet?: boolean;
  neet?: boolean;
  state?: string | null;
  city?: string | null;
  class?: string | null;
  examTarget?: string | null;
  examTargetId?: string | null;
  examTargetIds?: string[];
  preferredLanguage?: string | null;
  schoolCollege?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
}

export interface BulkStudentRowError {
  field: string;
  errorCode: string;
  message: string;
}
