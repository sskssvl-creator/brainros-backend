import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventService } from '../auth/services/security-event.service';
import { OtpService } from '../auth/services/otp.service';
import { RedisService } from '../redis/redis.service';
import { UpdateStudentProfileDto } from './dto/update-student-profile.dto';
import {
  RequestChangeMobileDto,
  VerifyChangeMobileDto,
} from './dto/change-mobile.dto';
import {
  RequestChangeEmailDto,
  VerifyChangeEmailDto,
} from './dto/change-email.dto';
import { resolveEligibleExamTypes } from '../../common/constants/target-exam.constant';

@Injectable()
export class StudentService {
  private readonly logger = new Logger(StudentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEventService: SecurityEventService,
    private readonly otpService: OtpService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Resolves the student's target exam combination into all eligible actual ExamTarget DB record IDs.
   * Handles combo targets (e.g. 'NEET + JEE' -> [NEET_ID, JEE_ID]).
   */
  private async getEligibleExamTargetIdsForStudent(student: any): Promise<string[]> {
    const rawTargetNames: string[] = [];
    if (student.examTarget?.name) {
      rawTargetNames.push(student.examTarget.name);
    }
    if (Array.isArray(student.studentExamTargets)) {
      student.studentExamTargets.forEach((st: any) => {
        if (st.examTarget?.name) rawTargetNames.push(st.examTarget.name);
      });
    }

    const eligibleExamTypeNames = new Set<string>();
    for (const name of rawTargetNames) {
      const resolved = resolveEligibleExamTypes(name);
      resolved.forEach((t) => eligibleExamTypeNames.add(t));
    }

    const directIds = [
      ...(student.examTargetId ? [student.examTargetId] : []),
      ...(student.studentExamTargets?.map((st: any) => st.examTargetId) || []),
    ];

    const matchingTargets = await this.prisma.examTarget.findMany({
      where: {
        OR: [
          { name: { in: Array.from(eligibleExamTypeNames) } },
          { id: { in: directIds } },
        ],
      },
      select: { id: true },
    });

    return Array.from(new Set([...matchingTargets.map((t) => t.id), ...directIds]));
  }

  /**
   * Get student profile by authenticated user ID.
   * Auto-provisions a student record if the authenticated user does not have one yet.
   */
  async getProfile(userId: string) {
    let student = await this.prisma.student.findUnique({
      where: { userId },
      include: {
        studentClass: true,
        examTarget: true,
        preferredLanguage: true,
        stateRef: true,
        districtRef: true,
        user: {
          select: {
            id: true,
            email: true,
            mobileNumber: true,
            phone: true,
            status: true,
            isVerified: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
            userRoles: {
              select: {
                role: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!student) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundException('User account not found.');
      }

      // Auto-provision a default Student profile with unique Student ID
      const year = new Date().getFullYear();
      let sequenceNum = (await this.prisma.student.count()) + 1;
      let studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
      let studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;

      let collision = await this.prisma.student.findFirst({
        where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
      });
      while (collision) {
        sequenceNum++;
        studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
        studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;
        collision = await this.prisma.student.findFirst({
          where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
        });
      }

      let [firstClass, firstLang, firstTarget, firstState] = await Promise.all([
        this.prisma.studentClass.findFirst(),
        this.prisma.preferredLanguage.findFirst({ where: { isActive: true } }),
        this.prisma.examTarget.findFirst(),
        this.prisma.state.findFirst({
          where: { isActive: true },
          include: { districts: true },
        }),
      ]);

      if (!firstClass) {
        firstClass = await this.prisma.studentClass.create({
          data: { name: 'Class 12', description: 'Standard 12' },
        });
      }
      if (!firstLang) {
        firstLang = await this.prisma.preferredLanguage.create({
          data: {
            name: 'English',
            code: 'en',
            nativeName: 'English',
            isActive: true,
          },
        });
      }
      if (!firstTarget) {
        firstTarget = await this.prisma.examTarget.create({
          data: { name: 'JEE Main', description: 'Engineering Entrance' },
        });
      }
      if (!firstState) {
        firstState = await this.prisma.state.create({
          data: {
            name: 'Karnataka',
            code: 'KA',
            isActive: true,
            districts: {
              create: [{ name: 'Bengaluru', isActive: true }],
            },
          },
          include: { districts: true },
        });
      }

      student = await this.prisma.student.create({
        data: {
          userId: user.id,
          studentId: studentIdStr,
          studentCode,
          name:
            user.email?.split('@')[0] ||
            user.mobileNumber ||
            user.phone ||
            'Student',
          state: firstState?.name || 'Karnataka',
          district: firstState?.districts?.[0]?.name || 'Bengaluru',
          stateId: firstState?.id || null,
          districtId: firstState?.districts?.[0]?.id || null,
          schoolCollege: 'Educational Institute',
          classId: firstClass.id,
          preferredLanguageId: firstLang.id,
          examTargetId: firstTarget.id,
          status: 'ACTIVE',
          registrationSource: 'ADMIN',
        },
        include: {
          studentClass: true,
          examTarget: true,
          preferredLanguage: true,
          stateRef: true,
          districtRef: true,
          user: {
            select: {
              id: true,
              email: true,
              mobileNumber: true,
              phone: true,
              status: true,
              isVerified: true,
              isActive: true,
              lastLoginAt: true,
              createdAt: true,
              userRoles: {
                select: {
                  role: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
    }

    if (student && student.user) {
      const roles =
        (student.user as any)?.userRoles?.map((ur: any) => ur.role?.name).filter(Boolean) || [];
      (student.user as any).roles = roles;
    }

    return student;
  }

  /**
   * Update student profile permitted fields with strict validation of master data
   */
  async updateProfile(
    userId: string,
    dto: UpdateStudentProfileDto,
    requestContext?: any,
  ) {
    let currentStudent = await this.prisma.student.findUnique({
      where: { userId },
    });

    if (!currentStudent) {
      currentStudent = await this.getProfile(userId);
    }

    // Validate preferred language if provided
    if (dto.preferredLanguageId) {
      const lang = await this.prisma.preferredLanguage.findUnique({
        where: { id: dto.preferredLanguageId },
      });
      if (!lang)
        throw new NotFoundException('Selected preferred language not found.');
      if (!lang.isActive)
        throw new BadRequestException('Selected language is not active.');
    }

    // Validate district against state if provided
    if (dto.districtId) {
      const targetStateId = dto.stateId || currentStudent?.stateId;
      const dist = await this.prisma.district.findUnique({
        where: { id: dto.districtId },
      });
      if (!dist) {
        throw new NotFoundException('Selected district not found.');
      }
      if (targetStateId && dist.stateId && dist.stateId !== targetStateId) {
        throw new BadRequestException('Selected district does not belong to the selected state.');
      }
    }

    const updateData: any = {};
    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (!trimmedName) {
        throw new BadRequestException('Name cannot be empty.');
      }
      updateData.name = trimmedName;
    }
    if (dto.preferredLanguageId !== undefined) {
      updateData.preferredLanguageId = dto.preferredLanguageId;
    }
    if (dto.schoolCollege !== undefined) {
      updateData.schoolCollege = dto.schoolCollege ? dto.schoolCollege.trim() : null;
    }
    if (dto.classId !== undefined) {
      updateData.classId = dto.classId;
    }
    if (dto.examTargetId !== undefined) {
      updateData.examTargetId = dto.examTargetId;
    }
    if (dto.stateId !== undefined) {
      updateData.stateId = dto.stateId;
    }
    if (dto.districtId !== undefined) {
      updateData.districtId = dto.districtId;
    }

    const updatedStudent = await this.prisma.student.update({
      where: { userId },
      data: updateData,
      include: {
        studentClass: true,
        examTarget: true,
        preferredLanguage: true,
        stateRef: true,
        districtRef: true,
        user: {
          select: {
            id: true,
            email: true,
            mobileNumber: true,
            phone: true,
            status: true,
            isVerified: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
        },
      },
    });

    // Invalidate dashboard Redis cache
    try {
      await this.redisService.del(`student:${userId}:dashboard`);
    } catch {
      // Non-fatal
    }

    await this.securityEventService.log('ROLE_CHANGED', {
      userId,
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      metadata: { action: 'PROFILE_UPDATED' },
    });

    return updatedStudent;
  }

  // ═══════════════════════════════════════════════════════════════
  // SENSITIVE CONTACT UPDATES (OTP VERIFIED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Request mobile change: validates uniqueness and sends OTP to the NEW mobile number
   */
  async requestChangeMobile(
    userId: string,
    dto: RequestChangeMobileDto,
    requestContext?: any,
  ) {
    const normalizedNewMobile = this.otpService.normalizeMobileNumber(
      dto.newMobileNumber,
    );

    // Check if new mobile is already in use by another user
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { mobileNumber: normalizedNewMobile },
          { phone: normalizedNewMobile },
        ],
        NOT: { id: userId },
      },
    });

    if (existing) {
      throw new BadRequestException(
        'This mobile number is already in use by another account.',
      );
    }

    // Save pending change in Redis (5 min TTL)
    await this.redisService.set(
      `mobile-change:${userId}`,
      JSON.stringify({
        newMobile: normalizedNewMobile,
        createdAt: new Date().toISOString(),
      }),
      300,
    );

    // Send OTP to the NEW mobile
    await this.otpService.sendOtp(normalizedNewMobile, 'CHANGE_MOBILE', {
      ...requestContext,
      userId,
    });

    return {
      message: 'OTP sent to new mobile number for verification.',
      data: { requiresOtp: true, purpose: 'CHANGE_MOBILE', expiresIn: 300 },
    };
  }

  /**
   * Verify mobile change OTP: verifies OTP on new mobile and updates User record
   */
  async verifyChangeMobile(
    userId: string,
    dto: VerifyChangeMobileDto,
    requestContext?: any,
  ) {
    const rawData = await this.redisService.get(`mobile-change:${userId}`);
    if (!rawData) {
      throw new BadRequestException(
        'Mobile change request expired or not found. Please request again.',
      );
    }

    const { newMobile } = JSON.parse(rawData);

    // Verify OTP
    await this.otpService.verifyOtp(newMobile, dto.otp, 'CHANGE_MOBILE', {
      ...requestContext,
      userId,
    });

    // Invalidate pending change in Redis
    await this.redisService.del(`mobile-change:${userId}`);

    // Update User mobile
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mobileNumber: newMobile,
        phone: newMobile,
        mobileVerifiedAt: new Date(),
      },
    });

    await this.securityEventService.log('MOBILE_CHANGED', {
      userId,
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      metadata: { newMobile },
    });

    return {
      message: 'Mobile number updated successfully.',
      data: {
        userId: updatedUser.id,
        mobileNumber: updatedUser.mobileNumber,
        mobileVerifiedAt: updatedUser.mobileVerifiedAt,
      },
    };
  }

  /**
   * Request email change: validates uniqueness and sends OTP
   */
  async requestChangeEmail(
    userId: string,
    dto: RequestChangeEmailDto,
    requestContext?: any,
  ) {
    const normalizedEmail = dto.newEmail.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing && existing.id !== userId) {
      throw new BadRequestException(
        'This email is already in use by another account.',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (!user.mobileNumber && !user.phone)) {
      throw new BadRequestException(
        'User does not have a verified mobile for authorization.',
      );
    }

    const targetMobile = user.mobileNumber || user.phone!;

    // Save pending change in Redis (5 min TTL)
    await this.redisService.set(
      `email-change:${userId}`,
      JSON.stringify({
        newEmail: normalizedEmail,
        createdAt: new Date().toISOString(),
      }),
      300,
    );

    // Send verification OTP to account mobile
    await this.otpService.sendOtp(targetMobile, 'VERIFY_EMAIL', {
      ...requestContext,
      userId,
    });

    return {
      message:
        'Security OTP sent to your registered mobile to authorize email change.',
      data: { requiresOtp: true, purpose: 'VERIFY_EMAIL', expiresIn: 300 },
    };
  }

  /**
   * Verify email change OTP: updates User email
   */
  async verifyChangeEmail(
    userId: string,
    dto: VerifyChangeEmailDto,
    requestContext?: any,
  ) {
    const rawData = await this.redisService.get(`email-change:${userId}`);
    if (!rawData) {
      throw new BadRequestException(
        'Email change request expired or not found. Please request again.',
      );
    }

    const { newEmail } = JSON.parse(rawData);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (!user.mobileNumber && !user.phone)) {
      throw new BadRequestException('User not found.');
    }

    const targetMobile = user.mobileNumber || user.phone!;

    // Verify OTP
    await this.otpService.verifyOtp(targetMobile, dto.otp, 'VERIFY_EMAIL', {
      ...requestContext,
      userId,
    });

    await this.redisService.del(`email-change:${userId}`);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: newEmail,
        emailVerifiedAt: new Date(),
      },
    });

    await this.securityEventService.log('EMAIL_CHANGED', {
      userId,
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      metadata: { newEmail },
    });

    return {
      message: 'Email updated successfully.',
      data: {
        userId: updatedUser.id,
        email: updatedUser.email,
        emailVerifiedAt: updatedUser.emailVerifiedAt,
      },
    };
  }

  /**
   * Get student's login sessions
   */
  async getSessions(userId: string) {
    return this.prisma.loginSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ipAddress: true,
        lastActivityAt: true,
        createdAt: true,
      },
      orderBy: { lastActivityAt: 'desc' },
    });
  }

  /**
   * ─── Student Exams Discovery API ──────────────────────────────────────────
   * Returns official scheduled and synchronized live exams for the student.
   * Categorized by dynamic lifecycle: UPCOMING, LIVE, COMPLETED.
   */
  async getStudentExams(userId: string, query: any) {
    const student = await this.prisma.student.findFirst({
      where: { OR: [{ userId }, { id: userId }] },
      include: {
        examTarget: true,
        studentExamTargets: { include: { examTarget: true } },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student profile not found for user '${userId}'`);
    }

    const eligibleTargetIds = await this.getEligibleExamTargetIdsForStudent(student);

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(query.limit) || 5));
    const skip = (page - 1) * limit;
    const now = new Date();

    // Base criteria: Exclude DRAFT, CANCELLED, GENERATING, and un-scheduled APPROVED exams
    const where: any = {
      AND: [
        {
          OR: [
            { status: { name: { in: ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'ENDED'] } } },
            { attempts: { some: { studentId: student.id } } },
          ],
        },
      ],
    };

    // Filter by Exam Target: enforce backend student target eligibility
    if (query.examTargetId) {
      if (eligibleTargetIds.includes(query.examTargetId)) {
        where.AND.push({ examTargetId: query.examTargetId });
      } else {
        // Querying an exam target the student is not eligible for -> return no exams
        where.AND.push({ examTargetId: '00000000-0000-0000-0000-000000000000' });
      }
    } else if (eligibleTargetIds.length > 0) {
      where.AND.push({
        OR: [
          { examTargetId: { in: eligibleTargetIds } },
          { examTarget: { name: 'General' } },
        ],
      });
    }

    // Search by title or target name
    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { examTarget: { name: { contains: term, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    // Database-level status filtering
    if (query.status === 'UPCOMING') {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { startTime: { gt: now } },
            { schedules: { some: { status: { in: ['SCHEDULED', 'ACTIVE'] }, startTime: { gt: now } } } },
          ],
        },
        {
          NOT: {
            attempts: {
              some: {
                studentId: student.id,
                status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] } },
              },
            },
          },
        },
      ];
    } else if (query.status === 'LIVE') {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { startTime: { lte: now }, endTime: { gt: now } },
            { schedules: { some: { status: 'ACTIVE', startTime: { lte: now }, endTime: { gt: now } } } },
          ],
        },
        {
          NOT: {
            attempts: {
              some: {
                studentId: student.id,
                status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] } },
              },
            },
          },
        },
      ];
    } else if (query.status === 'COMPLETED') {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            {
              attempts: {
                some: {
                  studentId: student.id,
                  status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] } },
                },
              },
            },
            { endTime: { lte: now } },
            { schedules: { some: { endTime: { lte: now } } } },
          ],
        },
      ];
    }

    // Database-level sorting
    let orderBy: any = { createdAt: 'desc' };
    const sort = query.sort || 'UPCOMING_SOONEST';
    if (sort === 'UPCOMING_SOONEST') {
      orderBy = [{ startTime: 'asc' }, { createdAt: 'desc' }];
    } else if (sort === 'NEWEST') {
      orderBy = { createdAt: 'desc' };
    } else if (sort === 'OLDEST') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'NAME_ASC') {
      orderBy = { title: 'asc' };
    } else if (sort === 'NAME_DESC') {
      orderBy = { title: 'desc' };
    }

    // Database-level pagination with LIMIT and OFFSET
    const [rawExams, total]: [any[], number] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          examTarget: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          schedules: {
            where: { status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED', 'ENDED'] } },
            orderBy: [{ updatedAt: 'desc' }, { startTime: 'desc' }],
            take: 1,
          },
          sections: {
            include: {
              subject: { select: { id: true, name: true } },
            },
          },
          attempts: {
            where: { studentId: student.id },
            include: {
              status: true,
              result: {
                select: {
                  id: true,
                  totalScore: true,
                  maxScore: true,
                  percentage: true,
                  accuracy: true,
                  resultStatus: true,
                  publishedAt: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.exam.count({ where }),
    ]);

    // Map each exam to student view with calculated authoritative lifecycle status
    const items = rawExams.map((exam) => {
      const schedule = exam.schedules?.[0] || null;
      const attempt = exam.attempts?.[0] || null;
      const attemptStatus = attempt?.status?.name || 'NOT_STARTED';

      const startTime = schedule?.startTime || exam.startTime || null;
      const endTime = schedule?.endTime || exam.endTime || null;

      // Authoritative dynamic lifecycle status
      let calculatedStatus: 'UPCOMING' | 'LIVE' | 'COMPLETED' = 'UPCOMING';
      let canStart = false;

      const isAttemptCompleted = ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'].includes(
        attemptStatus,
      );
      const isInProgress = attemptStatus === 'IN_PROGRESS';

      if (isAttemptCompleted) {
        calculatedStatus = 'COMPLETED';
        canStart = false;
      } else if (endTime && now.getTime() >= new Date(endTime).getTime()) {
        // Official end time has passed - exam is no longer live under ANY circumstances
        calculatedStatus = 'COMPLETED';
        canStart = false;
      } else if (isInProgress) {
        calculatedStatus = 'LIVE';
        canStart = false;
      } else if (
        startTime &&
        endTime &&
        new Date(startTime).getTime() <= now.getTime() &&
        new Date(endTime).getTime() > now.getTime()
      ) {
        calculatedStatus = 'LIVE';
        canStart = true;
      } else if (startTime && new Date(startTime).getTime() > now.getTime()) {
        calculatedStatus = 'UPCOMING';
        canStart = false;
      } else {
        calculatedStatus = 'UPCOMING';
        canStart = false;
      }

      return {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        examTarget: exam.examTarget?.name || 'General',
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        status: calculatedStatus,
        rawStatus: exam.status?.name,
        canStart: canStart && !isAttemptCompleted && !isInProgress,
        canResume: isInProgress && (!endTime || now.getTime() < new Date(endTime).getTime()),
        isInProgress,
        activeAttemptId: isInProgress ? attempt?.id : null,
        startTime: startTime ? new Date(startTime).toISOString() : null,
        endTime: endTime ? new Date(endTime).toISOString() : null,
        scheduleId: schedule?.id || null,
        attempt: attempt
          ? {
              id: attempt.id,
              status: attemptStatus,
              startedAt: attempt.startedAt,
              submittedAt: attempt.submittedAt,
              result: attempt.result || null,
            }
          : null,
        subjects: exam.sections.map((sec) => sec.subject?.name).filter(Boolean),
        createdAt: exam.createdAt,
      };
    });

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * ─── Student Mock Tests Discovery API ─────────────────────────────────────
   * Returns practice tests and mock exams with server-side database pagination.
   */
  async getStudentMockTests(userId: string, query: any) {
    const student = await this.prisma.student.findFirst({
      where: { OR: [{ userId }, { id: userId }] },
      include: {
        examTarget: true,
        studentExamTargets: { include: { examTarget: true } },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student profile not found for user '${userId}'`);
    }

    const eligibleTargetIds = await this.getEligibleExamTargetIdsForStudent(student);

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(query.limit) || 5));
    const skip = (page - 1) * limit;

    // Base criteria: Approved, non-draft mock exams
    const where: any = {
      status: {
        name: { in: ['APPROVED', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'ENDED'] },
      },
    };

    // Filter by Exam Target: enforce backend student target eligibility
    if (query.examTargetId) {
      if (eligibleTargetIds.includes(query.examTargetId)) {
        where.examTargetId = query.examTargetId;
      } else {
        where.examTargetId = '00000000-0000-0000-0000-000000000000';
      }
    } else if (eligibleTargetIds.length > 0) {
      where.OR = [
        { examTargetId: { in: eligibleTargetIds } },
        { examTarget: { name: 'General' } },
      ];
    }

    // Search by title or target name
    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { examTarget: { name: { contains: term, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    // Filter by attempt status tab at database level
    if (query.attemptStatus === 'NOT_ATTEMPTED') {
      where.attempts = { none: { studentId: student.id } };
    } else if (query.attemptStatus === 'ATTEMPTED') {
      where.attempts = { some: { studentId: student.id } };
    }

    // Filter by subject at database level
    if (query.subjectId) {
      where.sections = {
        some: {
          subject: {
            OR: [
              { id: query.subjectId },
              { name: { contains: query.subjectId, mode: 'insensitive' } },
            ],
          },
        },
      };
    }

    // Filter by difficulty at database level
    if (query.difficulty && query.difficulty !== 'ALL') {
      const diff = query.difficulty.toUpperCase();
      if (diff === 'EASY') {
        where.defaultNegativeMarks = { lte: 0 };
      } else if (diff === 'HARD') {
        where.defaultNegativeMarks = { gte: 1 };
      } else if (diff === 'MEDIUM') {
        where.defaultNegativeMarks = { gt: 0, lt: 1 };
      }
    }

    // Server-side database sorting
    let orderBy: any = { createdAt: 'desc' };
    const sort = query.sort || 'NEWEST';
    if (sort === 'NEWEST') {
      orderBy = { createdAt: 'desc' };
    } else if (sort === 'OLDEST') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'NAME_ASC') {
      orderBy = { title: 'asc' };
    } else if (sort === 'NAME_DESC') {
      orderBy = { title: 'desc' };
    } else if (sort === 'MOST_ATTEMPTED') {
      orderBy = { attempts: { _count: 'desc' } };
    }

    // Database-level pagination with LIMIT and OFFSET
    const [rawMocks, total] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          examTarget: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          sections: {
            include: {
              subject: { select: { id: true, name: true } },
            },
          },
          attempts: {
            where: { studentId: student.id },
            include: {
              status: true,
              result: {
                select: {
                  id: true,
                  totalScore: true,
                  maxScore: true,
                  percentage: true,
                  accuracy: true,
                  resultStatus: true,
                  publishedAt: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      this.prisma.exam.count({ where }),
    ]);

    // Map to mock test view
    const items = rawMocks.map((exam) => {
      const attempts = exam.attempts || [];
      const completedAttempts = attempts.filter((a) =>
        ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'].includes(a.status?.name),
      );
      const activeAttempt = attempts.find((a) => a.status?.name === 'IN_PROGRESS');

      // Best score calculation
      let bestScore: number | null = null;
      let bestPercentage: number | null = null;
      let latestResult: any = null;

      for (const a of completedAttempts) {
        if (a.result && a.result.totalScore !== undefined) {
          if (bestScore === null || a.result.totalScore > bestScore) {
            bestScore = a.result.totalScore;
            bestPercentage = a.result.percentage;
          }
          if (!latestResult) {
            latestResult = a.result;
          }
        }
      }

      // Infer difficulty
      const negMarks = exam.defaultNegativeMarks || 0;
      let difficulty = 'MEDIUM';
      if (negMarks <= 0) difficulty = 'EASY';
      else if (negMarks >= 1) difficulty = 'HARD';

      // Primary subject
      const subjectNames = exam.sections
        .map((s) => s.subject?.name)
        .filter(Boolean);
      const primarySubject = subjectNames[0] || 'General';

      const isAttempted = completedAttempts.length > 0;
      const attemptStatus = activeAttempt
        ? 'IN_PROGRESS'
        : isAttempted
          ? 'ATTEMPTED'
          : 'NOT_ATTEMPTED';

      return {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        examTarget: exam.examTarget?.name || 'General',
        primarySubject,
        subjects: subjectNames,
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        difficulty,
        attemptStatus,
        attemptsCount: completedAttempts.length,
        activeAttemptId: activeAttempt?.id || null,
        latestAttemptId: completedAttempts[0]?.id || null,
        bestScore,
        bestPercentage,
        latestResult,
        createdAt: exam.createdAt,
      };
    });

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Get student's mock test attempt history with server-side pagination & analytics
   */
  async getStudentMockHistory(userId: string, query: any = {}) {
    const student = await this.prisma.student.findFirst({
      where: { OR: [{ userId }, { id: userId }] },
      select: { id: true, examTargetId: true },
    });

    if (!student) {
      throw new NotFoundException(`Student profile not found for user '${userId}'`);
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(query.limit) || 5));
    const skip = (page - 1) * limit;

    const where: any = {
      studentId: student.id,
    };

    if (query.status && query.status !== 'ALL') {
      if (query.status === 'COMPLETED') {
        where.status = { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED', 'COMPLETED'] } };
      } else {
        where.status = { name: query.status };
      }
    }

    if (query.search && query.search.trim()) {
      where.exam = {
        title: { contains: query.search.trim(), mode: 'insensitive' },
      };
    }

    if (query.examTargetId && query.examTargetId !== 'ALL') {
      where.exam = {
        ...(where.exam || {}),
        examTargetId: query.examTargetId,
      };
    }

    let orderBy: any = { createdAt: 'desc' };
    const sortBy = query.sortBy || query.sort || 'NEWEST';
    if (sortBy === 'NEWEST') {
      orderBy = { createdAt: 'desc' };
    } else if (sortBy === 'OLDEST') {
      orderBy = { createdAt: 'asc' };
    } else if (sortBy === 'SCORE_HIGH') {
      orderBy = { result: { totalScore: 'desc' } };
    } else if (sortBy === 'ACCURACY_HIGH') {
      orderBy = { result: { accuracy: 'desc' } };
    }

    const [attempts, total] = await Promise.all([
      this.prisma.attempt.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          exam: {
            select: {
              id: true,
              title: true,
              totalQuestions: true,
              totalMarks: true,
              durationMinutes: true,
              examTarget: { select: { id: true, name: true } },
              sections: {
                include: {
                  subject: { select: { id: true, name: true } },
                },
              },
            },
          },
          status: { select: { id: true, name: true } },
          result: {
            select: {
              id: true,
              totalScore: true,
              maxScore: true,
              percentage: true,
              accuracy: true,
              correctAnswers: true,
              wrongAnswers: true,
              unattempted: true,
              timeUsedSeconds: true,
              averageTimePerQuestion: true,
              resultStatus: true,
              subjectResults: {
                select: {
                  id: true,
                  subjectId: true,
                  subject: { select: { id: true, name: true } },
                  score: true,
                  maxScore: true,
                  accuracy: true,
                  correctAnswers: true,
                  wrongAnswers: true,
                  unattempted: true,
                },
              },
            },
          },
          candidateRanks: {
            select: {
              rank: true,
              totalCandidates: true,
              percentile: true,
              rankType: true,
            },
            orderBy: { createdAt: 'desc' },
          },
          timeAnalyses: {
            select: {
              averageTimePerQuestionSeconds: true,
              timeUtilizationPercentage: true,
              totalTimeUsedSeconds: true,
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          strategyAnalyses: {
            select: {
              primaryClassification: true,
              avoidableNegativeMarks: true,
              projectedScore: true,
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      this.prisma.attempt.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: attempts,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Fetch all attempts for a specific mock test for the logged-in student,
   * deterministically numbered and sorted newest first with persisted result metrics.
   */
  async getMockTestAttempts(userId: string, mockTestId: string, query: any) {
    const student = await this.getProfile(userId);
    if (!student) {
      throw new NotFoundException('Student profile not found.');
    }

    const exam = await this.prisma.exam.findUnique({
      where: { id: mockTestId },
      include: {
        examTarget: { select: { id: true, name: true } },
        sections: {
          include: {
            subject: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!exam) {
      throw new NotFoundException('Mock test not found.');
    }

    // Fetch all attempts chronologically to assign deterministic attempt numbers
    const allAttempts = await this.prisma.attempt.findMany({
      where: {
        studentId: student.id,
        examId: mockTestId,
      },
      include: {
        status: true,
        result: true,
        candidateRanks: {
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const totalAttempts = allAttempts.length;

    let bestScore = 0;
    let hasBestScore = false;
    let latestScore: number | null = null;
    let activeAttempt: any = null;

    const mappedAttempts = allAttempts.map((attempt, index) => {
      const attemptNumber = index + 1;
      const isCompleted = ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED', 'COMPLETED'].includes(
        attempt.status?.name,
      );
      const isInProgress = ['IN_PROGRESS', 'INTERRUPTED'].includes(attempt.status?.name);

      if (isInProgress) {
        activeAttempt = {
          attemptId: attempt.id,
          attemptNumber,
          startedAt: attempt.createdAt,
          serverEndTime: attempt.serverEndTime,
        };
      }

      const score = attempt.result?.totalScore ?? null;
      if (score !== null) {
        if (!hasBestScore || score > bestScore) {
          bestScore = score;
          hasBestScore = true;
        }
        latestScore = score;
      }

      const maxScore = attempt.result?.maxScore ?? exam.totalMarks;
      const rawPerc =
        attempt.result?.percentage ??
        (score !== null && maxScore > 0 ? (score / maxScore) * 100 : null);
      const rawAcc = attempt.result?.accuracy ?? null;

      const percentage = rawPerc !== null ? Math.round(Number(rawPerc) * 100) / 100 : null;
      const accuracy = rawAcc !== null ? Math.round(Number(rawAcc) * 100) / 100 : null;

      return {
        attemptId: attempt.id,
        attemptNumber,
        status: attempt.status?.name || 'UNKNOWN',
        isCompleted,
        isInProgress,
        startedAt: attempt.createdAt,
        submittedAt: attempt.submittedAt || (attempt.result as any)?.publishedAt || attempt.updatedAt,
        score,
        maxScore,
        percentage,
        accuracy,
        correctCount: attempt.result?.correctAnswers ?? null,
        wrongCount: attempt.result?.wrongAnswers ?? null,
        unattemptedCount: attempt.result?.unattempted ?? null,
        timeUsedSeconds: attempt.result?.timeUsedSeconds ?? null,
        rank: attempt.candidateRanks?.[0]?.rank ?? null,
        percentile:
          attempt.candidateRanks?.[0]?.percentile !== undefined
            ? Math.round(Number(attempt.candidateRanks[0].percentile) * 100) / 100
            : null,
        isResultAvailable: isCompleted && attempt.result !== null,
      };
    });

    // Mark isBest & isLatest
    mappedAttempts.forEach((a) => {
      (a as any).isBest = hasBestScore && a.score === bestScore;
      (a as any).isLatest = a.attemptNumber === totalAttempts;
    });

    // Default sorting: Newest first (submittedAt/createdAt DESC)
    const sortedAttempts = [...mappedAttempts].sort((a, b) => {
      const timeA = new Date(a.submittedAt || a.startedAt).getTime();
      const timeB = new Date(b.submittedAt || b.startedAt).getTime();
      return timeB - timeA;
    });

    const page = Math.max(1, parseInt(query?.page || '1', 10));
    const limit = Math.max(1, Math.min(50, parseInt(query?.limit || '5', 10)));
    const startIndex = (page - 1) * limit;
    const paginatedAttempts = sortedAttempts.slice(startIndex, startIndex + limit);

    const subjects = exam.sections?.map((s) => s.subject?.name).filter(Boolean) || [];

    const summary = {
      mockTestId: exam.id,
      title: exam.title,
      description: exam.description,
      examTarget: exam.examTarget?.name || 'General',
      subjects: Array.from(new Set(subjects)),
      totalQuestions: exam.totalQuestions,
      totalMarks: exam.totalMarks,
      durationMinutes: exam.durationMinutes,
      totalAttempts,
      completedAttempts: mappedAttempts.filter((a) => a.isCompleted).length,
      bestScore: hasBestScore ? bestScore : null,
      latestScore,
      activeAttempt,
      canTakeAgain: !activeAttempt,
    };

    return {
      attempts: paginatedAttempts,
      summary,
      pagination: {
        page,
        limit,
        total: totalAttempts,
        totalPages: Math.ceil(totalAttempts / limit) || 1,
      },
    };
  }
}
