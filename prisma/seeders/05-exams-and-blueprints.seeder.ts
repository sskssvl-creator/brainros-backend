import { SeedContext, SeederResult } from './types';
import {
  ExamQuestion,
  ExamVersionStatus,
  ExamCycleStatus,
  CalendarEventStatus,
} from '@prisma/client';

export async function seedExamsAndBlueprints(ctx: SeedContext): Promise<SeederResult> {
  const start = Date.now();
  const created: Record<string, number> = {};
  const reused: Record<string, number> = {};

  const inc = (type: string, isNew: boolean) => {
    if (isNew) created[type] = (created[type] || 0) + 1;
    else reused[type] = (reused[type] || 0) + 1;
  };

  const { prisma } = ctx;
  const adminUser = ctx.users.get('admin.neet@brainros.test') || ctx.users.get('superadmin@brainros.test')!;
  const neetTarget = ctx.examTargets.get('NEET')!;
  const jeeTarget = ctx.examTargets.get('JEE') || ctx.examTargets.get('JEE_MAIN')!;

  const statusActive = ctx.examStatuses.get('ACTIVE')!;
  const statusCompleted = ctx.examStatuses.get('COMPLETED')!;
  const defaultLang = ctx.languages.get('en')!;
  const hindiLang = ctx.languages.get('hi');

  // 1. Academic Exam Cycle
  let examCycle = await prisma.examCycle.findFirst({
    where: { name: 'All India Test Series 2026-2027' },
  });
  if (!examCycle) {
    examCycle = await prisma.examCycle.create({
      data: {
        name: 'All India Test Series 2026-2027',
        academicYear: '2026-2027',
        startDate: new Date('2026-04-01'),
        endDate: new Date('2027-05-30'),
        status: ExamCycleStatus.ACTIVE,
        createdById: adminUser.id,
      },
    });
    inc('exam_cycles', true);
  } else {
    inc('exam_cycles', false);
  }

  // 2. Exam Definitions
  const examsData = [
    {
      code: 'TEMPLATE_JEE',
      title: 'JEE Main Exam Template',
      description: 'System template for JEE Main blueprint generation.',
      target: jeeTarget,
      totalQuestions: 75,
      totalMarks: 300,
      durationMinutes: 180,
      status: statusCompleted,
      isSystem: true,
      subjects: ['Physics (JEE)', 'Chemistry (JEE)', 'Mathematics'],
    },
    {
      code: 'TEMPLATE_NEET',
      title: 'NEET UG Exam Template',
      description: 'System template for NEET UG blueprint generation.',
      target: neetTarget,
      totalQuestions: 180,
      totalMarks: 720,
      durationMinutes: 200,
      status: statusCompleted,
      isSystem: true,
      subjects: ['Physics (NEET)', 'Chemistry (NEET)', 'Botany', 'Zoology'],
    },
    {
      code: 'EXAM_NEET_MOCK_01',
      title: 'Brainros NEET All-India Grand Mock Test 01',
      description: 'Full syllabus NEET mock test matching NTA pattern with standard difficulty distribution.',
      target: neetTarget,
      totalQuestions: 20,
      totalMarks: 80,
      durationMinutes: 60,
      status: statusCompleted, // Completed historical exam for trend testing
      isSystem: false,
      subjects: ['Physics (NEET)', 'Chemistry (NEET)', 'Botany', 'Zoology'],
    },
    {
      code: 'EXAM_NEET_MOCK_02',
      title: 'Brainros NEET All-India Grand Mock Test 02',
      description: 'Comprehensive NEET mock test with multi-lingual support and strategy analytics.',
      target: neetTarget,
      totalQuestions: 20,
      totalMarks: 80,
      durationMinutes: 60,
      status: statusActive, // Active exam currently in progress
      isSystem: false,
      subjects: ['Physics (NEET)', 'Chemistry (NEET)', 'Botany', 'Zoology'],
    },
    {
      code: 'EXAM_JEE_MOCK_01',
      title: 'Brainros JEE Main Full Syllabus Test 01',
      description: 'Standard JEE Main mock test covering Physics, Chemistry, and Mathematics.',
      target: jeeTarget,
      totalQuestions: 15,
      totalMarks: 60,
      durationMinutes: 60,
      status: statusCompleted,
      isSystem: false,
      subjects: ['Physics (JEE)', 'Chemistry (JEE)', 'Mathematics'],
    },
  ];

  const allQuestions = Array.from(ctx.questions.values());

  for (const eData of examsData) {
    let exam = await prisma.exam.findFirst({ where: { title: eData.title } });

    if (!exam) {
      exam = await prisma.exam.create({
        data: {
          title: eData.title,
          description: eData.description,
          examTargetId: eData.target.id,
          totalQuestions: eData.totalQuestions,
          totalMarks: eData.totalMarks,
          durationMinutes: eData.durationMinutes,
          defaultMarksPerQuestion: 4,
          defaultNegativeMarks: 1,
          statusId: eData.status.id,
          createdById: adminUser.id,
          approvedById: adminUser.id,
          approvedAt: new Date('2026-04-05'),
          activatedAt: new Date('2026-04-10'),
        },
      });
      inc('exams', true);
    } else {
      inc('exams', false);
    }
    ctx.exams.set(eData.code, exam);

    // Link Languages
    await prisma.examLanguage.upsert({
      where: { examId_languageId: { examId: exam.id, languageId: defaultLang.id } },
      update: {},
      create: {
        examId: exam.id,
        languageId: defaultLang.id,
        isDefault: true,
        displayOrder: 1,
      },
    });
    inc('exam_languages', true);

    if (hindiLang) {
      await prisma.examLanguage.upsert({
        where: { examId_languageId: { examId: exam.id, languageId: hindiLang.id } },
        update: {},
        create: {
          examId: exam.id,
          languageId: hindiLang.id,
          isDefault: false,
          displayOrder: 2,
        },
      });
      inc('exam_languages', true);
    }

    // Exam Scoring Rules
    const existingRule = await prisma.examScoringRule.findFirst({ where: { examId: exam.id } });
    if (!existingRule) {
      await prisma.examScoringRule.create({
        data: {
          examId: exam.id,
          marksPerQuestion: 4,
          negativeMarksPerQuestion: 1,
        },
      });
      inc('exam_scoring_rules', true);
    }

    // Ranking Config
    const existingRankConfig = await prisma.rankingConfig.findFirst({ where: { examId: exam.id } });
    if (!existingRankConfig) {
      await prisma.rankingConfig.create({
        data: {
          examId: exam.id,
          examTargetId: eData.target.id,
          rankMode: 'COMPETITION',
          percentileMethod: 'STANDARD',
          isActive: true,
        },
      });
      inc('ranking_configs', true);
    }

    // Exam Calendar Schedule
    const existingCalendar = await prisma.examCalendar.findFirst({
      where: { cycleId: examCycle.id, examId: exam.id },
    });
    if (!existingCalendar) {
      await prisma.examCalendar.create({
        data: {
          cycleId: examCycle.id,
          examId: exam.id,
          plannedDate: new Date('2026-04-10'),
          plannedStartTime: new Date('2026-04-10T10:00:00Z'),
          plannedEndTime: new Date('2026-04-10T11:00:00Z'),
          timezone: 'Asia/Kolkata',
          status: CalendarEventStatus.CONFIRMED,
        },
      });
      inc('exam_calendars', true);
    }

    // Sections & Questions
    let examQuestionsList = await prisma.examQuestion.findMany({ where: { examId: exam.id } });

    if (examQuestionsList.length === 0) {
      const questionsPerSection = Math.floor(eData.totalQuestions / eData.subjects.length);
      const usedQuestionIdsInExam = new Set<string>();

      for (let sIdx = 0; sIdx < eData.subjects.length; sIdx++) {
        const subjName = eData.subjects[sIdx];
        const subject = ctx.subjects.get(subjName) || ctx.subjects.get(eData.subjects[0])!;

        const section = await prisma.examSection.create({
          data: {
            examId: exam.id,
            subjectId: subject.id,
            name: subjName,
            totalQuestions: questionsPerSection,
            displayOrder: sIdx + 1,
          },
        });
        inc('exam_sections', true);

        // Filter questions for this subject that haven't been added to this exam
        const subjectQuestions = allQuestions.filter(
          (q) => q.subjectId === subject.id && !usedQuestionIdsInExam.has(q.id),
        );
        const fallbackQuestions = allQuestions.filter((q) => !usedQuestionIdsInExam.has(q.id));
        const candidates = subjectQuestions.length >= questionsPerSection ? subjectQuestions : fallbackQuestions;
        const questionsToUse = candidates.slice(0, questionsPerSection);

        for (let qIdx = 0; qIdx < questionsToUse.length; qIdx++) {
          const q = questionsToUse[qIdx];
          usedQuestionIdsInExam.add(q.id);

          const examQuestion = await prisma.examQuestion.create({
            data: {
              examId: exam.id,
              sectionId: section.id,
              questionId: q.id,
              displayOrder: sIdx * questionsPerSection + qIdx + 1,
              marks: 4,
              negativeMarks: 1,
            },
          });
          inc('exam_questions', true);
          examQuestionsList.push(examQuestion);
        }
      }
    }
    ctx.examQuestions.set(exam.id, examQuestionsList);

    // 3. Snapshot Version (Immutable Exam Version)
    if (!eData.isSystem) {
      let examVersion = await prisma.examVersion.findUnique({
        where: { examId_versionNumber: { examId: exam.id, versionNumber: 1 } },
      });

      if (!examVersion) {
        examVersion = await prisma.examVersion.create({
          data: {
            examId: exam.id,
            versionNumber: 1,
            status: ExamVersionStatus.PUBLISHED,
            totalQuestions: eData.totalQuestions,
            durationMinutes: eData.durationMinutes,
            totalMarks: eData.totalMarks,
            generatedById: adminUser.id,
            publishedAt: new Date('2026-04-06'),
          },
        });
        inc('exam_versions', true);

        // Create immutable snapshots of questions inside the ExamVersion
        for (let seq = 0; seq < examQuestionsList.length; seq++) {
          const eq = examQuestionsList[seq];
          const origQ = await prisma.question.findUnique({
            where: { id: eq.questionId },
            include: { options: true },
          });
          if (!origQ) continue;

          const evQ = await prisma.examVersionQuestion.create({
            data: {
              examVersionId: examVersion.id,
              sourceQuestionId: origQ.id,
              sequenceNumber: seq + 1,
              type: origQ.type,
              difficultyLevel: origQ.difficultyLevel,
              marks: eq.marks || 4,
              negativeMarks: eq.negativeMarks || 1,
              questionText: `Snapshot: Question #${seq + 1} for ${eData.title}`,
              explanation: 'Official verified explanation snapshot.',
            },
          });
          inc('exam_version_questions', true);

          for (let oIdx = 0; oIdx < origQ.options.length; oIdx++) {
            const origOpt = origQ.options[oIdx];
            await prisma.examVersionOption.create({
              data: {
                examVersionQuestionId: evQ.id,
                sourceOptionId: origOpt.id,
                displayOrder: origOpt.displayOrder,
                optionKey: origOpt.optionKey,
                optionText: origOpt.optionText || `Option ${origOpt.optionKey}`,
                isCorrect: origOpt.isCorrect,
              },
            });
            inc('exam_version_options', true);
          }
        }
      } else {
        inc('exam_versions', false);
      }
      ctx.examVersions.set(`${eData.code}:1`, examVersion);
    }
  }

  return {
    seederName: 'ExamsAndBlueprintsSeeder',
    createdCounts: created,
    reusedCounts: reused,
    timeMs: Date.now() - start,
  };
}
