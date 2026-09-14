import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AcademicService } from './academic.service';
import {
  CreateSubjectDto,
  UpdateSubjectDto,
  CreateChapterDto,
  UpdateChapterDto,
  ChapterQueryDto,
  ReorderChaptersDto,
  CreateTopicDto,
  UpdateTopicDto,
  CreateSubTopicDto,
  UpdateSubTopicDto,
} from './dto/academic.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('academic')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AcademicController {
  constructor(private readonly academicService: AcademicService) {}

  // ─── Lookup Data (public for authenticated users) ────────────
  @Get('difficulty-levels')
  getDifficultyLevels() {
    return this.academicService.getDifficultyLevels();
  }

  @Get('question-types')
  getQuestionTypes() {
    return this.academicService.getQuestionTypes();
  }

  @Get('exam-statuses')
  getExamStatuses() {
    return this.academicService.getExamStatuses();
  }

  @Get('exam-targets')
  getExamTargets() {
    return this.academicService.getExamTargets();
  }

  @Get('hierarchy/:examTargetId')
  getHierarchy(@Param('examTargetId') examTargetId: string) {
    return this.academicService.getHierarchy(examTargetId);
  }

  // ─── Subjects ────────────────────────────────────────────────
  @Post('subjects')
  @Roles('ADMIN', 'SUPER_ADMIN')
  createSubject(@Body() dto: CreateSubjectDto, @Req() req: any) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.academicService.createSubject(dto, actorUserId);
  }

  @Get('subjects')
  findAllSubjects(
    @Query('examTargetId') examTargetId?: string,
    @Query('examTargetName') examTargetName?: string,
  ) {
    return this.academicService.findAllSubjects(examTargetId, examTargetName);
  }

  @Get('exam-targets/:targetId/subjects')
  findSubjectsByExamTarget(@Param('targetId') targetId: string) {
    return this.academicService.findAllSubjects(targetId);
  }

  @Get('subjects/:id')
  findSubjectById(@Param('id') id: string) {
    return this.academicService.findSubjectById(id);
  }

  @Patch('subjects/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  updateSubject(@Param('id') id: string, @Body() dto: UpdateSubjectDto) {
    return this.academicService.updateSubject(id, dto);
  }

  @Delete('subjects/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  deleteSubject(@Param('id') id: string) {
    return this.academicService.deleteSubject(id);
  }

  // ─── Chapters ────────────────────────────────────────────────
  @Get('chapters')
  findAllChapters(@Query() query: ChapterQueryDto) {
    return this.academicService.findAllChapters(query);
  }

  @Post('chapters')
  @Roles('ADMIN', 'SUPER_ADMIN')
  createChapter(@Body() dto: CreateChapterDto, @Req() req: any) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.academicService.createChapter(dto, actorUserId);
  }

  @Get('subjects/:subjectId/chapters')
  findChaptersBySubject(
    @Param('subjectId') subjectId: string,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    const shouldInclude =
      includeInactive === true || (includeInactive as any) === 'true';
    return this.academicService.findChaptersBySubject(subjectId, shouldInclude);
  }

  @Patch('subjects/:subjectId/chapters/reorder')
  @Roles('ADMIN', 'SUPER_ADMIN')
  reorderChapters(
    @Param('subjectId') subjectId: string,
    @Body() dto: ReorderChaptersDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.academicService.reorderChapters(
      subjectId,
      dto.chapterIds,
      actorUserId,
    );
  }

  @Get('chapters/:id')
  findChapterById(@Param('id') id: string) {
    return this.academicService.findChapterById(id);
  }

  @Patch('chapters/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  updateChapter(
    @Param('id') id: string,
    @Body() dto: UpdateChapterDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.academicService.updateChapter(id, dto, actorUserId);
  }

  @Delete('chapters/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  deleteChapter(@Param('id') id: string, @Req() req: any) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.academicService.deleteChapter(id, actorUserId);
  }

  // ─── Topics ──────────────────────────────────────────────────
  @Post('topics')
  @Roles('ADMIN', 'SUPER_ADMIN')
  createTopic(@Body() dto: CreateTopicDto) {
    return this.academicService.createTopic(dto);
  }

  @Get('chapters/:chapterId/topics')
  findTopicsByChapter(@Param('chapterId') chapterId: string) {
    return this.academicService.findTopicsByChapter(chapterId);
  }

  @Get('topics/:id')
  findTopicById(@Param('id') id: string) {
    return this.academicService.findTopicById(id);
  }

  @Patch('topics/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  updateTopic(@Param('id') id: string, @Body() dto: UpdateTopicDto) {
    return this.academicService.updateTopic(id, dto);
  }

  @Delete('topics/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  deleteTopic(@Param('id') id: string) {
    return this.academicService.deleteTopic(id);
  }

  // ─── Sub-Topics ──────────────────────────────────────────────
  @Post('sub-topics')
  @Roles('ADMIN', 'SUPER_ADMIN')
  createSubTopic(@Body() dto: CreateSubTopicDto) {
    return this.academicService.createSubTopic(dto);
  }

  @Get('topics/:topicId/sub-topics')
  findSubTopicsByTopic(@Param('topicId') topicId: string) {
    return this.academicService.findSubTopicsByTopic(topicId);
  }

  @Get('sub-topics/:id')
  findSubTopicById(@Param('id') id: string) {
    return this.academicService.findSubTopicById(id);
  }

  @Patch('sub-topics/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  updateSubTopic(@Param('id') id: string, @Body() dto: UpdateSubTopicDto) {
    return this.academicService.updateSubTopic(id, dto);
  }

  @Delete('sub-topics/:id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  deleteSubTopic(@Param('id') id: string) {
    return this.academicService.deleteSubTopic(id);
  }
}
