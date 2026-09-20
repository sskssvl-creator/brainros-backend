import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminStudentsQueryDto,
  SuperAdminRegistrationsQueryDto,
  AddStudentParentDto,
  SortOrderEnum,
} from '../dto/admin-students.dto';
import { Prisma, StudentStatus, ParentLinkStatus, ParentRelationshipType } from '@prisma/client';
import { CANONICAL_TARGET_EXAMS } from '../../../common/constants/target-exam.constant';

@Injectable()
export class AdminStudentsService {
  private readonly logger = new Logger(AdminStudentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Safe server-side paginated, filtered, sorted student directory query
   */
  async getStudents(query: AdminStudentsQueryDto, actorUserId: string) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.limit) || 10));
    const skip = (page - 1) * pageSize;

    // 1. RBAC & Institution Scope Evaluation
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      include: {
        userRoles: { include: { role: true } },
        institutionAdmins: { where: { isActive: true } },
      },
    });

    const isSuperAdmin = user?.userRoles?.some(
      (ur) => ur.role.name === 'SUPER_ADMIN',
    );

    // If regular Admin has assigned institutions, scope to their institutions
    const assignedInstitutionIds =
      user?.institutionAdmins?.map((ia) => ia.institutionId) || [];

    const where: Prisma.StudentWhereInput = {};

    // Apply institution scope if regular admin is bound to specific institutions
    if (!isSuperAdmin && assignedInstitutionIds.length > 0) {
      const scopeInstitutions = await this.prisma.institution.findMany({
        where: { id: { in: assignedInstitutionIds } },
        select: { id: true, name: true },
      });
      const scopeNames = scopeInstitutions.map((i) => i.name).filter(Boolean);

      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { institutionId: { in: assignedInstitutionIds } },
            {
              batchMemberships: {
                some: {
                  batch: {
                    institutionId: { in: assignedInstitutionIds },
                  },
                },
              },
            },
            ...(scopeNames.length > 0
              ? [{ schoolCollege: { in: scopeNames, mode: 'insensitive' as Prisma.QueryMode } }]
              : []),
          ],
        },
      ];
    }

    // 2. Build Filter Criteria
    if (query.status) {
      where.status = query.status as StudentStatus;
    }

    if (query.classId) {
      where.classId = query.classId;
    }

    if (query.examTargetId) {
      where.examTargetId = query.examTargetId;
    }

    if (query.stateId) {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        query.stateId,
      );
      if (isUuid) {
        where.stateId = query.stateId;
      } else {
        where.OR = [
          ...(where.OR || []),
          { state: { contains: query.stateId, mode: 'insensitive' } },
          { stateRef: { name: { contains: query.stateId, mode: 'insensitive' } } },
        ];
      }
    }

    if (query.districtId) {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        query.districtId,
      );
      if (isUuid) {
        where.districtId = query.districtId;
      } else {
        where.OR = [
          ...(where.OR || []),
          { district: { contains: query.districtId, mode: 'insensitive' } },
          { districtRef: { name: { contains: query.districtId, mode: 'insensitive' } } },
        ];
      }
    }

    if (query.institutionId && query.institutionId.toUpperCase() !== 'ALL') {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        query.institutionId,
      );

      let institutionName: string | null = null;
      if (isUuid) {
        const instRecord = await this.prisma.institution.findUnique({
          where: { id: query.institutionId },
          select: { name: true },
        });
        if (instRecord) {
          institutionName = instRecord.name;
        }
      } else {
        institutionName = query.institutionId;
      }

      const instConditions: Prisma.StudentWhereInput[] = [];

      if (isUuid) {
        instConditions.push({ institutionId: query.institutionId });
        instConditions.push({
          batchMemberships: {
            some: {
              batch: {
                institutionId: query.institutionId,
              },
            },
          },
        });
      }

      if (institutionName) {
        instConditions.push({
          schoolCollege: { contains: institutionName, mode: 'insensitive' as Prisma.QueryMode },
        });
        instConditions.push({
          batchMemberships: {
            some: {
              batch: {
                institution: {
                  name: { contains: institutionName, mode: 'insensitive' as Prisma.QueryMode },
                },
              },
            },
          },
        });
      }

      if (instConditions.length > 0) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { OR: instConditions },
        ];
      }
    }

    if (query.createdFrom || query.createdTo) {
      where.createdAt = {};
      if (query.createdFrom) {
        where.createdAt.gte = new Date(query.createdFrom);
      }
      if (query.createdTo) {
        const toDate = new Date(query.createdTo);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    // 3. Server-side Search
    if (query.search && query.search.trim().length > 0) {
      const searchTerm = query.search.trim();
      where.OR = [
        { name: { contains: searchTerm, mode: 'insensitive' } },
        { studentId: { contains: searchTerm, mode: 'insensitive' } },
        { studentCode: { contains: searchTerm, mode: 'insensitive' } },
        { schoolCollege: { contains: searchTerm, mode: 'insensitive' } },
        {
          user: {
            OR: [
              { email: { contains: searchTerm, mode: 'insensitive' } },
              { mobileNumber: { contains: searchTerm, mode: 'insensitive' } },
              { phone: { contains: searchTerm, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    // 4. Safe Whitelisted Sorting
    const sortOrder = query.sortOrder === SortOrderEnum.ASC ? 'asc' : 'desc';
    let orderBy: Prisma.StudentOrderByWithRelationInput = {
      createdAt: 'desc',
    };

    switch (query.sortBy) {
      case 'name':
        orderBy = { name: sortOrder };
        break;
      case 'studentId':
        orderBy = { studentId: sortOrder };
        break;
      case 'status':
        orderBy = { status: sortOrder };
        break;
      case 'schoolCollege':
        orderBy = { schoolCollege: sortOrder };
        break;
      case 'email':
        orderBy = { user: { email: sortOrder } };
        break;
      case 'createdAt':
      default:
        orderBy = { createdAt: sortOrder };
        break;
    }

    // 5. Execute Efficient Parallel Queries (Zero N+1)
    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        select: {
          id: true,
          studentId: true,
          studentCode: true,
          name: true,
          state: true,
          district: true,
          schoolCollege: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              mobileNumber: true,
              phone: true,
              status: true,
              isActive: true,
            },
          },
          studentClass: {
            select: {
              id: true,
              name: true,
            },
          },
          examTarget: {
            select: {
              id: true,
              name: true,
            },
          },
          stateRef: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          districtRef: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          batchMemberships: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              batch: {
                select: {
                  id: true,
                  name: true,
                  institution: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                    },
                  },
                },
              },
            },
          },
          parentLinks: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              parentId: true,
              relationshipType: true,
            },
          },
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    // 6. Format Clean Response DTOs
    const items = students.map((s) => {
      const institutions = s.batchMemberships
        .map((bm) => ({
          id: bm.batch.institution.id,
          name: bm.batch.institution.name,
          code: bm.batch.institution.code,
          batchName: bm.batch.name,
        }))
        .filter(
          (inst, idx, self) =>
            idx === self.findIndex((t) => t.id === inst.id),
        );

      return {
        id: s.id,
        studentId: s.studentId,
        studentCode: s.studentCode || s.studentId,
        name: s.name,
        email: s.user?.email || '—',
        mobile: s.user?.mobileNumber || s.user?.phone || '—',
        schoolCollege: s.schoolCollege || '—',
        state: s.stateRef ? { id: s.stateRef.id, name: s.stateRef.name, code: s.stateRef.code } : { name: s.state },
        district: s.districtRef ? { id: s.districtRef.id, name: s.districtRef.name, code: s.districtRef.code } : { name: s.district },
        class: s.studentClass ? { id: s.studentClass.id, name: s.studentClass.name } : null,
        examTarget: s.examTarget ? { id: s.examTarget.id, name: s.examTarget.name } : null,
        institutions,
        status: s.status,
        createdAt: s.createdAt,
        parentsCount: s.parentLinks.length,
        hasParent: s.parentLinks.length > 0,
      };
    });

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  /**
   * Helper: Calculate Today's start and end UTC timestamps according to Asia/Kolkata timezone
   */
  private getTodayBounds(timeZone = 'Asia/Kolkata'): { start: Date; end: Date } {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.format(now); // "YYYY-MM-DD"
    const [year, month, day] = parts.split('-').map(Number);
    const localMidnightUtcMs =
      Date.UTC(year, month - 1, day, 0, 0, 0) - (5 * 60 + 30) * 60 * 1000;
    const start = new Date(localMidnightUtcMs);
    const end = new Date(localMidnightUtcMs + 24 * 60 * 60 * 1000 - 1);
    return { start, end };
  }

  /**
   * Build WHERE clause for Super Admin Registration queries with combined filters
   */
  private buildSuperAdminRegistrationWhere(query: SuperAdminRegistrationsQueryDto): Prisma.StudentWhereInput {
    const where: Prisma.StudentWhereInput = {};

    // 1. Date Filter (e.g. 'today' or specific date string)
    if (query.date) {
      const lower = query.date.toLowerCase().trim();
      if (lower === 'today') {
        const { start, end } = this.getTodayBounds();
        where.createdAt = { gte: start, lte: end };
      } else if (lower !== 'all') {
        const specificDate = new Date(query.date);
        if (!isNaN(specificDate.getTime())) {
          const startDate = new Date(specificDate.getFullYear(), specificDate.getMonth(), specificDate.getDate(), 0, 0, 0);
          const endDate = new Date(specificDate.getFullYear(), specificDate.getMonth(), specificDate.getDate(), 23, 59, 59, 999);
          where.createdAt = { gte: startDate, lte: endDate };
        }
      }
    }

    // 2. Exam Target Filter ('ALL' | 'NEET' | 'JEE' | 'CET' | targetId)
    if (query.examTarget && query.examTarget.toUpperCase() !== 'ALL') {
      const targetVal = query.examTarget.trim();
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(targetVal);
      if (isUuid) {
        where.examTargetId = targetVal;
      } else {
        where.examTarget = {
          name: { contains: targetVal, mode: 'insensitive' as Prisma.QueryMode },
        };
      }
    } else if (query.examTargetId && query.examTargetId.toUpperCase() !== 'ALL') {
      where.examTargetId = query.examTargetId;
    }

    // 3. State Filter
    if (query.stateId && query.stateId.toUpperCase() !== 'ALL') {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(query.stateId);
      if (isUuid) {
        where.stateId = query.stateId;
      } else {
        where.OR = [
          ...(where.OR || []),
          { state: { contains: query.stateId, mode: 'insensitive' as Prisma.QueryMode } },
          { stateRef: { name: { contains: query.stateId, mode: 'insensitive' as Prisma.QueryMode } } },
        ];
      }
    }

    // 4. District Filter
    if (query.districtId && query.districtId.toUpperCase() !== 'ALL') {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(query.districtId);
      if (isUuid) {
        where.districtId = query.districtId;
      } else {
        where.OR = [
          ...(where.OR || []),
          { district: { contains: query.districtId, mode: 'insensitive' as Prisma.QueryMode } },
          { districtRef: { name: { contains: query.districtId, mode: 'insensitive' as Prisma.QueryMode } } },
        ];
      }
    }

    // 5. Institution / School Filter
    if (query.institutionId && query.institutionId.toUpperCase() !== 'ALL') {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(query.institutionId);
      if (isUuid) {
        where.OR = [
          ...(where.OR || []),
          { institutionId: query.institutionId },
          {
            batchMemberships: {
              some: {
                batch: {
                  institutionId: query.institutionId,
                },
              },
            },
          },
        ];
      } else {
        where.OR = [
          ...(where.OR || []),
          { schoolCollege: { contains: query.institutionId, mode: 'insensitive' as Prisma.QueryMode } },
          {
            batchMemberships: {
              some: {
                batch: {
                  institution: {
                    name: { contains: query.institutionId, mode: 'insensitive' as Prisma.QueryMode },
                  },
                },
              },
            },
          },
        ];
      }
    }

    // 6. Status Filter
    if (query.status && query.status.toUpperCase() !== 'ALL') {
      where.status = query.status as StudentStatus;
    }

    // 7. Search Filter (Debounced from client)
    if (query.search && query.search.trim().length > 0) {
      const searchTerm = query.search.trim();
      const searchOr: Prisma.StudentWhereInput[] = [
        { name: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        { studentId: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        { studentCode: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        { schoolCollege: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        { state: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        { district: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
        {
          user: {
            OR: [
              { email: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
              { mobileNumber: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
              { phone: { contains: searchTerm, mode: 'insensitive' as Prisma.QueryMode } },
            ],
          },
        },
      ];

      if (where.OR) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { OR: searchOr },
        ];
      } else {
        where.OR = searchOr;
      }
    }

    return where;
  }

  /**
   * Super Admin: Get server-side paginated, sorted, filtered registration listing
   */
  async getSuperAdminRegistrations(query: SuperAdminRegistrationsQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10));
    const skip = (page - 1) * pageSize;

    const where = this.buildSuperAdminRegistrationWhere(query);

    // Whitelisted sorting
    const sortOrder = query.sortOrder === SortOrderEnum.ASC ? 'asc' : 'desc';
    let orderBy: Prisma.StudentOrderByWithRelationInput = { createdAt: 'desc' };

    switch (query.sortBy) {
      case 'name':
        orderBy = { name: sortOrder };
        break;
      case 'studentId':
        orderBy = { studentId: sortOrder };
        break;
      case 'status':
        orderBy = { status: sortOrder };
        break;
      case 'schoolCollege':
      case 'institution':
        orderBy = { schoolCollege: sortOrder };
        break;
      case 'email':
        orderBy = { user: { email: sortOrder } };
        break;
      case 'examTarget':
        orderBy = { examTarget: { name: sortOrder } };
        break;
      case 'state':
        orderBy = { state: sortOrder };
        break;
      case 'district':
        orderBy = { district: sortOrder };
        break;
      case 'createdAt':
      default:
        orderBy = { createdAt: sortOrder };
        break;
    }

    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        select: {
          id: true,
          studentId: true,
          studentCode: true,
          name: true,
          state: true,
          district: true,
          schoolCollege: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              mobileNumber: true,
              phone: true,
              status: true,
              isActive: true,
            },
          },
          examTarget: {
            select: {
              id: true,
              name: true,
            },
          },
          stateRef: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          districtRef: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          batchMemberships: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              batch: {
                select: {
                  id: true,
                  name: true,
                  institution: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    const items = students.map((s) => {
      const institutions = s.batchMemberships
        .map((bm) => ({
          id: bm.batch.institution.id,
          name: bm.batch.institution.name,
          code: bm.batch.institution.code,
          batchName: bm.batch.name,
        }))
        .filter(
          (inst, idx, self) =>
            idx === self.findIndex((t) => t.id === inst.id),
        );

      const instituteName =
        institutions.length > 0
          ? institutions.map((i) => i.name).join(', ')
          : s.schoolCollege || '—';

      return {
        id: s.id,
        studentId: s.studentId,
        studentCode: s.studentCode || s.studentId,
        name: s.name,
        email: s.user?.email || '—',
        mobile: s.user?.mobileNumber || s.user?.phone || '—',
        state: s.stateRef?.name || s.state || '—',
        stateId: s.stateRef?.id || undefined,
        district: s.districtRef?.name || s.district || '—',
        districtId: s.districtRef?.id || undefined,
        schoolCollege: s.schoolCollege || '—',
        instituteName,
        institutions,
        examTarget: s.examTarget ? { id: s.examTarget.id, name: s.examTarget.name } : null,
        status: s.status,
        createdAt: s.createdAt,
      };
    });

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  /**
   * Super Admin: Registration real-time statistics
   */
  async getSuperAdminRegistrationStats(query: SuperAdminRegistrationsQueryDto = {}) {
    const todayBounds = this.getTodayBounds();

    const [
      totalRegistrations,
      todayRegistrations,
      activeRegistrations,
      pendingRegistrations,
      examTargetsList,
    ] = await Promise.all([
      this.prisma.student.count(),
      this.prisma.student.count({
        where: {
          createdAt: {
            gte: todayBounds.start,
            lte: todayBounds.end,
          },
        },
      }),
      this.prisma.student.count({
        where: { status: 'ACTIVE' },
      }),
      this.prisma.student.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.examTarget.findMany({
        select: {
          id: true,
          name: true,
          _count: {
            select: { students: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const examTargetMap: Record<string, number> = {};
    const examTargets = examTargetsList.map((t) => {
      examTargetMap[t.name.toUpperCase()] = t._count.students;
      return {
        id: t.id,
        name: t.name,
        count: t._count.students,
      };
    });

    return {
      totalRegistrations,
      todayRegistrations,
      neetRegistrations: examTargetMap['NEET'] || 0,
      jeeRegistrations:
        (examTargetMap['JEE'] || 0) + (examTargetMap['JEE MAIN'] || 0) + (examTargetMap['JEE ADVANCED'] || 0),
      cetRegistrations:
        (examTargetMap['CET'] || 0) + (examTargetMap['MHT CET'] || 0) + (examTargetMap['GUJCET'] || 0),
      activeRegistrations,
      pendingRegistrations,
      examTargets,
    };
  }

  /**
   * Super Admin: Dynamic filter options (states, districts cascading by stateId, institutions, exam targets)
   */
  async getSuperAdminFilterOptions(stateId?: string) {
    const districtWhere: Prisma.DistrictWhereInput = { isActive: true };
    if (stateId && stateId.toUpperCase() !== 'ALL') {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(stateId);
      if (isUuid) {
        districtWhere.stateId = stateId;
      } else {
        districtWhere.state = { name: { contains: stateId, mode: 'insensitive' as Prisma.QueryMode } };
      }
    }

    const [states, districts, examTargets, institutions, distinctSchools] =
      await Promise.all([
        this.prisma.state.findMany({
          where: { isActive: true },
          select: { id: true, name: true, code: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.district.findMany({
          where: districtWhere,
          select: { id: true, name: true, code: true, stateId: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.examTarget.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.institution.findMany({
          where: { status: { in: ['ACTIVE', 'APPROVED'] } },
          select: { id: true, name: true, code: true, state: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.student.findMany({
          where: { schoolCollege: { not: '' } },
          select: { schoolCollege: true, state: true },
          distinct: ['schoolCollege'],
          take: 100,
        }),
      ]);

    const institutionList = institutions.map((i) => ({
      id: i.id,
      name: i.name,
      code: i.code,
      state: i.state || '',
      type: 'INSTITUTION',
    }));

    const standaloneSchools = distinctSchools
      .filter(
        (s) =>
          s.schoolCollege &&
          !institutions.some((i) => i.name.toLowerCase() === s.schoolCollege.toLowerCase()),
      )
      .map((s) => ({
        id: s.schoolCollege,
        name: s.schoolCollege,
        code: 'SCHOOL',
        state: s.state || '',
        type: 'SCHOOL',
      }));

    const TARGET_ORDER = CANONICAL_TARGET_EXAMS;
    const filteredExamTargets = examTargets
      .filter((t) => TARGET_ORDER.some((name) => name.toLowerCase() === t.name?.trim().toLowerCase()))
      .sort((a, b) => {
        const indexA = TARGET_ORDER.findIndex((name) => name.toLowerCase() === a.name?.trim().toLowerCase());
        const indexB = TARGET_ORDER.findIndex((name) => name.toLowerCase() === b.name?.trim().toLowerCase());
        return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
      });

    return {
      states,
      districts,
      examTargets: filteredExamTargets,
      institutions: [...institutionList, ...standaloneSchools],
      statuses: [
        { label: 'All Statuses', value: 'ALL' },
        { label: 'Active', value: 'ACTIVE' },
        { label: 'Pending', value: 'PENDING' },
        { label: 'Suspended', value: 'SUSPENDED' },
        { label: 'Inactive', value: 'INACTIVE' },
      ],
    };
  }

  /**
   * Fetch dynamic master data filter options for /admin/students
   */
  async getFilterOptions() {
    const [states, districts, classes, examTargets, institutions] =
      await Promise.all([
        this.prisma.state.findMany({
          where: { isActive: true },
          select: { id: true, name: true, code: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.district.findMany({
          where: { isActive: true },
          select: { id: true, name: true, code: true, stateId: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.studentClass.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.examTarget.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.institution.findMany({
          where: { status: { in: ['ACTIVE', 'APPROVED'] } },
          select: { id: true, name: true, code: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    const TARGET_ORDER = CANONICAL_TARGET_EXAMS;
    const filteredExamTargets = examTargets
      .filter((t) => TARGET_ORDER.some((name) => name.toLowerCase() === t.name?.trim().toLowerCase()))
      .sort((a, b) => {
        const indexA = TARGET_ORDER.findIndex((name) => name.toLowerCase() === a.name?.trim().toLowerCase());
        const indexB = TARGET_ORDER.findIndex((name) => name.toLowerCase() === b.name?.trim().toLowerCase());
        return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
      });

    return {
      states,
      districts,
      classes,
      examTargets: filteredExamTargets,
      institutions,
      statuses: [
        { label: 'Active', value: 'ACTIVE' },
        { label: 'Pending', value: 'PENDING' },
        { label: 'Suspended', value: 'SUSPENDED' },
        { label: 'Inactive', value: 'INACTIVE' },
        { label: 'Archived', value: 'ARCHIVED' },
      ],
    };
  }

  /**
   * Get all linked parents for a specific student
   */
  async getStudentParents(studentId: string) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
      },
      select: {
        id: true,
        studentId: true,
        studentCode: true,
        name: true,
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID '${studentId}' was not found.`);
    }

    const parentLinks = await this.prisma.parentStudentLink.findMany({
      where: { studentId: student.id },
      include: {
        parent: {
          select: {
            id: true,
            email: true,
            mobileNumber: true,
            phone: true,
            isActive: true,
            status: true,
          },
        },
      },
      orderBy: { linkedAt: 'desc' },
    });

    return {
      student: {
        id: student.id,
        studentId: student.studentId,
        studentCode: student.studentCode || student.studentId,
        name: student.name,
      },
      parents: parentLinks.map((link) => ({
        id: link.id,
        parentId: link.parentId,
        name: link.parent.email?.split('@')[0] || 'Parent',
        mobile: link.parent.mobileNumber || link.parent.phone || '—',
        email: link.parent.email || '—',
        relationship: link.relationshipType,
        status: link.status,
        linkedAt: link.linkedAt,
        revokedAt: link.revokedAt,
      })),
    };
  }

  /**
   * Add / Link a parent to a student (creates or reuses Parent User)
   */
  async addParentToStudent(
    studentId: string,
    dto: AddStudentParentDto,
    actorUserId: string,
  ) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
      },
      select: {
        id: true,
        studentId: true,
        name: true,
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID '${studentId}' was not found.`);
    }

    const cleanMobile = dto.mobile.replace(/\D/g, '').slice(-10);
    const cleanEmail = dto.email.trim().toLowerCase();

    if (cleanMobile.length < 10) {
      throw new BadRequestException('Mobile number must contain at least 10 digits.');
    }

    // 1. Check if Parent role exists
    let parentRole = await this.prisma.role.findUnique({
      where: { name: 'PARENT' },
    });

    if (!parentRole) {
      parentRole = await this.prisma.role.create({
        data: {
          name: 'PARENT',
          description: 'Parent guardian role for student academic monitoring',
          isActive: true,
        },
      });
    }

    // 2. Check if a User already exists with this mobile or email
    let parentUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { mobileNumber: cleanMobile },
          { phone: cleanMobile },
          { email: cleanEmail },
        ],
      },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (parentUser) {
      // Check if user is a student without parent capability
      const hasParentRole = parentUser.userRoles.some(
        (ur) => ur.role.name === 'PARENT',
      );
      if (!hasParentRole) {
        // Assign PARENT role
        await this.prisma.userRole.create({
          data: {
            userId: parentUser.id,
            roleId: parentRole.id,
          },
        });
      }
    } else {
      // Create new Parent User
      parentUser = await this.prisma.user.create({
        data: {
          mobileNumber: cleanMobile,
          phone: cleanMobile,
          email: cleanEmail,
          status: 'ACTIVE',
          isActive: true,
          isVerified: true,
          mobileVerifiedAt: new Date(),
          userRoles: {
            create: {
              roleId: parentRole.id,
            },
          },
        },
        include: {
          userRoles: { include: { role: true } },
        },
      });
    }

    // 3. Check / Upsert ParentStudentLink
    const existingLink = await this.prisma.parentStudentLink.findUnique({
      where: {
        parentId_studentId: {
          parentId: parentUser.id,
          studentId: student.id,
        },
      },
    });

    let linkResult;
    if (existingLink) {
      if (existingLink.status === ParentLinkStatus.ACTIVE) {
        throw new BadRequestException(
          'This parent is already actively linked to this student.',
        );
      }
      linkResult = await this.prisma.parentStudentLink.update({
        where: { id: existingLink.id },
        data: {
          status: ParentLinkStatus.ACTIVE,
          relationshipType: dto.relationship as ParentRelationshipType,
          linkedAt: new Date(),
          revokedAt: null,
        },
      });
    } else {
      linkResult = await this.prisma.parentStudentLink.create({
        data: {
          parentId: parentUser.id,
          studentId: student.id,
          relationshipType: dto.relationship as ParentRelationshipType,
          status: ParentLinkStatus.ACTIVE,
          linkedAt: new Date(),
        },
      });
    }

    // 4. Audit Log
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: 'PARENT_LINK_CREATED',
          entityType: 'PARENT_STUDENT_LINK',
          entityId: linkResult.id,
          afterState: {
            parentId: parentUser.id,
            studentId: student.id,
            relationship: dto.relationship,
            parentName: dto.name,
            parentMobile: cleanMobile,
            parentEmail: cleanEmail,
          },
          reason: `Admin linked parent ${dto.name} (${dto.relationship}) to student ${student.name} (${student.studentId})`,
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to write audit log for parent link creation: ${e}`);
    }

    return {
      message: 'Parent linked successfully.',
      data: {
        id: linkResult.id,
        parentId: parentUser.id,
        name: dto.name,
        mobile: cleanMobile,
        email: cleanEmail,
        relationship: linkResult.relationshipType,
        status: linkResult.status,
        linkedAt: linkResult.linkedAt,
      },
    };
  }

  /**
   * Revoke/Unlink parent relationship
   */
  async revokeParentLink(
    studentId: string,
    linkId: string,
    actorUserId: string,
  ) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID '${studentId}' was not found.`);
    }

    const link = await this.prisma.parentStudentLink.findFirst({
      where: {
        id: linkId,
        studentId: student.id,
      },
      include: { parent: true },
    });

    if (!link) {
      throw new NotFoundException('Parent relationship link not found for this student.');
    }

    const updated = await this.prisma.parentStudentLink.update({
      where: { id: link.id },
      data: {
        status: ParentLinkStatus.REVOKED,
        revokedAt: new Date(),
      },
    });

    // Audit Log
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: 'PARENT_LINK_REVOKED',
          entityType: 'PARENT_STUDENT_LINK',
          entityId: link.id,
          beforeState: { status: link.status },
          afterState: { status: updated.status, revokedAt: updated.revokedAt },
          reason: `Admin revoked parent link between parent ${link.parentId} and student ${student.name} (${student.studentId})`,
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to write audit log for parent link revocation: ${e}`);
    }

    return {
      message: 'Parent link revoked successfully.',
    };
  }

  /**
   * Update student details (Name, Email, Mobile, School, Class, Target, Location, Status)
   */
  async updateStudent(studentId: string, dto: any, actorUserId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID '${studentId}' not found.`);
    }

    const studentData: Prisma.StudentUpdateInput = {};
    if (dto.name !== undefined) studentData.name = dto.name.trim();
    if (dto.schoolCollege !== undefined) studentData.schoolCollege = dto.schoolCollege.trim();
    if (dto.status !== undefined) studentData.status = dto.status as StudentStatus;

    if (dto.classId) {
      studentData.studentClass = { connect: { id: dto.classId } };
    }
    if (dto.examTargetId) {
      studentData.examTarget = { connect: { id: dto.examTargetId } };
    }
    if (dto.stateId !== undefined) {
      studentData.stateRef = dto.stateId ? { connect: { id: dto.stateId } } : { disconnect: true };
    }
    if (dto.districtId !== undefined) {
      studentData.districtRef = dto.districtId ? { connect: { id: dto.districtId } } : { disconnect: true };
    }

    if (dto.state !== undefined) studentData.state = dto.state;
    if (dto.district !== undefined) studentData.district = dto.district;

    await this.prisma.student.update({
      where: { id: studentId },
      data: studentData,
    });

    // Update associated User account email & mobile number if changed
    if (student.userId) {
      const userData: Prisma.UserUpdateInput = {};
      if (dto.email !== undefined && dto.email.trim().toLowerCase() !== (student.user?.email || '')) {
        const newEmail = dto.email.trim().toLowerCase();
        if (newEmail) {
          const existing = await this.prisma.user.findUnique({ where: { email: newEmail } });
          if (existing && existing.id !== student.userId) {
            throw new BadRequestException('Email is already registered by another user.');
          }
          userData.email = newEmail;
        }
      }

      if (dto.mobile !== undefined && dto.mobile.trim() !== (student.user?.mobileNumber || '')) {
        const newMobile = dto.mobile.trim();
        if (newMobile) {
          const existing = await this.prisma.user.findFirst({
            where: { OR: [{ mobileNumber: newMobile }, { phone: newMobile }] },
          });
          if (existing && existing.id !== student.userId) {
            throw new BadRequestException('Mobile number is already registered by another user.');
          }
          userData.mobileNumber = newMobile;
          userData.phone = newMobile;
        }
      }

      if (Object.keys(userData).length > 0) {
        await this.prisma.user.update({
          where: { id: student.userId },
          data: userData,
        });
      }
    }

    // Audit Log
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: 'STUDENT_PROFILE_UPDATED',
          entityType: 'STUDENT',
          entityId: studentId,
          reason: `Admin updated profile for student ${student.name} (${student.studentId})`,
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to write audit log for student update: ${e}`);
    }

    return this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        user: { select: { id: true, email: true, mobileNumber: true, status: true, isActive: true } },
        studentClass: true,
        examTarget: true,
        stateRef: true,
        districtRef: true,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC REGISTRATIONS MODULE (Strictly Scoped to registrationSource = PUBLIC)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get paginated list of public registration students with search, filters & sorting
   */
  async getPublicRegistrations(query: SuperAdminRegistrationsQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 10));
    const skip = (page - 1) * pageSize;

    const where: Prisma.StudentWhereInput = {
      registrationSource: 'PUBLIC',
    };

    if (query.status && query.status !== 'ALL') {
      where.status = query.status as StudentStatus;
    }

    if (query.classId) where.classId = query.classId;
    if (query.examTargetId) where.examTargetId = query.examTargetId;
    if (query.stateId) where.stateId = query.stateId;
    if (query.districtId) where.districtId = query.districtId;
    if (query.institutionId) where.institutionId = query.institutionId;

    if (query.examTarget && query.examTarget !== 'ALL') {
      where.examTarget = {
        name: { equals: query.examTarget, mode: 'insensitive' },
      };
    }

    if (query.date === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      where.createdAt = { gte: today };
    } else if (query.date && query.date !== 'all') {
      const parsedDate = new Date(query.date);
      if (!isNaN(parsedDate.getTime())) {
        const start = new Date(parsedDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(parsedDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt = { gte: start, lte: end };
      }
    }

    if (query.search && query.search.trim()) {
      const q = query.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { studentId: { contains: q, mode: 'insensitive' } },
        { studentCode: { contains: q, mode: 'insensitive' } },
        { user: { mobileNumber: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { schoolCollege: { contains: q, mode: 'insensitive' } },
      ];
    }

    const sortOrder = query.sortOrder === SortOrderEnum.ASC ? 'asc' : 'desc';
    let orderBy: Prisma.StudentOrderByWithRelationInput = { createdAt: 'desc' };

    switch (query.sortBy) {
      case 'name':
        orderBy = { name: sortOrder };
        break;
      case 'studentId':
        orderBy = { studentId: sortOrder };
        break;
      case 'status':
        orderBy = { status: sortOrder };
        break;
      case 'schoolCollege':
        orderBy = { schoolCollege: sortOrder };
        break;
      case 'email':
        orderBy = { user: { email: sortOrder } };
        break;
      case 'createdAt':
      default:
        orderBy = { createdAt: sortOrder };
        break;
    }

    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        select: {
          id: true,
          studentId: true,
          studentCode: true,
          name: true,
          state: true,
          district: true,
          schoolCollege: true,
          status: true,
          registrationSource: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              mobileNumber: true,
              phone: true,
              status: true,
              isActive: true,
            },
          },
          studentClass: {
            select: { id: true, name: true },
          },
          examTarget: {
            select: { id: true, name: true },
          },
          stateRef: {
            select: { id: true, name: true, code: true },
          },
          districtRef: {
            select: { id: true, name: true, code: true },
          },
          institution: {
            select: { id: true, name: true, code: true },
          },
          _count: {
            select: { attempts: true, paymentTransactions: true, orders: true },
          },
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    const items = students.map((s) => ({
      id: s.id,
      studentId: s.studentId,
      studentCode: s.studentCode || s.studentId,
      name: s.name,
      email: s.user?.email || '—',
      mobile: s.user?.mobileNumber || s.user?.phone || '—',
      schoolCollege: s.institution?.name || s.schoolCollege || '—',
      state: s.stateRef ? { id: s.stateRef.id, name: s.stateRef.name, code: s.stateRef.code } : { name: s.state },
      district: s.districtRef ? { id: s.districtRef.id, name: s.districtRef.name, code: s.districtRef.code } : { name: s.district },
      class: s.studentClass ? { id: s.studentClass.id, name: s.studentClass.name } : null,
      examTarget: s.examTarget ? { id: s.examTarget.id, name: s.examTarget.name } : null,
      status: s.status,
      accountStatus: s.user?.isActive ? 'ACTIVE' : 'INACTIVE',
      registrationSource: s.registrationSource,
      createdAt: s.createdAt,
      totalAttempts: s._count.attempts,
      totalPayments: s._count.paymentTransactions,
      totalOrders: s._count.orders,
    }));

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
        hasNextPage: page * pageSize < total,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Get metrics & KPI stats for public registrations
   */
  async getPublicRegistrationStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalPublic,
      activePublic,
      inactivePublic,
      todayPublic,
      neetCount,
      jeeCount,
      cetCount,
    ] = await Promise.all([
      this.prisma.student.count({ where: { registrationSource: 'PUBLIC' } }),
      this.prisma.student.count({ where: { registrationSource: 'PUBLIC', status: 'ACTIVE' } }),
      this.prisma.student.count({ where: { registrationSource: 'PUBLIC', status: 'INACTIVE' } }),
      this.prisma.student.count({
        where: { registrationSource: 'PUBLIC', createdAt: { gte: todayStart } },
      }),
      this.prisma.student.count({
        where: {
          registrationSource: 'PUBLIC',
          examTarget: { name: { contains: 'NEET', mode: 'insensitive' } },
        },
      }),
      this.prisma.student.count({
        where: {
          registrationSource: 'PUBLIC',
          examTarget: { name: { contains: 'JEE', mode: 'insensitive' } },
        },
      }),
      this.prisma.student.count({
        where: {
          registrationSource: 'PUBLIC',
          examTarget: { name: { contains: 'CET', mode: 'insensitive' } },
        },
      }),
    ]);

    return {
      totalPublic,
      activePublic,
      inactivePublic,
      todayPublic,
      byTarget: {
        NEET: neetCount,
        JEE: jeeCount,
        CET: cetCount,
        OTHER: Math.max(0, totalPublic - (neetCount + jeeCount + cetCount)),
      },
    };
  }

  /**
   * Get single public registration student profile
   */
  async getPublicStudentById(studentId: string) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
        registrationSource: 'PUBLIC',
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            mobileNumber: true,
            phone: true,
            status: true,
            isActive: true,
            isVerified: true,
            createdAt: true,
            lastLoginAt: true,
          },
        },
        studentClass: true,
        examTarget: true,
        stateRef: true,
        districtRef: true,
        institution: true,
        studentExamTargets: { include: { examTarget: true } },
        attempts: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            exam: { select: { id: true, title: true } },
            result: { select: { totalScore: true, percentage: true, resultStatus: true } },
          },
        },
        paymentTransactions: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Public registration student with ID '${studentId}' was not found.`);
    }

    return student;
  }

  /**
   * Safely deactivate public registration student account
   * Sets Student.status = INACTIVE and User.isActive = false
   * Preserves all attempts, results, payment history, relationships
   */
  async deactivatePublicStudent(
    studentId: string,
    actorUserId: string,
    reason?: string,
  ) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
        registrationSource: 'PUBLIC',
      },
      include: { user: true },
    });

    if (!student) {
      throw new NotFoundException(
        `Public registration student with ID '${studentId}' was not found.`,
      );
    }

    // Atomic update
    await this.prisma.$transaction(async (tx) => {
      await tx.student.update({
        where: { id: student.id },
        data: { status: 'INACTIVE' },
      });

      if (student.userId) {
        await tx.user.update({
          where: { id: student.userId },
          data: {
            isActive: false,
            status: 'DISABLED',
          },
        });
      }

      try {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'STUDENT_DEACTIVATED',
            entityType: 'STUDENT',
            entityId: student.id,
            reason: reason || 'Super Admin deactivated public registration student',
            metadata: {
              studentId: student.studentId,
              name: student.name,
              registrationSource: 'PUBLIC',
              deactivatedAt: new Date().toISOString(),
            },
          },
        });
      } catch (e) {
        this.logger.warn(`Audit log creation notice: ${e}`);
      }
    });

    return {
      success: true,
      message: `Student '${student.name}' (${student.studentId}) deactivated successfully.`,
      studentId: student.id,
      status: 'INACTIVE',
      accountStatus: 'INACTIVE',
    };
  }

  /**
   * Reactivate public registration student account
   */
  async activatePublicStudent(studentId: string, actorUserId: string) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [{ id: studentId }, { studentId: studentId }],
        registrationSource: 'PUBLIC',
      },
      include: { user: true },
    });

    if (!student) {
      throw new NotFoundException(
        `Public registration student with ID '${studentId}' was not found.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.student.update({
        where: { id: student.id },
        data: { status: 'ACTIVE' },
      });

      if (student.userId) {
        await tx.user.update({
          where: { id: student.userId },
          data: {
            isActive: true,
            status: 'ACTIVE',
          },
        });
      }

      try {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'STUDENT_ACTIVATED',
            entityType: 'STUDENT',
            entityId: student.id,
            reason: 'Super Admin reactivated public registration student account',
            metadata: {
              studentId: student.studentId,
              name: student.name,
              registrationSource: 'PUBLIC',
              activatedAt: new Date().toISOString(),
            },
          },
        });
      } catch (e) {
        this.logger.warn(`Audit log creation notice: ${e}`);
      }
    });

    return {
      success: true,
      message: `Student '${student.name}' (${student.studentId}) activated successfully.`,
      studentId: student.id,
      status: 'ACTIVE',
      accountStatus: 'ACTIVE',
    };
  }
}
