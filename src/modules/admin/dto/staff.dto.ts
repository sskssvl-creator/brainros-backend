import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsUUID,
  IsIn,
  Matches,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export const VALID_STAFF_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'GENERAL_MANAGER',
  'MANAGER',
  'OPERATOR',
  'ACCOUNTANT',
  'SALES_AGENT',
] as const;

export type ValidStaffRole = typeof VALID_STAFF_ROLES[number];

export class CreateStaffDto {
  @IsString()
  @IsNotEmpty({ message: 'Staff name is required.' })
  name: string;

  @IsOptional()
  @IsString()
  @Matches(/^[+]?[0-9]{10,13}$/, {
    message: 'Mobile number must be a valid 10-digit number or international format.',
  })
  mobileNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[+]?[0-9]{10,13}$/, {
    message: 'Phone number must be a valid 10-digit number or international format.',
  })
  phoneNumber?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address.' })
  email?: string;

  @IsString()
  @IsNotEmpty({ message: 'Role is required.' })
  @IsIn(VALID_STAFF_ROLES, {
    message: `Role must be one of: ${VALID_STAFF_ROLES.join(', ')}`,
  })
  role: ValidStaffRole;
}

export class UpdateStaffDto {
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
  @IsString()
  @Matches(/^[+]?[0-9]{10,13}$/, {
    message: 'Phone number must be a valid 10-digit number or international format.',
  })
  phoneNumber?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address.' })
  email?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_STAFF_ROLES, {
    message: `Role must be one of: ${VALID_STAFF_ROLES.join(', ')}`,
  })
  role?: ValidStaffRole;

  @IsOptional()
  @IsUUID('4', { message: 'institutionId must be a valid UUID.' })
  institutionId?: string;
}

export class UpdateStaffStatusDto {
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DISABLED'], {
    message: 'Status must be ACTIVE, INACTIVE, SUSPENDED, or DISABLED.',
  })
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'DISABLED';
}

export class StaffFilterDto {
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
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
