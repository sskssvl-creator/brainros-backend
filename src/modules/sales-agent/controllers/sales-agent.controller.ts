import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SalesAgentService } from '../services/sales-agent.service';
import { UpdateSalesAgentProfileDto } from '../dto/sales-agent.dto';

@Controller('sales-agent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SALES_AGENT', 'SUPER_ADMIN')
export class SalesAgentController {
  constructor(private readonly salesAgentService: SalesAgentService) {}

  /**
   * GET /sales-agent/profile
   * Get current sales agent profile
   */
  @Get('profile')
  async getProfile(@CurrentUser('userId') userId: string) {
    const data = await this.salesAgentService.getAgentProfile(userId);
    return {
      statusCode: 200,
      message: 'Sales Agent profile retrieved successfully.',
      data,
    };
  }

  /**
   * PATCH /sales-agent/profile
   * Update current sales agent profile
   */
  @Patch('profile')
  async updateProfile(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSalesAgentProfileDto,
  ) {
    const data = await this.salesAgentService.updateAgentProfile(userId, dto, userId);
    return {
      statusCode: 200,
      message: 'Sales Agent profile updated successfully.',
      data,
    };
  }

  /**
   * GET /sales-agent/dashboard
   * Get sales agent dashboard metrics & KPI stats
   */
  @Get('dashboard')
  async getDashboard(@CurrentUser('userId') userId: string) {
    const data = await this.salesAgentService.getDashboardStats(userId);
    return {
      statusCode: 200,
      message: 'Dashboard statistics retrieved successfully.',
      data,
    };
  }

  /**
   * GET /sales-agent/territory
   * Get assigned geographic coverage & institutions
   */
  @Get('territory')
  async getTerritory(@CurrentUser('userId') userId: string) {
    const data = await this.salesAgentService.getTerritoryData(userId);
    return {
      statusCode: 200,
      message: 'Territory coverage retrieved successfully.',
      data,
    };
  }
}
