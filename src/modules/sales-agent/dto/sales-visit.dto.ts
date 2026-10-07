import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsUUID,
  IsArray,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum VisitStatus {
  SCHEDULED = 'SCHEDULED',
  CHECKED_IN = 'CHECKED_IN',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  MISSED = 'MISSED',
}

export enum VisitOutcome {
  INTERESTED = 'INTERESTED',
  DEMO_REQUESTED = 'DEMO_REQUESTED',
  FOLLOW_UP_NEEDED = 'FOLLOW_UP_NEEDED',
  PROPOSAL_REQUESTED = 'PROPOSAL_REQUESTED',
  NOT_INTERESTED = 'NOT_INTERESTED',
  ONBOARDED = 'ONBOARDED',
}

export class CreateSalesVisitDto {
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @IsString()
  institutionName: string;

  @IsOptional()
  @IsString()
  contactPerson?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  locationAddress?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @IsOptional()
  @IsString()
  slipPhoto?: string;

  @IsOptional()
  @IsString()
  slipUrl?: string;
}

export class CheckInVisitDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @IsString()
  locationAddress?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CheckOutVisitDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @IsString()
  locationAddress?: string;

  @IsOptional()
  @IsEnum(VisitOutcome)
  outcome?: VisitOutcome;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  keyDiscussionPoints?: string;

  @IsOptional()
  @IsDateString()
  nextFollowUpDate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedStudentCount?: number;

  @IsOptional()
  @IsString()
  slipPhoto?: string;

  @IsOptional()
  @IsString()
  slipUrl?: string;
}

export class UpdateSalesVisitDto {
  @IsOptional()
  @IsString()
  institutionName?: string;

  @IsOptional()
  @IsString()
  contactPerson?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  locationAddress?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsEnum(VisitStatus)
  status?: VisitStatus;

  @IsOptional()
  @IsEnum(VisitOutcome)
  outcome?: VisitOutcome;

  @IsOptional()
  @IsDateString()
  nextFollowUpDate?: string;

  @IsOptional()
  @IsString()
  slipPhoto?: string;

  @IsOptional()
  @IsString()
  slipUrl?: string;
}

export class SalesVisitFilterDto {
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
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  outcome?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'scheduledAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}
