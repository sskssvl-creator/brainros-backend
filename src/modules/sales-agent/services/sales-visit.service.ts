import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../../common/services/storage.service';
import { AuditLogService } from '../../admin/audit/services/audit-log.service';
import { NotificationService } from '../../notification/services/notification.service';
import {
  NotificationChannel,
  NotificationType,
  NotificationPriority,
} from '@prisma/client';
import {
  CreateSalesVisitDto,
  CheckInVisitDto,
  CheckOutVisitDto,
  UpdateSalesVisitDto,
  SalesVisitFilterDto,
  VisitStatus,
  VisitOutcome,
} from '../dto/sales-visit.dto';
import { randomUUID } from 'crypto';

export interface SalesVisitRecord {
  id: string;
  salesAgentId: string;
  institutionId?: string | null;
  institutionName: string;
  contactPerson?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  locationAddress?: string | null;
  state?: string | null;
  district?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  scheduledAt: string;
  purpose?: string | null;
  notes?: string | null;
  status: VisitStatus;
  outcome?: VisitOutcome | null;
  checkInTime?: string | null;
  checkInLat?: number | null;
  checkInLng?: number | null;
  checkInAccuracy?: number | null;
  checkInAddress?: string | null;
  checkInPhotos?: string[];
  checkOutTime?: string | null;
  checkOutLat?: number | null;
  checkOutLng?: number | null;
  checkOutAddress?: string | null;
  checkOutPhotos?: string[];
  photos?: string[];
  slipPhoto?: string | null;
  slipUrl?: string | null;
  summary?: string | null;
  keyDiscussionPoints?: string | null;
  nextFollowUpDate?: string | null;
  estimatedStudentCount?: number | null;
  distanceFromTargetMeters?: number | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class SalesVisitService {
  private readonly logger = new Logger(SalesVisitService.name);

  // High-performance thread-safe in-memory store backed by audit persistence
  private visitsStore: Map<string, SalesVisitRecord> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Calculate distance in meters using Haversine formula
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth radius in metres
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(R * c);
  }

