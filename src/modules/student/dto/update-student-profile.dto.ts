import { IsString, IsOptional, IsUUID } from 'class-validator';

export class UpdateStudentProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUUID()
  preferredLanguageId?: string;

  @IsOptional()
  @IsString()
  schoolCollege?: string;

  @IsOptional()
  @IsUUID()
  classId?: string;

  @IsOptional()
  @IsUUID()
  examTargetId?: string;

  @IsOptional()
  @IsUUID()
  stateId?: string;

  @IsOptional()
  @IsUUID()
  districtId?: string;
}
