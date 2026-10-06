import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsUUID,
  IsArray,
  Min,
  Max,
  IsEmail,
  IsNotEmpty,
  Matches,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum SalesAgentStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ON_LEAVE = 'ON_LEAVE',
  SUSPENDED = 'SUSPENDED',
  TERMINATED = 'TERMINATED',
  DELETED = 'DELETED',
}

export class CreateSalesAgentAdminDto {
  @IsString()
  @IsNotEmpty({ message: 'Sales Agent name is required.' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Mobile number is required.' })
  @Matches(/^[+]?[0-9]{10,13}$/, {
    message: 'Mobile number must be a valid 10-digit number or international format.',
  })
  mobileNumber: string;

  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address.' })
  email?: string;

  @IsOptional()
  @IsString()
  employeeCode?: string;

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @IsOptional()
  @IsString()
  territory?: string;

  @IsOptional()
  @IsEnum(SalesAgentStatus)
  status?: SalesAgentStatus = SalesAgentStatus.ACTIVE;
}

export class UpdateSalesAgentAdminDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[+]?[0-9]{10,13}$/, {
    message: 'Mobile number must be a valid 10-digit number or international format.',
  })
  mobileNumber?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address.' })
  email?: string;

  @IsOptional()
  @IsString()
  employeeCode?: string;

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @IsOptional()
  @IsString()
  territory?: string;

  @IsOptional()
  @IsEnum(SalesAgentStatus)
  status?: SalesAgentStatus;
}

export class UpdateSalesAgentStatusDto {
  @IsString()
  @IsEnum(SalesAgentStatus)
  status: SalesAgentStatus;
}

export class SalesAgentFilterDto {
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
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class SalesAgentActivityFilterDto {
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
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  activityType?: string; // 'ALL' | 'LEAD_CREATED' | 'VISIT_SCHEDULED' | 'VISIT_CHECKIN' | 'VISIT_COMPLETED' | 'LEAD_CONVERTED'

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  interestLevel?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'timestamp';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class CreateSalesAgentProfileDto {
  @IsUUID()
  userId: string;

  @IsString()
  employeeCode: string;

  @IsOptional()
  @IsString()
  territory?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignedStates?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignedDistricts?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetInstitutions?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetVisits?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @IsOptional()
  @IsUUID()
  managerId?: string;
}

export class UpdateSalesAgentProfileDto {
  @IsOptional()
  @IsString()
  employeeCode?: string;

  @IsOptional()
  @IsString()
  territory?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignedStates?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignedDistricts?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetInstitutions?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetVisits?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @IsOptional()
  @IsEnum(SalesAgentStatus)
  status?: SalesAgentStatus;

  @IsOptional()
  @IsUUID()
  managerId?: string;
}
