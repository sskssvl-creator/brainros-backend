import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StudentDashboardService } from '../services/student-dashboard.service';
import { StudentComparisonService } from '../services/student-comparison.service';
import { StudentComparisonQueryDto } from '../dto/student-comparison.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('students/me')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StudentDashboardController {
  constructor(
    private readonly dashboardService: StudentDashboardService,
    private readonly comparisonService: StudentComparisonService,
  ) {}

  /**
   * GET /students/me/dashboard
   * Single aggregated dashboard response containing next exam, resume card, performance, ranks, trends, and weak areas
   */
  @Get('dashboard')
  getDashboard(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = user.userId || user.id || user.sub;
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 5;
    return this.dashboardService.getStudentDashboard(userId, pageNum, limitNum);
  }

  /**
   * GET /students/me/analytics/comparison
   * Aggregated multi-mock comparison dataset for table views, subject matrix, and semantic trends
   */
  @Get('analytics/comparison')
  getComparison(
    @CurrentUser() user: any,
    @Query() query: StudentComparisonQueryDto,
  ) {
    const userId = user.userId || user.id || user.sub;
    return this.comparisonService.getStudentComparison(userId, query);
  }
}
