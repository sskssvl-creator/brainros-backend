import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsUUID,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum TargetPeriod {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  ANNUAL = 'ANNUAL',
}

export enum TargetMetric {
  VISITS = 'VISITS',
  LEADS = 'LEADS',
  INSTITUTIONS = 'INSTITUTIONS',
  REVENUE = 'REVENUE',
}

export class CreateSalesTargetDto {
  @IsUUID()
  salesAgentId: string;

  @IsEnum(TargetPeriod)
  period: TargetPeriod;

  @IsString()
  periodKey: string; // e.g., '2026-10' or '2026-Q4' or '2026'

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetVisits?: number = 0;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetLeads?: number = 0;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetInstitutions?: number = 0;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetRevenue?: number = 0;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateSalesTargetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  targetVisits?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetLeads?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetInstitutions?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetRevenue?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class SalesTargetFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @IsUUID()
  salesAgentId?: string;

  @IsOptional()
  @IsEnum(TargetPeriod)
  period?: TargetPeriod;

  @IsOptional()
  @IsString()
  periodKey?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'startDate';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}
