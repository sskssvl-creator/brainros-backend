import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { JobProgressService } from '../services/job-progress.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller(['jobs', 'api/v1/jobs'])
@UseGuards(JwtAuthGuard)
export class JobProgressController {
  constructor(private readonly jobProgressService: JobProgressService) {}

  @Get(':queue/:jobId/status')
  async getJobStatus(
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: any,
  ) {
    const status = await this.jobProgressService.getJobStatus(queue, jobId);
    if (!status) {
      throw new NotFoundException(
        `Job status for queue '${queue}' and jobId '${jobId}' was not found or has expired.`,
      );
    }

    // Authorization check: User must own the job or have admin permissions
    const roles = user?.roles || (user?.role ? [user.role] : []);
    const isAdmin =
      roles.includes('ADMIN') ||
      roles.includes('SUPER_ADMIN') ||
      roles.includes('GENERAL_MANAGER') ||
      roles.includes('MANAGER') ||
      roles.includes('OPERATOR') ||
      roles.includes('INSTITUTION_ADMIN');

    const jobUserId = status.job?.userId;
    const currentUserId = user?.userId || user?.id;

    if (!isAdmin && jobUserId && currentUserId && jobUserId !== currentUserId) {
      throw new ForbiddenException(
        'You are not authorized to view status for this job.',
      );
    }

    return status;
  }
}
