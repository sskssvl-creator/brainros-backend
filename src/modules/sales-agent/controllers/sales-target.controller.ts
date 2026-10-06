import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SalesTargetService } from '../services/sales-target.service';
import {
  CreateSalesTargetDto,
  UpdateSalesTargetDto,
  SalesTargetFilterDto,
} from '../dto/sales-target.dto';

@Controller('sales-agent/targets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SALES_AGENT', 'SUPER_ADMIN')
export class SalesTargetController {
  constructor(private readonly targetService: SalesTargetService) {}

  /**
   * GET /sales-agent/targets/current
   * Get current target progress & attainment
   */
  @Get('current')
  async getCurrentTarget(
    @CurrentUser('userId') userId: string,
    @Query('periodKey') periodKey?: string,
  ) {
    const data = await this.targetService.getCurrentTarget(userId, periodKey);
    return {
      statusCode: 200,
      message: 'Current target metrics retrieved successfully.',
      data,
    };
  }

  /**
   * GET /sales-agent/targets/leaderboard
   * Get team leaderboard rankings
   */
  @Get('leaderboard')
  async getLeaderboard() {
    const data = await this.targetService.getLeaderboard();
    return {
      statusCode: 200,
      message: 'Sales leaderboard retrieved successfully.',
      data,
    };
  }

  /**
   * GET /sales-agent/targets
   * List historical targets
   */
  @Get()
  async listTargets(
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Query() filter: SalesTargetFilterDto,
  ) {
    const isSuperAdmin = Array.isArray(roles) && roles.includes('SUPER_ADMIN');
    const res = await this.targetService.listTargets(filter, userId, isSuperAdmin);
    return {
      statusCode: 200,
      message: 'Sales targets retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }
}
