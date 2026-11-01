import { Test, TestingModule } from '@nestjs/testing';
import { AiTranslationService } from '../services/ai-translation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiTranslationFileParserService } from '../services/ai-translation-file-parser.service';
import { AiTranslationValidatorService } from '../services/ai-translation-validator.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  AI_TRANSLATION_QUEUE,
  AI_TRANSLATION_LANGUAGE_QUEUE,
} from '../constants/ai-translation.constants';

describe('AiTranslationService - Whole Question Paper Print Engine', () => {
  let service: AiTranslationService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      aiTranslationJob: {
        findUnique: jest.fn(),
      },
      exam: {
        findUnique: jest.fn(),
      },
      examVersion: {
        findUnique: jest.fn(),
      },
      preferredLanguage: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'lang-en', code: 'en', name: 'English' },
          { id: 'lang-gu', code: 'gu', name: 'Gujarati' },
        ]),
      },
      examVersionQuestion: {
        findMany: jest.fn(),
      },
      question: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiTranslationService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiTranslationFileParserService, useValue: {} },
        { provide: AiTranslationValidatorService, useValue: {} },
        { provide: JobProgressService, useValue: {} },
        { provide: getQueueToken(AI_TRANSLATION_QUEUE), useValue: { add: jest.fn() } },
        { provide: getQueueToken(AI_TRANSLATION_LANGUAGE_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = module.get<AiTranslationService>(AiTranslationService);
  });

  it('generates a complete multi-page printable HTML document containing all questions in English', async () => {
    const jobId = 'job-print-1';
    prisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId: 'exam-1',
      examVersionId: 'ver-1',
    });

    prisma.exam.findUnique.mockResolvedValue({
      id: 'exam-1',
      title: 'JEE Advanced National Mock Test 2026',
      durationMinutes: 180,
      examTarget: { name: 'Engineering / JEE' },
    });

    prisma.examVersion.findUnique.mockResolvedValue({
      id: 'ver-1',
      totalMarks: 300,
      durationMinutes: 180,
    });

    prisma.examVersionQuestion.findMany.mockResolvedValue([
      {
        id: 'evq-1',
        sourceQuestionId: 'q-1',
        sequenceNumber: 1,
        subjectName: 'Physics',
        sectionName: 'Section 1',
        marks: 4,
        negativeMarks: 1,
        questionText: 'Find the magnetic field at the center of the ring.',
        passage: null,
        assertion: null,
        reason: null,
        options: [
          {
            id: 'opt-1',
            optionKey: 'A',
            optionLabel: 'A',
            optionText: 'Zero',
            translations: [],
          },
          {
            id: 'opt-2',
            optionKey: 'B',
            optionLabel: 'B',
            optionText: 'mu_0 * I / (2 * R)',
            translations: [],
          },
        ],
        translations: [],
      },
      {
        id: 'evq-2',
        sourceQuestionId: 'q-2',
        sequenceNumber: 2,
        subjectName: 'Chemistry',
        sectionName: 'Section 2',
        marks: 4,
        negativeMarks: 1,
        questionText: 'Which orbital has zero angular momentum?',
        passage: null,
        assertion: null,
        reason: null,
        options: [
          {
            id: 'opt-3',
            optionKey: 'A',
            optionLabel: 'A',
            optionText: 's-orbital',
            translations: [],
          },
        ],
        translations: [],
      },
    ]);

    prisma.question.findMany.mockResolvedValue([]);

    const html = await service.generatePrintableQuestionPaperHtml(jobId, 'lang-en', 'en');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('JEE Advanced National Mock Test 2026');
    expect(html).toContain('English');
    expect(html).toContain('@media print');
    expect(html).toContain('page-break-inside: avoid');
    expect(html).toContain('katex');
    // Verifies all questions appear in the paper
    expect(html).toContain('Find the magnetic field at the center of the ring.');
    expect(html).toContain('Which orbital has zero angular momentum?');
    expect(html).toContain('s-orbital');
    expect(html).toContain('Question 1');
    expect(html).toContain('Question 2');
  });

  it('generates a printable HTML document in Gujarati using Gujarati translations and master English fallback', async () => {
    const jobId = 'job-print-2';
    prisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId: 'exam-2',
      examVersionId: 'ver-2',
    });

    prisma.exam.findUnique.mockResolvedValue({
      id: 'exam-2',
      title: 'Gujarat Board Mock Exam',
      durationMinutes: 120,
    });

    prisma.examVersion.findUnique.mockResolvedValue({
      id: 'ver-2',
      totalMarks: 100,
      durationMinutes: 120,
    });

    prisma.examVersionQuestion.findMany.mockResolvedValue([
      {
        id: 'evq-3',
        sourceQuestionId: 'q-3',
        sequenceNumber: 1,
        questionText: 'What is light?',
        options: [
          {
            id: 'opt-4',
            optionKey: 'A',
            optionLabel: 'A',
            optionText: 'Light is electromagnetic radiation',
            translations: [
              { languageId: 'lang-gu', languageCode: 'gu', optionText: 'પ્રકાશ વિદ્યુતચુંબકીય કિરણોત્સર્ગ છે' },
            ],
          },
        ],
        translations: [
          { languageId: 'lang-gu', languageCode: 'gu', questionText: 'પ્રકાશ શું છે?' },
        ],
      },
    ]);

    prisma.question.findMany.mockResolvedValue([]);

    const html = await service.generatePrintableQuestionPaperHtml(jobId, 'lang-gu', 'gu');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('lang="gu"');
    expect(html).toContain('પ્રકાશ શું છે?');
    expect(html).toContain('પ્રકાશ વિદ્યુતચુંબકીય કિરણોત્સર્ગ છે');
  });
});
