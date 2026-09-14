import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { AcademicService } from './academic.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditLogService } from '../admin/audit/services/audit-log.service';

describe('AcademicService - Chapter Master Data Management', () => {
  let service: AcademicService;
  let prisma: any;
  let redis: any;
  let auditLog: any;

  const mockSubject = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Physics',
    code: 'PHY',
    isActive: true,
  };

  const mockChapter = {
    id: '22222222-2222-2222-2222-222222222222',
    subjectId: mockSubject.id,
    name: 'Kinematics',
    code: 'PHY_02',
    description: 'Study of motion without considering its causes',
    displayOrder: 2,
    isActive: true,
    subject: mockSubject,
    _count: { topics: 2, questions: 10 },
  };

  beforeEach(async () => {
    prisma = {
      subject: {
        findUnique: jest.fn().mockResolvedValue(mockSubject),
        findMany: jest.fn().mockResolvedValue([mockSubject]),
        create: jest.fn().mockResolvedValue(mockSubject),
        update: jest.fn().mockResolvedValue(mockSubject),
        delete: jest.fn().mockResolvedValue(mockSubject),
      },
      chapter: {
        findUnique: jest.fn().mockResolvedValue(mockChapter),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([mockChapter]),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'new-id', ...args.data })),
        update: jest.fn().mockImplementation((args) => Promise.resolve({ ...mockChapter, ...args.data })),
        delete: jest.fn().mockResolvedValue(mockChapter),
        aggregate: jest.fn().mockResolvedValue({ _max: { displayOrder: 5 } }),
        count: jest.fn().mockResolvedValue(1),
      },
      topic: {
        count: jest.fn().mockResolvedValue(0),
      },
      question: {
        count: jest.fn().mockResolvedValue(0),
      },
      blueprintRule: {
        count: jest.fn().mockResolvedValue(0),
      },
      chapterResult: {
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([]),
    };

    auditLog = {
      logAction: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcademicService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: AuditLogService, useValue: auditLog },
      ],
    }).compile();

    service = module.get<AcademicService>(AcademicService);
  });

  describe('createChapter', () => {
    it('should successfully create a chapter and invalidate cache', async () => {
      const dto = {
        subjectId: mockSubject.id,
        name: 'Laws of Motion',
        code: 'PHY_03',
        description: 'Newtonian mechanics',
        displayOrder: 3,
      };

      const result = await service.createChapter(dto, 'admin-user-1');

      expect(prisma.subject.findUnique).toHaveBeenCalledWith({ where: { id: dto.subjectId } });
      expect(prisma.chapter.create).toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAPTER_CREATED',
          actorUserId: 'admin-user-1',
        }),
      );
      expect(result.name).toEqual('Laws of Motion');
    });

    it('should throw ConflictException if chapter with same name already exists in subject', async () => {
      prisma.chapter.findFirst.mockResolvedValue(mockChapter);

      const dto = {
        subjectId: mockSubject.id,
        name: 'Kinematics',
      };

      await expect(service.createChapter(dto)).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if subject does not exist', async () => {
      prisma.subject.findUnique.mockResolvedValue(null);

      const dto = {
        subjectId: 'non-existent-subject',
        name: 'New Chapter',
      };

      await expect(service.createChapter(dto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateChapter', () => {
    it('should update chapter and log action', async () => {
      const dto = {
        name: 'Kinematics Updated',
        displayOrder: 4,
      };

      const result = await service.updateChapter(mockChapter.id, dto, 'admin-user-1');

      expect(prisma.chapter.update).toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAPTER_UPDATED',
          actorUserId: 'admin-user-1',
        }),
      );
      expect(result.name).toEqual('Kinematics Updated');
    });

    it('should prevent moving chapter to another subject if questions are associated', async () => {
      prisma.question.count.mockResolvedValue(5);

      const dto = {
        subjectId: '33333333-3333-3333-3333-333333333333',
      };

      await expect(service.updateChapter(mockChapter.id, dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteChapter (Safe Delete Strategy)', () => {
    it('should deactivate/archive chapter if questions or topics are attached', async () => {
      prisma.question.count.mockResolvedValue(15);
      prisma.topic.count.mockResolvedValue(2);

      const result = await service.deleteChapter(mockChapter.id, 'admin-user-1');

      expect(prisma.chapter.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockChapter.id },
          data: { isActive: false },
        }),
      );
      expect(prisma.chapter.delete).not.toHaveBeenCalled();
      expect(result.deactivated).toBe(true);
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAPTER_DEACTIVATED',
          actorUserId: 'admin-user-1',
        }),
      );
    });

    it('should permanently delete chapter if no dependencies exist', async () => {
      prisma.question.count.mockResolvedValue(0);
      prisma.topic.count.mockResolvedValue(0);
      prisma.blueprintRule.count.mockResolvedValue(0);
      prisma.chapterResult.count.mockResolvedValue(0);

      const result = await service.deleteChapter(mockChapter.id, 'admin-user-1');

      expect(prisma.chapter.delete).toHaveBeenCalledWith({ where: { id: mockChapter.id } });
      expect(result.deleted).toBe(true);
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAPTER_DELETED',
          actorUserId: 'admin-user-1',
        }),
      );
    });
  });

  describe('reorderChapters', () => {
    it('should transactionally update displayOrder and invalidate cache', async () => {
      const chapterIds = ['id-1', 'id-2', 'id-3'];

      await service.reorderChapters(mockSubject.id, chapterIds, 'admin-user-1');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAPTER_REORDERED',
          actorUserId: 'admin-user-1',
        }),
      );
    });
  });

  describe('findChaptersBySubject (Caching)', () => {
    it('should return cached chapters when present in Redis', async () => {
      const cachedData = [mockChapter];
      redis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await service.findChaptersBySubject(mockSubject.id);

      expect(redis.get).toHaveBeenCalled();
      expect(prisma.chapter.findMany).not.toHaveBeenCalled();
      expect(result).toEqual(cachedData);
    });

    it('should query DB and populate Redis when cache misses', async () => {
      redis.get.mockResolvedValue(null);

      const result = await service.findChaptersBySubject(mockSubject.id);

      expect(prisma.chapter.findMany).toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalled();
      expect(result).toEqual([mockChapter]);
    });
  });

  describe('Global Subjects & Exam Target Mapping', () => {
    it('should return all global subjects when no exam target is specified', async () => {
      const globalSubjects = [
        { id: '1', name: 'Physics', code: 'PHY' },
        { id: '2', name: 'Chemistry', code: 'CHEM' },
        { id: '3', name: 'Mathematics', code: 'MATH' },
        { id: '4', name: 'Biology', code: 'BIO' },
      ];
      prisma.subject.findMany.mockResolvedValue(globalSubjects);

      const result = await service.findAllSubjects();

      expect(prisma.subject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
        }),
      );
      expect(result).toHaveLength(4);
    });

    it('should filter subjects by examTargetId using examTargetSubjects relation', async () => {
      const jeeTargetId = 'jee-target-id';
      const jeeSubjects = [
        { id: '1', name: 'Physics', code: 'PHY' },
        { id: '2', name: 'Chemistry', code: 'CHEM' },
        { id: '3', name: 'Mathematics', code: 'MATH' },
      ];
      prisma.subject.findMany.mockResolvedValue(jeeSubjects);

      const result = await service.findAllSubjects(jeeTargetId);

      expect(prisma.subject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            examTargetSubjects: {
              some: {
                OR: [{ examTargetId: jeeTargetId }],
              },
            },
          },
        }),
      );
      expect(result).toHaveLength(3);
    });

    it('should return hierarchy mapping subjects from examTargetSubjects', async () => {
      const mockTargetWithSubjects = {
        id: 'target-1',
        name: 'JEE',
        examTargetSubjects: [
          { subject: { id: '1', name: 'Physics', chapters: [] } },
          { subject: { id: '2', name: 'Chemistry', chapters: [] } },
          { subject: { id: '3', name: 'Mathematics', chapters: [] } },
        ],
      };
      prisma.examTarget = {
        findUnique: jest.fn().mockResolvedValue(mockTargetWithSubjects),
      };

      const result = await service.getHierarchy('target-1');

      expect(prisma.examTarget.findUnique).toHaveBeenCalled();
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('Physics');
      expect(result[1].name).toBe('Chemistry');
      expect(result[2].name).toBe('Mathematics');
    });
  });
});
