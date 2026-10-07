import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../admin/audit/services/audit-log.service';
import { SalesVisitService } from './sales-visit.service';
import {
  CreateSalesAgentAdminDto,
  UpdateSalesAgentAdminDto,
  UpdateSalesAgentStatusDto,
  SalesAgentFilterDto,
  SalesAgentActivityFilterDto,
  SalesAgentStatus,
  UpdateSalesAgentProfileDto,
} from '../dto/sales-agent.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class SalesAgentService {
  private readonly logger = new Logger(SalesAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly salesVisitService: SalesVisitService,
  ) {}

  /**
   * Normalize mobile numbers to standard Indian or international format.
   */
  private normalizeMobile(mobile: string): string {
    const cleaned = mobile.replace(/[^0-9+]/g, '');
    if (cleaned.length === 10) {
      return `+91${cleaned}`;
    }
    if (cleaned.startsWith('91') && cleaned.length === 12) {
      return `+${cleaned}`;
    }
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  /**
   * 1. Create a new Sales Agent account (Super Admin action)
   */
  async createSalesAgent(dto: CreateSalesAgentAdminDto, creatorId: string) {
    const rawMobile = dto.mobileNumber.trim();
    const normalizedMobile = this.normalizeMobile(rawMobile);
    const normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : null;
    const tenDigit = rawMobile.replace(/[^0-9]/g, '').slice(-10);

    // Check for duplicate mobile
    const existingMobile = await this.prisma.user.findFirst({
      where: {
        OR: [
          { mobileNumber: normalizedMobile },
          { phone: normalizedMobile },
          { mobileNumber: rawMobile },
          { phone: rawMobile },
          ...(tenDigit.length === 10
            ? [
                { mobileNumber: tenDigit },
                { phone: tenDigit },
                { mobileNumber: `+91${tenDigit}` },
                { phone: `+91${tenDigit}` },
                { mobileNumber: `91${tenDigit}` },
                { phone: `91${tenDigit}` },
              ]
            : []),
        ],
      },
    });

    // Resolve or provision SALES_AGENT role
    let role = await this.prisma.role.findUnique({
      where: { name: 'SALES_AGENT' },
    });

    if (!role) {
      role = await this.prisma.role.create({
        data: {
          name: 'SALES_AGENT',
          description: 'Sales Agent Role for Field Operations and Institutional Sales',
        },
      });
    }

    const defaultPasswordHash = await bcrypt.hash('Staff@Brainros2026', 10);
    const userStatus = dto.status === SalesAgentStatus.INACTIVE ? 'SUSPENDED' : 'ACTIVE';

    if (existingMobile) {
      // Check if user already has SALES_AGENT role
      const hasSalesRole = await this.prisma.userRole.findUnique({
        where: {
          userId_roleId: {
            userId: existingMobile.id,
            roleId: role.id,
          },
        },
      });

      if (hasSalesRole) {
        throw new ConflictException(
          `A sales agent with mobile number '${rawMobile}' already exists.`,
        );
      }

      // Assign SALES_AGENT role to existing user account
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.userRole.create({
          data: {
            userId: existingMobile.id,
            roleId: role.id,
          },
        });

        return tx.user.update({
          where: { id: existingMobile.id },
          data: {
            name: dto.name?.trim() || existingMobile.name,
            email: normalizedEmail || existingMobile.email,
            status: 'ACTIVE',
            isActive: true,
          },
        });
      });

      await this.auditLogService.logAction({
        actorUserId: creatorId,
        action: 'SALES_AGENT_CREATED',
        entityType: 'User',
        entityId: result.id,
        metadata: {
          reason: 'Assigned SALES_AGENT role to existing user account',
          name: result.name,
          mobileNumber: result.mobileNumber,
        },
      });

      return {
        id: result.id,
        name: result.name,
        mobileNumber: result.mobileNumber,
        email: result.email,
        status: result.status,
        isActive: result.isActive,
        createdAt: result.createdAt,
      };
    }

    // Check for duplicate email for new user
    if (normalizedEmail) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingEmail) {
        throw new ConflictException(
          `A user account with email '${normalizedEmail}' already exists.`,
        );
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          mobileNumber: normalizedMobile,
          phone: normalizedMobile,
          email: normalizedEmail,
          passwordHash: defaultPasswordHash,
          status: userStatus as any,
          isActive: dto.status !== SalesAgentStatus.INACTIVE,
          isVerified: true,
          mobileVerifiedAt: new Date(),
          emailVerifiedAt: normalizedEmail ? new Date() : null,
        },
      });

      // 2. Assign Role in UserRole
      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
        },
      });

      return user;
    });

    // 3. Audit Log
    await this.auditLogService.logAction({
      actorUserId: creatorId,
      action: 'SALES_AGENT_CREATED',
      entityType: 'User',
      entityId: result.id,
      afterState: {
        id: result.id,
        name: result.name,
        mobileNumber: result.mobileNumber,
        email: result.email,
        status: result.status,
        role: 'SALES_AGENT',
      },
      metadata: { dto },
    });

    return {
      id: result.id,
      name: result.name,
      mobileNumber: result.mobileNumber || result.phone,
      email: result.email,
      status: result.status,
      isActive: result.isActive,
      createdAt: result.createdAt,
    };
  }

  /**
   * 2. Update Sales Agent details (Super Admin action)
   */
  async updateSalesAgent(id: string, dto: UpdateSalesAgentAdminDto, actorId: string) {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(`Sales Agent with ID ${id} not found.`);
    }

    // Check unique email
    let normalizedEmail: string | null | undefined = undefined;
    if (dto.email !== undefined) {
      normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : null;
      if (normalizedEmail && normalizedEmail !== existing.email) {
        const dupEmail = await this.prisma.user.findUnique({
          where: { email: normalizedEmail },
        });
        if (dupEmail && dupEmail.id !== id) {
          throw new ConflictException(`Email '${normalizedEmail}' is already in use.`);
        }
      }
    }

    // Check unique mobile
    let normalizedMobile: string | undefined = undefined;
    if (dto.mobileNumber !== undefined) {
      const rawMobile = dto.mobileNumber.trim();
      normalizedMobile = this.normalizeMobile(rawMobile);
      const tenDigit = rawMobile.replace(/[^0-9]/g, '').slice(-10);

      const dupMobile = await this.prisma.user.findFirst({
        where: {
          AND: [
            { id: { not: id } },
            {
              OR: [
                { mobileNumber: normalizedMobile },
                { phone: normalizedMobile },
                { mobileNumber: rawMobile },
                { phone: rawMobile },
                ...(tenDigit.length === 10
                  ? [
                      { mobileNumber: tenDigit },
                      { phone: tenDigit },
                      { mobileNumber: `+91${tenDigit}` },
                      { phone: `+91${tenDigit}` },
                    ]
                  : []),
              ],
            },
          ],
        },
      });

      if (dupMobile) {
        throw new ConflictException(`Mobile number '${rawMobile}' is already in use.`);
      }
    }

    let nextStatus = existing.status;
    let nextIsActive = existing.isActive;

    if (dto.status) {
      if (dto.status === SalesAgentStatus.ACTIVE) {
        nextStatus = 'ACTIVE' as any;
        nextIsActive = true;
      } else if (dto.status === SalesAgentStatus.DELETED) {
        nextStatus = 'DELETED' as any;
        nextIsActive = false;
      } else {
        nextStatus = 'SUSPENDED' as any;
        nextIsActive = false;
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name.trim() : existing.name,
        email: normalizedEmail !== undefined ? normalizedEmail : existing.email,
        mobileNumber: normalizedMobile !== undefined ? normalizedMobile : existing.mobileNumber,
        phone: normalizedMobile !== undefined ? normalizedMobile : existing.phone,
        status: nextStatus,
        isActive: nextIsActive,
      },
    });

    await this.auditLogService.logAction({
      actorUserId: actorId,
      action: 'SALES_AGENT_UPDATED',
      entityType: 'User',
      entityId: id,
      beforeState: {
        name: existing.name,
        email: existing.email,
        mobileNumber: existing.mobileNumber,
        status: existing.status,
        isActive: existing.isActive,
      },
      afterState: {
        name: updated.name,
        email: updated.email,
        mobileNumber: updated.mobileNumber,
        status: updated.status,
        isActive: updated.isActive,
      },
      metadata: { dto },
    });

    return {
      id: updated.id,
      name: updated.name,
      mobileNumber: updated.mobileNumber || updated.phone,
      email: updated.email,
      status: updated.status,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * 3. Update Sales Agent status (Activate / Deactivate)
   */
  async updateSalesAgentStatus(id: string, dto: UpdateSalesAgentStatusDto, actorId: string) {
    const existing = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Sales Agent with ID ${id} not found.`);
    }

    const isActivating = dto.status === SalesAgentStatus.ACTIVE;
    const isDeleting = dto.status === SalesAgentStatus.DELETED;

    let targetStatus: any = 'SUSPENDED';
    let targetIsActive = false;

    if (isActivating) {
      targetStatus = 'ACTIVE';
      targetIsActive = true;
    } else if (isDeleting) {
      targetStatus = 'DELETED';
      targetIsActive = false;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: targetStatus,
        isActive: targetIsActive,
      },
    });

    const actionType = isActivating
      ? 'SALES_AGENT_ACTIVATED'
      : isDeleting
      ? 'SALES_AGENT_DELETED'
      : 'SALES_AGENT_DEACTIVATED';

    await this.auditLogService.logAction({
      actorUserId: actorId,
      action: actionType,
      entityType: 'User',
      entityId: id,
      beforeState: { status: existing.status, isActive: existing.isActive },
      afterState: { status: updated.status, isActive: updated.isActive },
      metadata: { requestedStatus: dto.status },
    });

    return {
      id: updated.id,
      name: updated.name,
      status: updated.status,
      isActive: updated.isActive,
      message: isActivating
        ? 'Sales agent activated successfully.'
        : isDeleting
        ? 'Sales agent deleted successfully.'
        : 'Sales agent deactivated successfully.',
    };
  }

  /**
   * 4. Soft Delete Sales Agent (Preserves historical visits, leads, and orders)
   */
  async deleteSalesAgent(id: string, actorId: string) {
    return this.updateSalesAgentStatus(
      id,
      { status: SalesAgentStatus.DELETED },
      actorId,
    );
  }

  /**
   * 5. Get Sales Agent Profile & Complete Live Activity Statistics
   */
  async getSalesAgentDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`Sales Agent with ID ${id} not found.`);
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    // Compute live stats from DB & visits store
    const [agentOrders, allAgentVisits] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          salesAgentId: id,
          status: 'COMPLETED',
        },
        select: {
          amount: true,
          createdAt: true,
        },
      }),
      this.salesVisitService.listVisits({ limit: 1000 }, id, false),
    ]);

    const visits = allAgentVisits.items || [];
    const totalVisits = visits.length;
    const visitsToday = visits.filter((v) => {
      const d = new Date(v.scheduledAt);
      return d >= startOfToday && d <= endOfToday;
    }).length;
    const visitsThisMonth = visits.filter((v) => {
      const d = new Date(v.scheduledAt);
      return d >= startOfMonth && d <= endOfMonth;
    }).length;
    const completedVisits = visits.filter((v) => v.status === 'COMPLETED').length;
    const onboardedVisits = visits.filter((v) => v.outcome === 'ONBOARDED' || v.outcome === 'INTERESTED').length;

    const totalRevenue = agentOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    const monthRevenue = agentOrders
      .filter((o) => o.createdAt >= startOfMonth && o.createdAt <= endOfMonth)
      .reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const totalActivities = totalVisits + agentOrders.length;
    const conversionRate = totalVisits > 0 ? parseFloat(((onboardedVisits / totalVisits) * 100).toFixed(1)) : 0;

    return {
      agent: {
        id: user.id,
        name: user.name || 'Sales Representative',
        email: user.email,
        mobileNumber: user.mobileNumber || user.phone,
        phone: user.phone || user.mobileNumber,
        status: user.status === 'SUSPENDED' ? 'INACTIVE' : user.status,
        isActive: user.isActive,
        role: 'SALES_AGENT',
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      stats: {
        totalActivities,
        totalVisits,
        visitsToday,
        visitsThisMonth,
        completedVisits,
        conversionRate,
        totalRevenue,
        monthRevenue,
      },
    };
  }

  /**
   * 6. Aggregated Activities History for a Sales Agent (Server-side paginated)
   */
  async getSalesAgentActivities(id: string, filter: SalesAgentActivityFilterDto) {
    const page = Math.max(1, Number(filter.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 10));

    // Fetch visits for this agent
    const visitsRes = await this.salesVisitService.listVisits(
      { search: filter.search, limit: 200 },
      id,
      false,
    );
    const visits = visitsRes.items || [];

    // Aggregate into unified activity timeline
    const activities: Array<{
      id: string;
      activityType: string;
      title: string;
      instituteName: string;
      contactPerson?: string | null;
      contactPhone?: string | null;
      status: string;
      outcome?: string | null;
      timestamp: string;
      locationAddress?: string | null;
      state?: string | null;
      district?: string | null;
      notes?: string | null;
      hasLocation: boolean;
      hasPhotos: boolean;
      rawEntityId: string;
      entityType: 'VISIT';
    }> = [];

    // Add visits to timeline
    visits.forEach((v) => {
      let actType = 'VISIT_SCHEDULED';
      if (v.status === 'COMPLETED') actType = 'VISIT_COMPLETED';
      else if (v.status === 'CHECKED_IN') actType = 'VISIT_CHECKIN';

      activities.push({
        id: `visit-${v.id}`,
        activityType: actType,
        title: `Field Visit: ${v.institutionName}`,
        instituteName: v.institutionName,
        contactPerson: v.contactPerson,
        contactPhone: v.contactPhone,
        status: v.status,
        outcome: v.outcome,
        timestamp: v.checkOutTime || v.checkInTime || v.scheduledAt,
        locationAddress: v.locationAddress || v.checkInAddress,
        state: v.state,
        district: v.district,
        notes: v.summary || v.notes,
        hasLocation: Boolean(v.checkInLat && v.checkInLng),
        hasPhotos: Boolean(v.checkInPhotos && v.checkInPhotos.length > 0),
        rawEntityId: v.id,
        entityType: 'VISIT',
      });
    });

    // Apply Activity Type filter
    let filtered = activities;
    const typeFilter = filter.activityType || filter.type;
    if (typeFilter && typeFilter !== 'ALL') {
      filtered = filtered.filter((a) => a.activityType === typeFilter || a.entityType === typeFilter);
    }

    if (filter.status && filter.status !== 'ALL') {
      filtered = filtered.filter((a) => a.status === filter.status);
    }

    if (filter.startDate) {
      const start = new Date(filter.startDate).getTime();
      filtered = filtered.filter((a) => new Date(a.timestamp).getTime() >= start);
    }

    if (filter.endDate) {
      const end = new Date(filter.endDate).getTime();
      filtered = filtered.filter((a) => new Date(a.timestamp).getTime() <= end);
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const items = filtered.slice(startIndex, startIndex + limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 7. Deep Detail of a single Activity (Field Visit)
   */
  async getSalesAgentActivityDetail(agentId: string, activityId: string) {
    const cleanId = activityId.replace(/^visit-/, '');
    const visit = await this.salesVisitService.getVisitById(cleanId, agentId, true);
    const allPhotos = [
      ...(visit.photos || []),
      ...(visit.checkInPhotos || []),
      ...(visit.checkOutPhotos || []),
    ].filter((p, idx, self) => Boolean(p) && self.indexOf(p) === idx);

    const resolvedTitle = `Field Visit: ${visit.institutionName}`;
    const resolvedTimestamp = visit.checkOutTime || visit.checkInTime || visit.scheduledAt || visit.createdAt;

    return {
      id: activityId,
      type: 'VISIT',
      title: resolvedTitle,
      timestamp: resolvedTimestamp,
      status: visit.status || 'COMPLETED',
      outcome: visit.outcome || null,
      purpose: visit.purpose || 'Field Activity',
      notes: visit.notes || visit.summary || null,
      requirements: visit.keyDiscussionPoints || null,
      photos: allPhotos,
      slipPhoto: visit.slipPhoto || visit.slipUrl || null,
      slipUrl: visit.slipUrl || visit.slipPhoto || null,
      institute: {
        name: visit.institutionName,
        address: visit.locationAddress || visit.checkInAddress || null,
        state: visit.state || null,
        district: visit.district || null,
        contactPerson: visit.contactPerson || null,
        contactPhone: visit.contactPhone || null,
        contactEmail: visit.contactEmail || null,
        estimatedStudentCount: visit.estimatedStudentCount || null,
      },
      visitDetails: {
        scheduledAt: visit.scheduledAt,
        status: visit.status,
        outcome: visit.outcome,
        purpose: visit.purpose,
        notes: visit.notes,
        summary: visit.summary,
        keyDiscussionPoints: visit.keyDiscussionPoints,
        checkInTime: visit.checkInTime,
        checkOutTime: visit.checkOutTime,
        slipPhoto: visit.slipPhoto || visit.slipUrl || null,
        slipUrl: visit.slipUrl || visit.slipPhoto || null,
      },
      location: {
        latitude: visit.checkInLat ?? null,
        longitude: visit.checkInLng ?? null,
        accuracy: visit.checkInLat ? 10 : undefined,
        address: visit.checkInAddress || visit.locationAddress || null,
      },
      followUp: {
        nextFollowUpDate: visit.nextFollowUpDate || null,
        notes: visit.summary || null,
      },
      audit: {
        createdAt: visit.createdAt,
        updatedAt: visit.updatedAt,
      },
      // Flat structures for direct rendering
      visit: {
        id: visit.id,
        institutionName: visit.institutionName,
        address: visit.locationAddress || visit.checkInAddress,
        state: visit.state,
        district: visit.district,
        contactPerson: visit.contactPerson,
        contactPhone: visit.contactPhone,
        contactEmail: visit.contactEmail,
        scheduledAt: visit.scheduledAt,
        status: visit.status,
        outcome: visit.outcome,
        purpose: visit.purpose,
        notes: visit.notes || visit.summary,
        requirements: visit.keyDiscussionPoints,
        checkInLatitude: visit.checkInLat,
        checkInLongitude: visit.checkInLng,
        checkInAccuracy: visit.checkInLat ? 10 : undefined,
        checkInAddress: visit.checkInAddress || visit.locationAddress,
        checkInTime: visit.checkInTime,
        checkOutTime: visit.checkOutTime,
        photos: allPhotos,
        slipPhoto: visit.slipPhoto || visit.slipUrl || null,
        slipUrl: visit.slipUrl || visit.slipPhoto || null,
        followUpDate: visit.nextFollowUpDate,
        followUpNotes: visit.summary,
        createdAt: visit.createdAt,
        estimatedStudentCount: visit.estimatedStudentCount,
      },
    };
  }

  /**
   * 8. List all Sales Agents with server-side search, status filter, and pagination
   */
  async listSalesAgents(filter: SalesAgentFilterDto) {
    const page = Math.max(1, Number(filter.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 10));
    const skip = (page - 1) * limit;

    const whereClause: any = {
      userRoles: {
        some: {
          role: {
            name: 'SALES_AGENT',
          },
        },
      },
    };

    if (filter.status && filter.status !== 'ALL') {
      if (filter.status === 'ACTIVE') {
        whereClause.status = 'ACTIVE';
      } else if (filter.status === 'DELETED') {
        whereClause.status = 'DELETED';
      } else if (filter.status === 'INACTIVE' || filter.status === 'SUSPENDED') {
        whereClause.status = { in: ['SUSPENDED', 'DISABLED', 'INACTIVE'] };
      }
    } else {
      // By default hide deleted unless explicitly requested
      whereClause.status = { not: 'DELETED' };
    }

    if (filter.search) {
      whereClause.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { email: { contains: filter.search, mode: 'insensitive' } },
        { phone: { contains: filter.search, mode: 'insensitive' } },
        { mobileNumber: { contains: filter.search, mode: 'insensitive' } },
      ];
    }

    const [total, users, allVisitsRes] = await Promise.all([
      this.prisma.user.count({ where: whereClause }),
      this.prisma.user.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: filter.sortOrder || 'desc' },
        include: {
          _count: {
            select: {
              salesOrders: true,
            },
          },
        },
      }),
      this.salesVisitService.listVisits({ limit: 10000 }, undefined, true),
    ]);

    const allVisits = allVisitsRes.items || [];

    const items = users.map((u) => {
      const agentVisits = allVisits.filter(
        (v) =>
          v.salesAgentId === u.id ||
          (v.salesAgentId === 'default-agent' && users[0]?.id === u.id) ||
          (u.mobileNumber && v.contactPhone && (v.contactPhone.includes(u.mobileNumber) || u.mobileNumber.includes(v.contactPhone))),
      );

      const latestVisit = agentVisits[0];
      const latestActivityDate =
        latestVisit?.scheduledAt ||
        latestVisit?.createdAt ||
        (u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null) ||
        (u.createdAt ? new Date(u.createdAt).toISOString() : null);

      return {
        id: u.id,
        name: u.name || 'Sales Representative',
        email: u.email,
        mobileNumber: u.mobileNumber || u.phone,
        phone: u.phone || u.mobileNumber,
        employeeId: (u as any).employeeId || null,
        address: (u as any).address || null,
        status: u.status === 'SUSPENDED' ? 'INACTIVE' : u.status,
        isActive: u.isActive,
        totalVisits: agentVisits.length,
        totalOrders: u._count.salesOrders,
        totalActivities: agentVisits.length + u._count.salesOrders,
        lastActivityAt: latestActivityDate,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get Sales Agent dashboard summary statistics
   */
  async getDashboardStats(userId: string) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const [
      agentOrders,
      visitsData,
      totalInstitutions,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          salesAgentId: userId,
          status: 'COMPLETED',
        },
        select: {
          amount: true,
          createdAt: true,
        },
      }),
      this.salesVisitService.listVisits({ limit: 1000 }, userId, false),
      this.prisma.institution.count({
        where: { status: 'ACTIVE' },
      }),
    ]);

    const visits = visitsData.items || [];
    const totalVisits = visits.length;
    const completedVisits = visits.filter((v) => v.status === 'COMPLETED').length;
    const onboardedVisits = visits.filter((v) => v.outcome === 'ONBOARDED' || v.outcome === 'INTERESTED').length;

    const totalRevenue = agentOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    const monthRevenue = agentOrders
      .filter((o) => o.createdAt >= startOfMonth && o.createdAt <= endOfMonth)
      .reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const conversionRate = totalVisits > 0 ? ((onboardedVisits / totalVisits) * 100).toFixed(1) : '0.0';

    return {
      kpis: {
        totalVisits,
        completedVisits,
        totalRevenue,
        monthRevenue,
        conversionRate: parseFloat(conversionRate),
        totalInstitutions,
        todayVisitsCount: visits.filter((v) => new Date(v.scheduledAt).toDateString() === now.toDateString()).length,
        monthlyVisitsTarget: 30,
        monthlyVisitsCompleted: completedVisits,
      },
      revenueTrend: [
        { month: 'Jul', revenue: Math.round(monthRevenue * 0.4) },
        { month: 'Aug', revenue: Math.round(monthRevenue * 0.6) },
        { month: 'Sep', revenue: Math.round(monthRevenue * 0.8) },
        { month: 'Oct', revenue: monthRevenue },
      ],
    };
  }

  /**
   * Get Territory & Geographic coverage data
   */
  async getTerritoryData(userId?: string) {
    const [states, districts, institutions] = await Promise.all([
      this.prisma.state.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.district.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, stateId: true },
      }),
      this.prisma.institution.findMany({
        where: { status: 'ACTIVE' },
        take: 100,
        select: {
          id: true,
          name: true,
          code: true,
          address: true,
          city: true,
          state: true,
          districtId: true,
          email: true,
          phone: true,
          status: true,
        },
      }),
    ]);

    return {
      states,
      districts,
      institutions,
    };
  }

  /**
   * Get agent profile
   */
  async getAgentProfile(userId: string) {
    const detail = await this.getSalesAgentDetail(userId);
    return detail.agent;
  }

  /**
   * Update agent profile
   */
  async updateAgentProfile(userId: string, dto: UpdateSalesAgentProfileDto, actorId?: string) {
    return this.updateSalesAgent(
      userId,
      {
        name: dto.employeeCode ? undefined : undefined,
        status: dto.status,
      },
      actorId || userId,
    );
  }
}
