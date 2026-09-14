import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateInstitutionDto,
  UpdateInstitutionDto,
  UpdateInstitutionStatusDto,
  AssignAdminDto,
  InstitutionQueryDto,
} from '../dto/institution.dto';

// Valid lifecycle transitions
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['ACTIVE'],
  ACTIVE: ['SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  REJECTED: ['DRAFT'],
  CANCELLED: ['DRAFT'],
  ARCHIVED: [],
};

@Injectable()
export class InstitutionService {
  private readonly logger = new Logger(InstitutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new institution (Super Admin only).
   */
  async create(dto: CreateInstitutionDto, createdById: string) {
    // Check code uniqueness
    const existing = await this.prisma.institution.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new BadRequestException(
        `Institution code '${dto.code}' already exists.`,
      );
    }

    const institution = await this.prisma.institution.create({
      data: {
        name: dto.name,
        code: dto.code,
        type: (dto.type as any) || 'COACHING',
        email: dto.email,
        phone: dto.phone,
        address: dto.address,
        city: dto.city,
        state: dto.state,
        country: dto.country || 'India',
        createdById,
      },
    });

    this.logger.log(
      `Institution '${institution.name}' created with id '${institution.id}'`,
    );
    return institution;
  }

  /**
   * List all institutions with filters (Super Admin only).
   */
  async findAll(query: InstitutionQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [institutions, total] = await Promise.all([
      this.prisma.institution.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { admins: true, batches: true } },
        },
      }),
      this.prisma.institution.count({ where }),
    ]);

    return {
      data: institutions,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single institution by ID.
   */
  async findById(id: string) {
    const institution = await this.prisma.institution.findUnique({
      where: { id },
      include: {
        admins: {
          include: { user: { select: { id: true, email: true, phone: true } } },
        },
        _count: {
          select: { batches: true, bulkUploads: true, reportJobs: true },
        },
      },
    });

    if (!institution) {
      throw new NotFoundException(`Institution '${id}' not found.`);
    }

    return institution;
  }

  /**
   * Update institution settings (Institution Admin, scoped).
   */
  async update(id: string, dto: UpdateInstitutionDto) {
    return this.prisma.institution.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.email && { email: dto.email }),
        ...(dto.phone && { phone: dto.phone }),
        ...(dto.address && { address: dto.address }),
        ...(dto.city && { city: dto.city }),
        ...(dto.state && { state: dto.state }),
      },
    });
  }

  /**
   * Lifecycle status transition (Super Admin only).
   */
  async updateStatus(id: string, dto: UpdateInstitutionStatusDto) {
    const institution = await this.prisma.institution.findUnique({
      where: { id },
    });
    if (!institution) {
      throw new NotFoundException(`Institution '${id}' not found.`);
    }

    const allowed = STATUS_TRANSITIONS[institution.status] || [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition from '${institution.status}' to '${dto.status}'. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }

    return this.prisma.institution.update({
      where: { id },
      data: { status: dto.status as any },
    });
  }

  /**
   * Assign an admin to an institution (Super Admin only).
   */
  async assignAdmin(institutionId: string, dto: AssignAdminDto) {
    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
    });
    if (!institution) {
      throw new NotFoundException(`Institution '${institutionId}' not found.`);
    }

    // Check user exists
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new NotFoundException(`User '${dto.userId}' not found.`);
    }

    return this.prisma.institutionAdmin.upsert({
      where: {
        institutionId_userId: {
          institutionId,
          userId: dto.userId,
        },
      },
      update: {
        role: dto.role || 'ADMIN',
        isActive: true,
      },
      create: {
        institutionId,
        userId: dto.userId,
        role: dto.role || 'ADMIN',
      },
    });
  }
}
