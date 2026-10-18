import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
  IsEmail,
  IsBoolean,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum StudentSortField {
  CREATED_AT = 'createdAt',
  NAME = 'name',
  STUDENT_ID = 'studentId',
  EMAIL = 'email',
  STATUS = 'status',
  SCHOOL_COLLEGE = 'schoolCollege',
}

export enum SortOrderEnum {
  ASC = 'asc',
  DESC = 'desc',
}

export enum ParentRelationshipEnum {
  FATHER = 'FATHER',
  MOTHER = 'MOTHER',
  GUARDIAN = 'GUARDIAN',
  OTHER = 'OTHER',
}

export class AdminStudentsQueryDto {
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
  pageSize?: number = 10;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsEnum(SortOrderEnum)
  sortOrder?: SortOrderEnum = SortOrderEnum.DESC;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsUUID()
  classId?: string;

  @IsOptional()
  @IsUUID()
  examTargetId?: string;

  @IsOptional()
  @IsString()
  stateId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @IsOptional()
  @IsString()
  createdFrom?: string;

  @IsOptional()
  @IsString()
  createdTo?: string;
}

export class SuperAdminRegistrationsQueryDto {
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
  pageSize?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsEnum(SortOrderEnum)
  sortOrder?: SortOrderEnum = SortOrderEnum.DESC;

  @IsOptional()
  @IsString()
  date?: string; // 'all' | 'today' | 'YYYY-MM-DD'

  @IsOptional()
  @IsString()
  stateId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  institutionId?: string;

  @IsOptional()
  @IsString()
  examTarget?: string; // 'ALL' | 'NEET' | 'JEE' | 'CET' or target name / UUID

  @IsOptional()
  @IsString()
  examTargetId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  classId?: string;
}

export class AddStudentParentDto {
  @IsString()
  @IsNotEmpty({ message: 'Parent name is required.' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Mobile number is required.' })
  mobile: string;

  @IsEmail({}, { message: 'A valid email address is required.' })
  @IsNotEmpty({ message: 'Email is required.' })
  email: string;

  @IsEnum(ParentRelationshipEnum, {
    message: 'Relationship must be FATHER, MOTHER, GUARDIAN, or OTHER.',
  })
  relationship: ParentRelationshipEnum;
}

export class UpdateAdminStudentDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  studentCode?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsString()
  schoolCollege?: string;

  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsUUID()
  classId?: string;

  @IsOptional()
  @IsUUID()
  examTargetId?: string;

  @IsOptional()
  @IsUUID()
  preferredLanguageId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  admissionYear?: number;

  @IsOptional()
  @IsBoolean()
  jee?: boolean;

  @IsOptional()
  @IsBoolean()
  cet?: boolean;

  @IsOptional()
  @IsBoolean()
  neet?: boolean;

  @IsOptional()
  @IsString()
  stateId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters long.' })
  password?: string;

  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ResetStudentPasswordDto {
  @IsNotEmpty({ message: 'Password is required.' })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters long.' })
  password: string;
}
