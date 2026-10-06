import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SalesAgentService } from '../services/sales-agent.service';
import { SalesTargetService } from '../services/sales-target.service';
import { SalesVisitService } from '../services/sales-visit.service';
import {
  CreateSalesAgentAdminDto,
  UpdateSalesAgentAdminDto,
  UpdateSalesAgentStatusDto,
  SalesAgentFilterDto,
  SalesAgentActivityFilterDto,
} from '../dto/sales-agent.dto';
import {
  CreateSalesTargetDto,
  UpdateSalesTargetDto,
} from '../dto/sales-target.dto';
import { SalesVisitFilterDto } from '../dto/sales-visit.dto';

@Controller(['admin/sales-agents', 'super-admin/sales-agents'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN')
export class AdminSalesController {
  constructor(
    private readonly salesAgentService: SalesAgentService,
    private readonly salesTargetService: SalesTargetService,
    private readonly salesVisitService: SalesVisitService,
  ) {}

  /**
   * 1. List all Sales Agents with pagination, search, status filters
   * GET /super-admin/sales-agents or /admin/sales-agents
   */
  @Get()
  async listSalesAgents(@Query() filter: SalesAgentFilterDto) {
    const res = await this.salesAgentService.listSalesAgents(filter);
    return {
      statusCode: 200,
      message: 'Sales agents retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }

  /**
   * POST fallback for listing sales agents (supports project POST convention)
   */
  @Post('list')
  async listSalesAgentsPost(@Body() filter: SalesAgentFilterDto) {
    const res = await this.salesAgentService.listSalesAgents(filter);
    return {
      statusCode: 200,
      message: 'Sales agents retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }

  /**
   * 2. Create a new Sales Agent
   * POST /super-admin/sales-agents or /admin/sales-agents
   */
  @Post()
  async createSalesAgent(
    @CurrentUser('userId') actorId: string,
    @Body() dto: CreateSalesAgentAdminDto,
  ) {
    const data = await this.salesAgentService.createSalesAgent(dto, actorId);
    return {
      statusCode: 201,
      message: 'Sales agent created successfully.',
      data,
    };
  }

  /**
   * 3. Get Sales Agent Profile & Live Activity Summary Statistics
   * GET /super-admin/sales-agents/:id
   */
  @Get(':id')
  async getSalesAgentDetail(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.salesAgentService.getSalesAgentDetail(id);
    return {
      statusCode: 200,
      message: 'Sales agent details retrieved successfully.',
      data,
    };
  }

  /**
   * POST fallback for Sales Agent Detail
   */
  @Post(':id/detail')
  async getSalesAgentDetailPost(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.salesAgentService.getSalesAgentDetail(id);
    return {
      statusCode: 200,
      message: 'Sales agent details retrieved successfully.',
      data,
    };
  }

  /**
   * 4. Update Sales Agent details
   * PATCH /super-admin/sales-agents/:id or POST /super-admin/sales-agents/:id/update
   */
  @Patch(':id')
  async updateSalesAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: UpdateSalesAgentAdminDto,
  ) {
    const data = await this.salesAgentService.updateSalesAgent(id, dto, actorId);
    return {
      statusCode: 200,
      message: 'Sales agent updated successfully.',
      data,
    };
  }

  @Post(':id/update')
  async updateSalesAgentPost(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: UpdateSalesAgentAdminDto,
  ) {
    const data = await this.salesAgentService.updateSalesAgent(id, dto, actorId);
    return {
      statusCode: 200,
      message: 'Sales agent updated successfully.',
      data,
    };
  }

  /**
   * 5. Activate / Deactivate Sales Agent
   * PATCH /super-admin/sales-agents/:id/status or POST /super-admin/sales-agents/:id/status
   */
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: UpdateSalesAgentStatusDto,
  ) {
    const data = await this.salesAgentService.updateSalesAgentStatus(id, dto, actorId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  @Post(':id/status')
  async updateStatusPost(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: UpdateSalesAgentStatusDto,
  ) {
    const data = await this.salesAgentService.updateSalesAgentStatus(id, dto, actorId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * 6. Delete (Soft-Delete) Sales Agent
   * DELETE /super-admin/sales-agents/:id or POST /super-admin/sales-agents/:id/delete
   */
  @Delete(':id')
  async deleteSalesAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
  ) {
    const data = await this.salesAgentService.deleteSalesAgent(id, actorId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  @Post(':id/delete')
  async deleteSalesAgentPost(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
  ) {
    const data = await this.salesAgentService.deleteSalesAgent(id, actorId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * 7. Aggregated Activities List for a Sales Agent
   * GET /super-admin/sales-agents/:id/activities or POST /super-admin/sales-agents/:id/activities
   */
  @Get(':id/activities')
  async getActivities(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() filter: SalesAgentActivityFilterDto,
  ) {
    const res = await this.salesAgentService.getSalesAgentActivities(id, filter);
    return {
      statusCode: 200,
      message: 'Activities retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }

  @Post(':id/activities')
  async getActivitiesPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() filter: SalesAgentActivityFilterDto,
  ) {
    const res = await this.salesAgentService.getSalesAgentActivities(id, filter);
    return {
      statusCode: 200,
      message: 'Activities retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }

  /**
   * 8. Deep Activity Detail
   * GET /super-admin/sales-agents/:id/activities/:activityId
   */
  @Get(':id/activities/:activityId')
  async getActivityDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId') activityId: string,
  ) {
    const data = await this.salesAgentService.getSalesAgentActivityDetail(id, activityId);
    return {
      statusCode: 200,
      message: 'Activity details retrieved successfully.',
      data,
    };
  }
}
