import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateStaffDto,
  UpdateStaffDto,
  UpdateStaffStatusDto,
  StaffFilterDto,
  VALID_STAFF_ROLES,
} from '../dto/staff.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminStaffService {
  private readonly logger = new Logger(AdminStaffService.name);

  constructor(private readonly prisma: PrismaService) {}

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
   * 1. Create a new Staff account with assigned staff role.
   */
  async createStaff(dto: CreateStaffDto, creatorId: string) {
    const rawMobile = (dto.mobileNumber || dto.phoneNumber || '').trim();
    if (!rawMobile) {
      throw new BadRequestException('Phone number / Mobile number is required.');
    }
    const normalizedMobile = this.normalizeMobile(rawMobile);
    const normalizedEmail = dto.email ? dto.email.trim().toLowerCase() : null;
    const tenDigit = rawMobile.replace(/[^0-9]/g, '').slice(-10);

    // Check for duplicate phone number across multiple representations (raw, normalized, 10-digit)
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

    if (existingMobile) {
      throw new ConflictException(
        `A user account with phone number '${rawMobile}' already exists. Phone number must be unique.`,
      );
    }

    // Check for duplicate email if provided
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

    // Resolve target staff role
    const role = await this.prisma.role.findUnique({
      where: { name: dto.role },
    });

    if (!role) {
      throw new BadRequestException(
        `Staff role '${dto.role}' is not configured in the database.`,
      );
    }

    const defaultPasswordHash = await bcrypt.hash('Staff@Brainros2026', 10);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Create User
        const user = await tx.user.create({
          data: {
            name: dto.name.trim(),
            mobileNumber: normalizedMobile,
            phone: normalizedMobile,
            email: normalizedEmail,
            passwordHash: defaultPasswordHash,
            status: 'ACTIVE',
            isActive: true,
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

      // 3. Audit Log
      await tx.auditLog.create({
        data: {
          actorUserId: creatorId,
          action: 'STAFF_CREATED',
          entityType: 'STAFF',
          entityId: user.id,
          afterState: {
            id: user.id,
            name: user.name,
            mobileNumber: user.mobileNumber,
            email: user.email,
            role: dto.role,
            status: user.status,
          },
          metadata: {
            role: dto.role,
            createdBy: creatorId,
            createdAt: new Date().toISOString(),
          },
        },
      });

      this.logger.log(
        `Staff user '${user.id}' (${dto.name}, ${dto.role}) created successfully by '${creatorId}'`,
      );

      return {
        id: user.id,
        name: user.name,
        mobileNumber: user.mobileNumber,
        email: user.email,
        role: dto.role,
        roles: [dto.role],
        status: user.status,
        institution: null,
        createdAt: user.createdAt,
      };
    });
  } catch (err: any) {
    if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : String(err.meta?.target || '');
      if (target.includes('mobile') || target.includes('phone')) {
        throw new ConflictException(`Phone number '${rawMobile}' already exists. Phone number must be unique.`);
      }
      if (target.includes('email')) {
        throw new ConflictException(`Email address '${normalizedEmail}' already exists. Email must be unique.`);
      }
      throw new ConflictException('A user with this unique credential already exists.');
    }
    throw err;
  }
}

  /**
   * 2. List all staff members with pagination, search, and filters.
   */
  async listStaff(filter: StaffFilterDto) {
    const page = filter.page ? Math.max(1, Number(filter.page)) : 1;
    const limit = filter.limit ? Math.min(100, Math.max(1, Number(filter.limit))) : 10;
    const skip = (page - 1) * limit;

    const where: any = filter.role
      ? {
          userRoles: {
            some: {
              role: {
                name: filter.role,
              },
            },
          },
        }
      : {
          userRoles: {
            some: {
              role: {
                name: {
                  notIn: ['STUDENT', 'PARENT'],
                },
              },
            },
          },
        };

    if (filter.status) {
      where.status = filter.status.toUpperCase();
    }

    if (filter.search && filter.search.trim()) {
      const q = filter.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { mobileNumber: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          userRoles: {
            include: { role: true },
          },
          institutionAdmins: {
            where: { isActive: true },
            include: { institution: { select: { id: true, name: true, code: true } } },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const items = users.map((u) => {
      const allRoles = u.userRoles.map((ur) => ur.role.name);
      const priorityOrder = [
        'SUPER_ADMIN',
        'ADMIN',
        'GENERAL_MANAGER',
        'MANAGER',
        'OPERATOR',
        'ACCOUNTANT',
      ];
      const primaryRole =
        priorityOrder.find((r) => allRoles.includes(r)) || allRoles[0] || 'STAFF';
      const institution = u.institutionAdmins[0]?.institution || null;

      return {
        id: u.id,
        name: u.name || 'Unnamed Staff',
        mobileNumber: u.mobileNumber || u.phone,
        email: u.email,
        role: primaryRole,
        roles: allRoles,
        status: u.status,
        isActive: u.isActive,
        institution,
        institutionName: institution?.name || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      };
    });

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 3. Get single staff member details.
   */
  async getStaffById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: { include: { role: true } },
        institutionAdmins: {
          where: { isActive: true },
          include: { institution: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`Staff user with ID '${id}' not found.`);
    }

    const staffRoleObj = user.userRoles.find((ur) =>
      VALID_STAFF_ROLES.includes(ur.role.name as any),
    );
    const roleName = staffRoleObj?.role.name || user.userRoles[0]?.role.name || 'STAFF';
    const institution = user.institutionAdmins[0]?.institution || null;

    return {
      id: user.id,
      name: user.name || 'Unnamed Staff',
      mobileNumber: user.mobileNumber || user.phone,
      email: user.email,
      role: roleName,
      status: user.status,
      isActive: user.isActive,
      institution,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * 4. Update staff details.
   */
  async updateStaff(id: string, dto: UpdateStaffDto, updaterId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException(`Staff user with ID '${id}' not found.`);
    }

    const beforeState = {
      name: user.name,
      email: user.email,
      roles: user.userRoles.map((ur) => ur.role.name),
    };

    const rawMobile = (dto.mobileNumber || dto.phoneNumber)?.trim();
    let normalizedMobile: string | undefined;
    if (rawMobile) {
      normalizedMobile = this.normalizeMobile(rawMobile);
      const tenDigit = rawMobile.replace(/[^0-9]/g, '').slice(-10);

      const duplicate = await this.prisma.user.findFirst({
        where: {
          id: { not: id },
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

      if (duplicate) {
        throw new ConflictException(
          `A user account with phone number '${rawMobile}' already exists. Phone number must be unique.`,
        );
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updateData: any = {};
        if (dto.name !== undefined) updateData.name = dto.name.trim();
        if (dto.email !== undefined) updateData.email = dto.email ? dto.email.trim().toLowerCase() : null;
        if (normalizedMobile) {
          updateData.mobileNumber = normalizedMobile;
          updateData.phone = normalizedMobile;
        }

        const updatedUser = await tx.user.update({
          where: { id },
          data: updateData,
        });

      if (dto.role) {
        const newRole = await tx.role.findUnique({ where: { name: dto.role } });
        if (newRole) {
          // Replace staff roles
          for (const ur of user.userRoles) {
            if (VALID_STAFF_ROLES.includes(ur.role.name as any)) {
              await tx.userRole.delete({
                where: { userId_roleId: { userId: id, roleId: ur.roleId } },
              });
            }
          }
          await tx.userRole.create({
            data: { userId: id, roleId: newRole.id },
          });
        }
      }

      if (dto.institutionId !== undefined) {
        await tx.institutionAdmin.deleteMany({ where: { userId: id } });
        if (dto.institutionId) {
          await tx.institutionAdmin.create({
            data: {
              institutionId: dto.institutionId,
              userId: id,
              role: dto.role || user.userRoles[0]?.role.name || 'STAFF',
              isActive: true,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          actorUserId: updaterId,
          action: 'STAFF_UPDATED',
          entityType: 'STAFF',
          entityId: id,
          beforeState,
          afterState: {
            name: updatedUser.name,
            email: updatedUser.email,
            role: dto.role,
            institutionId: dto.institutionId,
          },
          metadata: { updatedBy: updaterId },
        },
      });

        return this.getStaffById(id);
      });
    } catch (err: any) {
      if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : String(err.meta?.target || '');
        if (target.includes('mobile') || target.includes('phone')) {
          throw new ConflictException(`Phone number '${rawMobile}' already exists. Phone number must be unique.`);
        }
        if (target.includes('email')) {
          throw new ConflictException(`Email address '${dto.email}' already exists. Email must be unique.`);
        }
        throw new ConflictException('A user with this unique credential already exists.');
      }
      throw err;
    }
  }

  /**
   * 5. Activate or deactivate staff member.
   */
  async updateStaffStatus(id: string, dto: UpdateStaffStatusDto, updaterId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException(`Staff user with ID '${id}' not found.`);
    }

    let userStatus: any = dto.status;
    if (userStatus === 'INACTIVE') {
      userStatus = 'DISABLED';
    }
    const isActive = userStatus === 'ACTIVE';

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: userStatus,
        isActive,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: updaterId,
        action: 'STAFF_STATUS_CHANGED',
        entityType: 'STAFF',
        entityId: id,
        beforeState: { status: user.status, isActive: user.isActive },
        afterState: { status: updated.status, isActive: updated.isActive },
        metadata: { updatedBy: updaterId },
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      isActive: updated.isActive,
      message: `Staff account status changed to ${dto.status}.`,
    };
  }
}