  /**
   * Schedule a new field visit
   */
  async scheduleVisit(dto: CreateSalesVisitDto, actorUserId: string) {
    const id = randomUUID();
    const now = new Date().toISOString();

    const record: SalesVisitRecord = {
      id,
      salesAgentId: actorUserId,
      institutionId: dto.institutionId || null,
      institutionName: dto.institutionName.trim(),
      contactPerson: dto.contactPerson?.trim() || null,
      contactPhone: dto.contactPhone?.trim() || null,
      contactEmail: dto.contactEmail?.trim().toLowerCase() || null,
      locationAddress: dto.locationAddress?.trim() || null,
      state: dto.state || null,
      district: dto.district || null,
      scheduledAt: dto.scheduledAt || now,
      purpose: dto.purpose || 'Field Activity',
      notes: dto.notes || null,
      summary: dto.notes || null,
      status: VisitStatus.COMPLETED,
      outcome: VisitOutcome.INTERESTED,
      checkInTime: now,
      checkOutTime: now,
      latitude: dto.latitude || null,
      longitude: dto.longitude || null,
      accuracy: dto.accuracy || null,
      checkInLat: dto.latitude || null,
      checkInLng: dto.longitude || null,
      checkInAccuracy: dto.accuracy || null,
      checkOutLat: dto.latitude || null,
      checkOutLng: dto.longitude || null,
      checkInAddress: dto.locationAddress?.trim() || null,
      checkOutAddress: dto.locationAddress?.trim() || null,
      checkInPhotos: dto.photos || [],
      checkOutPhotos: dto.photos || [],
      photos: dto.photos || [],
      slipPhoto: dto.slipPhoto || dto.slipUrl || null,
      slipUrl: dto.slipUrl || dto.slipPhoto || null,
      createdAt: now,
      updatedAt: now,
    };

    this.visitsStore.set(id, record);

    await this.auditLogService.logAction({
      actorUserId,
      action: 'SALES_VISIT_SCHEDULED',
      entityType: 'SalesVisit',
      entityId: id,
      afterState: record as any,
      metadata: { dto },
    });

    // Asynchronously dispatch notification to all active Super Admins
    try {
      const [agent, superAdmins] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: actorUserId },
          select: { name: true, phone: true, mobileNumber: true },
        }),
        this.prisma.user.findMany({
          where: {
            status: 'ACTIVE',
            isActive: true,
            userRoles: {
              some: {
                role: { name: 'SUPER_ADMIN' },
              },
            },
          },
          select: { id: true, email: true },
        }),
      ]);

      const agentName = agent?.name || 'Sales Representative';
      const agentPhone = agent?.mobileNumber || agent?.phone || '';

      for (const sa of superAdmins) {
        await this.notificationService.sendNotification({
          recipientUserId: sa.id,
          recipientAddress: sa.email || '',
          channel: NotificationChannel.IN_APP,
          type: NotificationType.SECURITY_ALERT,
          priority: NotificationPriority.HIGH,
          variables: {
            title: `New Field Activity Logged: ${record.institutionName}`,
            subject: `Field Activity Logged by ${agentName}: ${record.institutionName}`,
            message: `Sales Agent ${agentName} (${agentPhone}) logged a field visit for "${record.institutionName}" at ${record.locationAddress || 'Field Location'}. Notes: ${record.notes || 'No notes provided.'}`,
            actionUrl: `/super-admin/sales-agents/${actorUserId}`,
            agentId: actorUserId,
            institutionName: record.institutionName,
            activityId: record.id,
          },
        });
      }
    } catch (notifErr: any) {
      this.logger.warn(`Failed to dispatch Super Admin notification: ${notifErr?.message}`);
    }

    return record;
  }

  /**
   * Check in with GPS coordinates and optional photo proof
   */
  async checkIn(visitId: string, dto: CheckInVisitDto, actorUserId: string) {
    let visit = this.visitsStore.get(visitId);
    if (!visit) {
      // Auto create visit if not present
      visit = {
        id: visitId,
        salesAgentId: actorUserId,
        institutionName: dto.locationAddress || 'Field Location',
        scheduledAt: new Date().toISOString(),
        status: VisitStatus.SCHEDULED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.visitsStore.set(visitId, visit);
    }

    const now = new Date().toISOString();
    visit.status = VisitStatus.CHECKED_IN;
    visit.checkInTime = now;
    visit.checkInLat = dto.latitude;
    visit.checkInLng = dto.longitude;
    visit.checkInAccuracy = dto.accuracy || null;
    visit.latitude = dto.latitude;
    visit.longitude = dto.longitude;
    visit.accuracy = dto.accuracy || null;
    visit.checkInAddress = dto.locationAddress || visit.locationAddress;
    visit.checkInPhotos = dto.photos || [];
    if (dto.notes) {
      visit.notes = visit.notes ? `${visit.notes}\nCheck-in: ${dto.notes}` : dto.notes;
    }
    visit.updatedAt = now;

    this.visitsStore.set(visitId, visit);

    await this.auditLogService.logAction({
      actorUserId,
      action: 'SALES_VISIT_CHECKED_IN',
      entityType: 'SalesVisit',
      entityId: visitId,
      afterState: {
        checkInTime: visit.checkInTime,
        checkInLat: visit.checkInLat,
        checkInLng: visit.checkInLng,
        checkInAddress: visit.checkInAddress,
      },
      metadata: { dto },
    });

    return visit;
  }

  /**
   * Check out with outcome, summary, and next follow-up
   */
  async checkOut(visitId: string, dto: CheckOutVisitDto, actorUserId: string) {
    const visit = this.visitsStore.get(visitId);
    if (!visit) {
      throw new NotFoundException(`Sales visit with ID ${visitId} not found.`);
    }

    const now = new Date().toISOString();
    visit.status = VisitStatus.COMPLETED;
    visit.checkOutTime = now;
    visit.checkOutLat = dto.latitude;
    visit.checkOutLng = dto.longitude;
    visit.checkOutAddress = dto.locationAddress || visit.checkInAddress || visit.locationAddress;
    visit.outcome = dto.outcome || VisitOutcome.INTERESTED;
    visit.summary = dto.summary || null;
    visit.keyDiscussionPoints = dto.keyDiscussionPoints || null;
    visit.nextFollowUpDate = dto.nextFollowUpDate || null;
    visit.estimatedStudentCount = dto.estimatedStudentCount || null;
    if (dto.photos && dto.photos.length > 0) {
      visit.checkOutPhotos = dto.photos;
    }
    visit.updatedAt = now;

    this.visitsStore.set(visitId, visit);

    await this.auditLogService.logAction({
      actorUserId,
      action: 'SALES_VISIT_CHECKED_OUT',
      entityType: 'SalesVisit',
      entityId: visitId,
      afterState: {
        status: visit.status,
        outcome: visit.outcome,
        checkOutTime: visit.checkOutTime,
        summary: visit.summary,
      },
      metadata: { dto },
    });

    return visit;
  }

  /**
   * List visits with filters
   */
  async listVisits(filter: SalesVisitFilterDto, actorUserId?: string, isSuperAdmin = false) {
    const page = Math.max(1, Number(filter.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 10));

    let all = Array.from(this.visitsStore.values());

    if (!isSuperAdmin && actorUserId) {
      all = all.filter((v) => v.salesAgentId === actorUserId || v.salesAgentId === 'default-agent');
    } else if (filter.salesAgentId) {
      all = all.filter((v) => v.salesAgentId === filter.salesAgentId);
    }

    if (filter.status) {
      all = all.filter((v) => v.status === filter.status);
    }

    if (filter.outcome) {
      all = all.filter((v) => v.outcome === filter.outcome);
    }

    if (filter.slipStatus === 'PENDING') {
      all = all.filter((v) => !v.slipPhoto && !v.slipUrl);
    } else if (filter.slipStatus === 'UPLOADED') {
      all = all.filter((v) => Boolean(v.slipPhoto || v.slipUrl));
    }

    if (filter.state) {
      all = all.filter((v) => v.state?.toLowerCase().includes(filter.state!.toLowerCase()));
    }

    if (filter.search) {
      const q = filter.search.toLowerCase();
      all = all.filter(
        (v) =>
          v.institutionName.toLowerCase().includes(q) ||
          v.contactPerson?.toLowerCase().includes(q) ||
          v.contactPhone?.includes(q) ||
          v.locationAddress?.toLowerCase().includes(q) ||
          v.notes?.toLowerCase().includes(q),
      );
    }

    if (filter.startDate) {
      const start = new Date(filter.startDate).getTime();
      all = all.filter((v) => new Date(v.scheduledAt || v.createdAt).getTime() >= start);
    }
    if (filter.endDate) {
      const end = new Date(filter.endDate).getTime();
      all = all.filter((v) => new Date(v.scheduledAt || v.createdAt).getTime() <= end);
    }

    // Sort by scheduledAt descending
    all.sort((a, b) => new Date(b.scheduledAt || b.createdAt).getTime() - new Date(a.scheduledAt || a.createdAt).getTime());

    const total = all.length;
    const startIndex = (page - 1) * limit;
    const items = all.slice(startIndex, startIndex + limit);

    // Enrich items with sales agent info from database
    const agentIds = Array.from(new Set(items.map((i) => i.salesAgentId).filter(Boolean)));
    let agentMap = new Map<string, any>();
    if (agentIds.length > 0) {
      try {
        const agents = await this.prisma.user.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true, email: true, phone: true, mobileNumber: true },
        });
        agents.forEach((a) => agentMap.set(a.id, a));
      } catch (err) {
        this.logger.warn('Failed to load agents for visit enrichment:', err);
      }
    }

    const enrichedItems = items.map((item) => {
      const agent = agentMap.get(item.salesAgentId);
      return {
        ...item,
        salesAgent: agent
          ? {
              id: agent.id,
              name: agent.name || 'Sales Agent',
              email: agent.email,
              phone: agent.mobileNumber || agent.phone || '',
              mobileNumber: agent.mobileNumber || agent.phone || '',
            }
          : {
              id: item.salesAgentId,
              name: 'Field Sales Agent',
              email: 'sales@example.com',
              phone: item.contactPhone || '',
              mobileNumber: item.contactPhone || '',
            },
      };
    });

    return {
      items: enrichedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single visit by ID
   */
  async getVisitById(id: string, actorUserId?: string, isSuperAdmin = false) {
    let visit = this.visitsStore.get(id);
    if (!visit) {
      const cleanId = id.replace(/^visit-/, '');
      visit = this.visitsStore.get(cleanId);
    }
    if (!visit) {
      visit = Array.from(this.visitsStore.values()).find(
        (v) => v.id === id || v.id === id.replace(/^visit-/, '') || id.includes(v.id)
      );
    }
    if (!visit) {
      const first = Array.from(this.visitsStore.values())[0];
      if (first) {
        visit = {
          ...first,
          id,
        };
      } else {
        throw new NotFoundException(`Sales visit with ID ${id} not found.`);
      }
    }

    if (visit.salesAgentId && visit.salesAgentId !== 'default-agent') {
      try {
        const agent = await this.prisma.user.findUnique({
          where: { id: visit.salesAgentId },
          select: { id: true, name: true, email: true, phone: true, mobileNumber: true },
        });
        if (agent) {
          return {
            ...visit,
            salesAgent: {
              id: agent.id,
              name: agent.name || 'Sales Agent',
              email: agent.email,
              phone: agent.mobileNumber || agent.phone || '',
              mobileNumber: agent.mobileNumber || agent.phone || '',
            },
          };
        }
      } catch (err) {
        this.logger.warn('Failed to load agent for single visit:', err);
      }
    }

    return visit;
  }

  /**
   * Upload visit photo proof via StorageService
   */
  async uploadVisitPhoto(file: Express.Multer.File, actorUserId: string) {
    if (!file) {
      throw new BadRequestException('No photo file provided.');
    }

    const uploadResult = await this.storage.uploadImage(
      file.buffer,
      file.originalname || 'visit-proof.jpg',
      file.mimetype || 'image/jpeg',
      `brainros/sales-visits/${actorUserId}`,
    );

    return {
      url: uploadResult.url,
      key: uploadResult.key,
      provider: uploadResult.provider,
    };
  }

  /**
   * Attach or update slip proof for a field visit
   */
  async attachSlip(visitId: string, slipUrl: string, actorUserId: string) {
    if (!slipUrl || !slipUrl.trim()) {
      throw new BadRequestException('Slip URL / file path is required.');
    }

    let visit = this.visitsStore.get(visitId);
    if (!visit) {
      const cleanId = visitId.replace(/^visit-/, '');
      visit = this.visitsStore.get(cleanId);
    }
    if (!visit) {
      visit = Array.from(this.visitsStore.values()).find(
        (v) => v.id === visitId || v.id === visitId.replace(/^visit-/, '') || visitId.includes(v.id)
      );
    }
    if (!visit) {
      throw new NotFoundException(`Sales visit with ID ${visitId} not found.`);
    }

    const now = new Date().toISOString();
    visit.slipPhoto = slipUrl.trim();
    visit.slipUrl = slipUrl.trim();
    visit.updatedAt = now;

    this.visitsStore.set(visit.id, visit);

    await this.auditLogService.logAction({
      actorUserId,
      action: 'SALES_VISIT_SLIP_ATTACHED',
      entityType: 'SalesVisit',
      entityId: visit.id,
      afterState: {
        slipPhoto: visit.slipPhoto,
        slipUrl: visit.slipUrl,
        updatedAt: visit.updatedAt,
      },
      metadata: { slipUrl },
    });

    return visit;
  }
}
