import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  UpdateSchoolStatusDto,
  SchoolQueryDto,
} from '../dto/admin-schools.dto';

@Injectable()
export class AdminSchoolsService {
  private readonly logger = new Logger(AdminSchoolsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new school / institution
   */
  async createSchool(dto: CreateSchoolDto, actorUserId: string) {
    const trimmedCode = dto.code.trim().toUpperCase();

    // Check code uniqueness
    const existing = await this.prisma.institution.findUnique({
      where: { code: trimmedCode },
    });
    if (existing) {
      throw new BadRequestException(`School code '${trimmedCode}' already exists.`);
    }

    let rawPhone = (dto.phone || '').trim();
    if (rawPhone && !rawPhone.startsWith('+')) {
      const digits = rawPhone.replace(/\D/g, '');
      if (digits.length === 10) {
        rawPhone = `+91${digits}`;
      } else if (digits.length === 12 && digits.startsWith('91')) {
        rawPhone = `+${digits}`;
      }
    }

    const school = await this.prisma.institution.create({
      data: {
        name: dto.name.trim(),
        code: trimmedCode,
        type: 'SCHOOL',
        status: 'ACTIVE',
        email: dto.email?.trim().toLowerCase() || null,
        phone: rawPhone || null,
        address: dto.address?.trim() || null,
        city: dto.city?.trim() || null,
        state: dto.state?.trim() || null,
        country: dto.country?.trim() || 'India',
        stateId: dto.stateId || null,
        districtId: dto.districtId || null,
        createdById: actorUserId,
      },
      include: {
        stateRef: true,
        districtRef: true,
      },
    });

    // If phone is provided, create/link User account with INSTITUTION_ADMIN role for login
    if (rawPhone) {
      const tenDigit = rawPhone.replace(/^\+91/, '');
      let schoolUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { phone: rawPhone },
            { mobileNumber: rawPhone },
            { phone: tenDigit },
            { mobileNumber: tenDigit },
            ...(dto.email ? [{ email: dto.email.trim().toLowerCase() }] : []),
          ],
        },
      });

      if (!schoolUser) {
        const tempPassword = await bcrypt.hash(`brainros_${rawPhone.slice(-6)}`, 10);
        schoolUser = await this.prisma.user.create({
          data: {
            phone: rawPhone,
            mobileNumber: rawPhone,
            email: dto.email?.trim().toLowerCase() || null,
            name: `${dto.name.trim()} Admin`,
            passwordHash: tempPassword,
            status: 'ACTIVE',
            isActive: true,
            isVerified: true,
          },
        });
      } else {
        schoolUser = await this.prisma.user.update({
          where: { id: schoolUser.id },
          data: {
            status: 'ACTIVE',
            isActive: true,
            isVerified: true,
          },
        });
      }

      const instRole = await this.prisma.role.findFirst({
        where: { name: 'INSTITUTION_ADMIN' },
      });

      if (instRole && schoolUser) {
        await this.prisma.userRole.upsert({
          where: {
            userId_roleId: {
              userId: schoolUser.id,
              roleId: instRole.id,
            },
          },
          update: {},
          create: {
            userId: schoolUser.id,
            roleId: instRole.id,
          },
        });
      }

      if (schoolUser) {
        const existingAdmin = await this.prisma.institutionAdmin.findFirst({
          where: {
            institutionId: school.id,
            userId: schoolUser.id,
          },
        });

        if (!existingAdmin) {
          await this.prisma.institutionAdmin.create({
            data: {
              institutionId: school.id,
              userId: schoolUser.id,
              role: 'ADMIN',
              isActive: true,
            },
          });
        } else if (!existingAdmin.isActive) {
          await this.prisma.institutionAdmin.update({
            where: { id: existingAdmin.id },
            data: { isActive: true },
          });
        }
      }
    }

    this.logger.log(
      `School created: ${school.name} (${school.code}) by user ${actorUserId}`,
    );
    return school;
  }

  /**
   * List schools with server-side pagination, search, and filters
   */
  async getSchools(query: SchoolQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const skip = (page - 1) * limit;

    const where: any = {
      type: 'SCHOOL',
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.stateId) {
      const stateRecord = await this.prisma.state.findUnique({
        where: { id: query.stateId },
        select: { name: true },
      });
      if (stateRecord?.name) {
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { stateId: query.stateId },
              { state: { equals: stateRecord.name, mode: 'insensitive' } },
            ],
          },
        ];
      } else {
        where.stateId = query.stateId;
      }
    }

    if (query.districtId) {
      const districtRecord = await this.prisma.district.findUnique({
        where: { id: query.districtId },
        select: { name: true },
      });
      if (districtRecord?.name) {
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { districtId: query.districtId },
              { city: { equals: districtRecord.name, mode: 'insensitive' } },
            ],
          },
        ];
      } else {
        where.districtId = query.districtId;
      }
    }

    if (query.search?.trim()) {
      const s = query.search.trim();
      const searchCondition = {
        OR: [
          { name: { contains: s, mode: 'insensitive' } },
          { code: { contains: s, mode: 'insensitive' } },
          { city: { contains: s, mode: 'insensitive' } },
          { state: { contains: s, mode: 'insensitive' } },
          { email: { contains: s, mode: 'insensitive' } },
          { phone: { contains: s, mode: 'insensitive' } },
        ],
      };
      if (where.AND) {
        where.AND.push(searchCondition);
      } else {
        where.OR = searchCondition.OR;
      }
    }

    const [items, total] = await Promise.all([
      this.prisma.institution.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          stateRef: { select: { id: true, name: true, code: true } },
          districtRef: { select: { id: true, name: true, code: true } },
          _count: {
            select: {
              students: true,
              batches: true,
              admins: true,
            },
          },
        },
      }),
      this.prisma.institution.count({ where }),
    ]);

    return {
      data: items.map((school) => ({
        id: school.id,
        name: school.name,
        code: school.code,
        status: school.status,
        email: school.email,
        phone: school.phone,
        address: school.address,
        city: school.city,
        state: school.state,
        country: school.country,
        stateRef: school.stateRef,
        districtRef: school.districtRef,
        studentCount: school._count.students,
        batchCount: school._count.batches,
        adminCount: school._count.admins,
        createdAt: school.createdAt,
        updatedAt: school.updatedAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single school details by ID
   */
  async getSchoolById(id: string) {
    const school = await this.prisma.institution.findUnique({
      where: { id },
      include: {
        stateRef: true,
        districtRef: true,
        admins: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                mobileNumber: true,
              },
            },
          },
        },
        batches: {
          select: {
            id: true,
            name: true,
            academicYear: true,
            classLevel: true,
            status: true,
            _count: { select: { students: true } },
          },
        },
        _count: {
          select: {
            students: true,
          },
        },
      },
    });

    if (!school) {
      throw new NotFoundException(`School with ID '${id}' not found.`);
    }

    return school;
  }

  /**
   * Update school details
   */
  async updateSchool(id: string, dto: UpdateSchoolDto) {
    const existing = await this.prisma.institution.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`School with ID '${id}' not found.`);
    }

    if (dto.code && dto.code.trim().toUpperCase() !== existing.code) {
      const codeCheck = await this.prisma.institution.findUnique({
        where: { code: dto.code.trim().toUpperCase() },
      });
      if (codeCheck) {
        throw new BadRequestException(`School code '${dto.code}' already exists.`);
      }
    }

    return this.prisma.institution.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        code: dto.code ? dto.code.trim().toUpperCase() : undefined,
        email: dto.email !== undefined ? dto.email?.trim() || null : undefined,
        phone: dto.phone !== undefined ? dto.phone?.trim() || null : undefined,
        address: dto.address !== undefined ? dto.address?.trim() || null : undefined,
        city: dto.city !== undefined ? dto.city?.trim() || null : undefined,
        state: dto.state !== undefined ? dto.state?.trim() || null : undefined,
        country: dto.country !== undefined ? dto.country?.trim() || 'India' : undefined,
        stateId: dto.stateId !== undefined ? dto.stateId || null : undefined,
        districtId: dto.districtId !== undefined ? dto.districtId || null : undefined,
      },
      include: {
        stateRef: true,
        districtRef: true,
      },
    });
  }

  /**
   * Update school status (e.g. ACTIVE, SUSPENDED, ARCHIVED)
   */
  async updateSchoolStatus(id: string, dto: UpdateSchoolStatusDto) {
    const existing = await this.prisma.institution.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`School with ID '${id}' not found.`);
    }

    return this.prisma.institution.update({
      where: { id },
      data: {
        status: dto.status as any,
      },
    });
  }

  /**
   * Get filter master data (states, districts) for school filtering
   */
  async getFilterOptions() {
    const [states, districts] = await Promise.all([
      this.prisma.state.findMany({
        where: { isActive: true },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.district.findMany({
        where: { isActive: true },
        select: { id: true, name: true, stateId: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return { states, districts };
  }
}
