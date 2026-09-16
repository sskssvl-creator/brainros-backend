import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ParsedExamPaperRow,
  ExamPaperValidationResult,
  ExamPaperValidationError,
} from '../dto/exam-manager.dto';

const VALID_QUESTION_TYPES = new Set([
  'SINGLE_CORRECT',
  'MULTIPLE_CORRECT',
  'NUMERICAL',
  'ASSERTION_REASON',
  'MATCH_FOLLOWING',
  'CASE_BASED',
]);

const VALID_DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'HARD', 'VERY_HARD']);

@Injectable()
export class ExamPaperValidatorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate entire parsed question paper dataset
   */
  async validatePaper(
    rows: ParsedExamPaperRow[],
  ): Promise<ExamPaperValidationResult> {
    const errors: ExamPaperValidationError[] = [];
    const warnings: string[] = [];

    if (!rows || rows.length === 0) {
      return {
        isValid: false,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        examCount: 0,
        examCode: '',
        examTitle: '',
        durationMinutes: 0,
        totalMarks: 0,
        totalQuestions: 0,
        sections: [],
        errors: [{ row: 0, message: 'Spreadsheet contains no data rows.' }],
        warnings: [],
        validatedRows: [],
      };
    }

    // 1. Build academic cache for fast lookup
    const [examTargets, subjects, languages] = await Promise.all([
      this.prisma.examTarget.findMany({ select: { id: true, name: true } }),
      this.prisma.subject.findMany({
        select: { id: true, name: true },
      }),
      this.prisma.preferredLanguage.findMany({
        select: { id: true, code: true, name: true },
      }),
    ]);

    const targetMap = new Map(
      examTargets.map((t) => [t.name.toUpperCase(), t]),
    );
    const subjectMap = new Map(
      subjects.map((s) => [s.name.toUpperCase(), s]),
    );
    const langMap = new Map(
      languages.map((l) => [(l.code || '').toLowerCase(), l]),
    );

    // Primary exam metadata from first row
    const firstRow = rows[0];
    const examCode = (firstRow.examCode || 'EXAM-PAPER').trim().toUpperCase();
    const examTitle = (firstRow.examName || 'Imported Question Paper').trim();
    const durationMinutes = firstRow.durationMinutes || 200;

    let calculatedTotalMarks = 0;
    const sectionMap = new Map<string, { name: string; subject: string; questionCount: number }>();
    const seenQuestionTexts = new Set<string>();
    const seenQuestionNumbers = new Set<number>();

    const validatedRows: Array<{
      rowNumber: number;
      isValid: boolean;
      errors: string[];
      warnings: string[];
      data: ParsedExamPaperRow;
    }> = [];

    let validRowCount = 0;
    let invalidRowCount = 0;

    for (const row of rows) {
      const rowErrors: string[] = [];
      const rowWarnings: string[] = [];

      // 1. Validate Question Number
      if (
        row.questionNumber === undefined ||
        row.questionNumber === null ||
        isNaN(row.questionNumber) ||
        row.questionNumber <= 0
      ) {
        rowErrors.push('Valid Question Number (question_number) is required.');
      } else {
        if (seenQuestionNumbers.has(row.questionNumber)) {
          rowErrors.push(`Duplicate question number: ${row.questionNumber}.`);
        } else {
          seenQuestionNumbers.add(row.questionNumber);
        }
      }

      // 2. Validate Question Text
      const qText = (row.questionText || '').trim();
      if (!qText) {
        rowErrors.push('Question statement (question) is required.');
      } else {
        if (seenQuestionTexts.has(qText.toLowerCase())) {
          rowWarnings.push('Duplicate question statement in same question paper.');
        } else {
          seenQuestionTexts.add(qText.toLowerCase());
        }
      }

      // 3. Validate Options (A, B, C, D)
      const optA = (row.optionA || '').trim();
      const optB = (row.optionB || '').trim();
      const optC = (row.optionC || '').trim();
      const optD = (row.optionD || '').trim();

      if (!optA || !optB) {
        rowErrors.push('Option A (option_a) and Option B (option_b) are required.');
      }
      if (!optC && !optD) {
        rowWarnings.push('Option C and Option D are missing for this question.');
      }

      // 4. Validate Correct Answer (A, B, C, D) if provided
      const rawAns = (row.correctAnswer || '').trim().toUpperCase();
      const qNumLabel = row.questionNumber ? `question ${row.questionNumber}` : `row ${row.rowNumber}`;
      const qType = (row.questionType || 'SINGLE_CORRECT').toUpperCase();

      if (rawAns) {
        if (qType === 'SINGLE_CORRECT') {
          if (!['A', 'B', 'C', 'D'].includes(rawAns)) {
            rowErrors.push(
              `Invalid correct answer '${row.correctAnswer}' for ${qNumLabel}. Must be one of A, B, C, D.`,
            );
          } else {
            if (rawAns === 'A' && !optA) {
              rowErrors.push(`Option A is empty but Correct Answer is A for ${qNumLabel}.`);
            } else if (rawAns === 'B' && !optB) {
              rowErrors.push(`Option B is empty but Correct Answer is B for ${qNumLabel}.`);
            } else if (rawAns === 'C' && !optC) {
              rowErrors.push(`Option C is empty but Correct Answer is C for ${qNumLabel}.`);
            } else if (rawAns === 'D' && !optD) {
              rowErrors.push(`Option D is empty but Correct Answer is D for ${qNumLabel}.`);
            }
          }
        } else if (qType === 'NUMERICAL') {
          if (isNaN(Number(rawAns))) {
            rowErrors.push(`Numerical answer required for ${qNumLabel}.`);
          }
        }
      }

      const marks = row.marks !== undefined ? row.marks : 4.0;
      calculatedTotalMarks += marks;

      // Track Section
      const sectionKey = `${row.subject || 'General'}::${
        row.sectionName || `${row.subject || 'General'} Section`
      }`;
      if (!sectionMap.has(sectionKey)) {
        sectionMap.set(sectionKey, {
          name: row.sectionName || `${row.subject || 'General'} Section`,
          subject: row.subject || 'General',
          questionCount: 0,
        });
      }
      sectionMap.get(sectionKey)!.questionCount++;

      if (rowErrors.length > 0) {
        invalidRowCount++;
        rowErrors.forEach((err) => {
          errors.push({
            row: row.rowNumber,
            message: err,
          });
        });
      } else {
        validRowCount++;
      }

      validatedRows.push({
        rowNumber: row.rowNumber,
        isValid: rowErrors.length === 0,
        errors: rowErrors,
        warnings: rowWarnings,
        data: row,
      });
    }

    const sections = Array.from(sectionMap.values());
    const isValid = errors.length === 0;

    return {
      isValid,
      totalRows: rows.length,
      validRows: validRowCount,
      invalidRows: invalidRowCount,
      examCount: 1,
      examCode: examCode || 'EXAM-PAPER',
      examTitle: examTitle || 'Imported Question Paper',
      durationMinutes,
      totalMarks: firstRow.totalMarks || calculatedTotalMarks,
      totalQuestions: rows.length,
      sections,
      errors,
      warnings,
      validatedRows,
    };
  }
}
