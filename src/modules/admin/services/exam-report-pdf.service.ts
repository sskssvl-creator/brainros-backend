import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';

export interface ExamReportPdfData {
  student: {
    name: string;
    studentCode: string;
    email: string;
  };
  exam: {
    title: string;
    examDate?: string | Date;
    totalMarks: number;
    durationMinutes?: number;
    examTargetName?: string;
  };
  attempt: {
    id: string;
    submittedAt?: string | Date;
    score: number;
    maxScore: number;
    percentage: number;
    accuracy: number;
    totalQuestions: number;
    correctAnswers: number;
    wrongAnswers: number;
    unattempted: number;
    timeUsedSeconds?: number;
    formattedTimeUsed?: string;
    averageTimePerQuestion?: number;
    negativeMarksLost?: number;
    potentialMarks?: number;
    overallStatus?: string;
    speedAccuracyQuadrant?: string;
  };
  rank?: {
    rank?: number;
    totalCandidates?: number;
    percentile?: number;
  };
  subjects?: Array<{
    name: string;
    score: number;
    maxScore: number;
    accuracy: number;
    percentage?: number;
    correct: number;
    wrong: number;
    unattempted: number;
    timeSpentSeconds?: number;
    avgTimePerQuestionSeconds?: number;
    performanceStatus?: string;
    isStrongest?: boolean;
    isWeakest?: boolean;
  }>;
  chapters?: {
    mastered?: Array<{ name: string; subjectName?: string; accuracy: number; totalQuestions?: number; performanceStatus?: string }>;
    revisionNeeded?: Array<{ name: string; subjectName?: string; accuracy: number; totalQuestions?: number; performanceStatus?: string }>;
    criticalFocus?: Array<{ name: string; subjectName?: string; accuracy: number; totalQuestions?: number; performanceStatus?: string }>;
  };
  timeAnalysis?: {
    totalExamDurationMinutes?: number;
    totalTimeUsedSeconds?: number;
    averageTimePerQuestionSeconds?: number;
    timeOnCorrectSeconds?: number;
    timeOnWrongSeconds?: number;
    timeOnUnattemptedSeconds?: number;
    timeWastedSeconds?: number;
    fastestQuestionSeconds?: number;
    slowestQuestionSeconds?: number;
    pacingMetrics?: {
      rushedCount: number;
      optimalPaceCount: number;
      overthoughtCount: number;
    };
  };
  strategy?: {
    primaryClassification?: string;
    confidence?: string;
    whyStatement?: string;
    secondaryClassifications?: string[];
    trend?: string;
    negativeMarkingPenalty?: number;
    marksLostToGuessing?: number;
    scoreWithoutNegativeMarking?: number;
    attemptRatio?: number;
    accuracyVsSpeedProfile?: string;
    overAttemptingScore?: number;
    avoidableLossMarks?: number;
    riskCategory?: string;
    strategicTakeaways?: string[];
    potentialScoreGainMessage?: string;
    recommendations?: string[];
  };
  recommendations?: Array<{
    category?: string;
    priority?: string;
    title: string;
    description: string;
    actionStep?: string;
    impactScore?: number;
  }>;
  questionsReview?: Array<{
    displayOrder: number;
    sectionName: string;
    questionText?: string;
    isAttempted: boolean;
    isCorrect: boolean;
    marksAwarded: number;
    timeSpentSeconds?: number;
    givenAnswer?: string;
    correctAnswer?: string;
  }>;
}

@Injectable()
export class ExamReportPdfService {
  private readonly logger = new Logger(ExamReportPdfService.name);

  /**
   * Generates a comprehensive, multi-page Brainros Student Performance Report PDF.
   * Includes Overall, Subject, Chapter, Time, Strategy, Recommendations, and Question Audit.
   */
  async generateReportPdf(data: ExamReportPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          margin: 40,
          size: 'A4',
          info: {
            Title: `Brainros Exam Report - ${data.exam.title} - ${data.student.name}`,
            Author: 'Brainros Assessment Engine',
            Subject: 'Official Student Performance Analysis Report',
            Keywords: 'Brainros, Live Exam, Student Report, Analytics, Diagnostics',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => reject(err));

        // Color Palette
        const primaryColor = '#4F46E5'; // Indigo 600
        const secondaryColor = '#0F172A'; // Slate 900
        const accentEmerald = '#10B981'; // Emerald 600
        const accentRose = '#EF4444'; // Rose 500
        const accentAmber = '#F59E0B'; // Amber 500
        const lightBg = '#F8FAFC'; // Slate 50
        const borderColor = '#E2E8F0'; // Slate 200
        const mutedText = '#64748B'; // Slate 500
        const darkText = '#1E293B'; // Slate 800

        const examDateStr = data.exam.examDate
          ? new Date(data.exam.examDate).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })
          : 'Recently';

        // ═══════════════════════════════════════════════════════════════
        // PAGE 1: EXECUTIVE SUMMARY & SUBJECT-WISE PERFORMANCE
        // ═══════════════════════════════════════════════════════════════

        // 1. Header Banner
        doc.rect(40, 40, 515, 62).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text('BRAINROS', 55, 50);
        doc.fillColor('#94A3B8').fontSize(8.5).font('Helvetica').text('Official Live Exam Performance Analysis Report', 55, 76);

        doc.fillColor('#F1F5F9').fontSize(9).font('Helvetica-Bold').text(data.exam.title, 310, 52, { width: 230, align: 'right' });
        doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica').text(
          `Date: ${examDateStr}  |  Duration: ${data.exam.durationMinutes || 180}m  |  Total Marks: ${data.exam.totalMarks}`,
          310,
          76,
          { width: 230, align: 'right' },
        );

        // 2. Candidate Profile & Rank Bar
        const profileY = 115;
        doc.rect(40, profileY, 515, 48).fillAndStroke(lightBg, borderColor);

        doc.fillColor(darkText).fontSize(11).font('Helvetica-Bold').text(data.student.name, 55, profileY + 10);
        doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(
          `Student ID: ${data.student.studentCode || 'N/A'}   •   Email: ${data.student.email}`,
          55,
          profileY + 28,
        );

        if (data.rank && data.rank.rank) {
          doc.fillColor(primaryColor).fontSize(13).font('Helvetica-Bold').text(`Overall Rank: #${data.rank.rank}`, 340, profileY + 9, { width: 200, align: 'right' });
          const percentileStr = data.rank.percentile !== undefined ? `Percentile: ${Number(data.rank.percentile).toFixed(2)}%` : '';
          const totalCandStr = data.rank.totalCandidates ? ` / ${data.rank.totalCandidates.toLocaleString()} candidates` : '';
          doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`${percentileStr}${totalCandStr}`, 340, profileY + 28, { width: 200, align: 'right' });
        } else {
          doc.fillColor(mutedText).fontSize(8.5).font('Helvetica-Bold').text('Official Rank: Processing / Batch', 340, profileY + 18, { width: 200, align: 'right' });
        }

        // 3. Executive KPI Tiles (Row 1)
        const tilesY = 175;
        const tileW = 122;
        const tileH = 55;
        const gap = 9;

        // Tile 1: Score
        doc.rect(40, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('TOTAL SCORE', 48, tilesY + 9);
        doc.fillColor(primaryColor).fontSize(15).font('Helvetica-Bold').text(`${data.attempt.score} / ${data.attempt.maxScore}`, 48, tilesY + 22);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text(`${Number(data.attempt.percentage).toFixed(1)}% Marks`, 48, tilesY + 41);

        // Tile 2: Accuracy
        doc.rect(40 + (tileW + gap), tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('ACCURACY', 40 + (tileW + gap) + 8, tilesY + 9);
        doc.fillColor(accentEmerald).fontSize(15).font('Helvetica-Bold').text(`${Number(data.attempt.accuracy).toFixed(1)}%`, 40 + (tileW + gap) + 8, tilesY + 22);
        const accLabel = data.attempt.accuracy >= 75 ? 'Strong Discipline' : data.attempt.accuracy >= 50 ? 'Moderate' : 'High Guessing Risk';
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text(accLabel, 40 + (tileW + gap) + 8, tilesY + 41);

        // Tile 3: Questions
        doc.rect(40 + (tileW + gap) * 2, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('QUESTIONS BREAKDOWN', 40 + (tileW + gap) * 2 + 8, tilesY + 9);
        doc.fillColor(darkText).fontSize(11).font('Helvetica-Bold').text(
          `${data.attempt.correctAnswers} Correct  •  ${data.attempt.wrongAnswers} Wrong`,
          40 + (tileW + gap) * 2 + 8,
          tilesY + 23,
        );
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text(
          `${data.attempt.unattempted} Unattempted (Total: ${data.attempt.totalQuestions})`,
          40 + (tileW + gap) * 2 + 8,
          tilesY + 41,
        );

        // Tile 4: Time & Speed
        doc.rect(40 + (tileW + gap) * 3, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('TIME USED & SPEED', 40 + (tileW + gap) * 3 + 8, tilesY + 9);
        const timeFormatted = data.attempt.formattedTimeUsed || (data.attempt.timeUsedSeconds ? `${Math.floor(data.attempt.timeUsedSeconds / 60)}m ${data.attempt.timeUsedSeconds % 60}s` : 'N/A');
        doc.fillColor(secondaryColor).fontSize(13).font('Helvetica-Bold').text(timeFormatted, 40 + (tileW + gap) * 3 + 8, tilesY + 23);
        const avgSec = data.attempt.averageTimePerQuestion || data.timeAnalysis?.averageTimePerQuestionSeconds || 0;
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text(`Avg: ${Number(avgSec).toFixed(1)}s / question`, 40 + (tileW + gap) * 3 + 8, tilesY + 41);

        // 4. Status & Quadrant Summary Banner
        const bannerY = 240;
        doc.rect(40, bannerY, 515, 34).fillAndStroke(lightBg, borderColor);
        const statusText = data.attempt.overallStatus ? data.attempt.overallStatus.replace(/_/g, ' ') : 'EVALUATED';
        const quadrantText = data.attempt.speedAccuracyQuadrant ? data.attempt.speedAccuracyQuadrant.replace(/_/g, ' ') : 'STANDARD';
        doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text('Performance Diagnosis:', 52, bannerY + 11);
        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text(statusText, 160, bannerY + 11);
        doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`Quadrant: ${quadrantText}`, 260, bannerY + 11);
        if (data.attempt.negativeMarksLost !== undefined && data.attempt.negativeMarksLost > 0) {
          doc.fillColor(accentRose).fontSize(8).font('Helvetica-Bold').text(
            `Negative Loss: ~${data.attempt.negativeMarksLost} pts  |  Potential: ${data.attempt.potentialMarks ?? data.attempt.score} pts`,
            390,
            bannerY + 11,
            { align: 'right', width: 155 },
          );
        }

        // 5. Subject Performance Table
        let currentY = 286;
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Subject-Wise Comprehensive Analysis', 40, currentY);
        currentY += 16;

        // Table Header
        doc.rect(40, currentY, 515, 20).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold');
        doc.text('SUBJECT', 50, currentY + 6);
        doc.text('SCORE', 170, currentY + 6);
        doc.text('CORRECT', 240, currentY + 6);
        doc.text('WRONG', 300, currentY + 6);
        doc.text('SKIPPED', 355, currentY + 6);
        doc.text('ACCURACY', 415, currentY + 6);
        doc.text('STATUS', 475, currentY + 6);
        currentY += 20;

        const subjects = data.subjects && data.subjects.length > 0 ? data.subjects : [];
        if (subjects.length === 0) {
          doc.rect(40, currentY, 515, 24).fillAndStroke('#FFFFFF', borderColor);
          doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('No subject-level breakdown recorded.', 50, currentY + 7);
          currentY += 24;
        } else {
          subjects.forEach((sub, idx) => {
            const rowBg = idx % 2 === 0 ? '#FFFFFF' : lightBg;
            doc.rect(40, currentY, 515, 22).fillAndStroke(rowBg, borderColor);

            let subName = sub.name;
            if (sub.isStrongest) subName += ' ★ (Top)';
            if (sub.isWeakest) subName += ' ⚠ (Weak)';

            doc.fillColor(sub.isStrongest ? primaryColor : darkText).fontSize(8).font('Helvetica-Bold').text(subName, 50, currentY + 6);
            doc.fillColor(primaryColor).fontSize(8).font('Helvetica-Bold').text(`${sub.score} / ${sub.maxScore}`, 170, currentY + 6);
            doc.fillColor(accentEmerald).fontSize(8).font('Helvetica').text(`${sub.correct}`, 240, currentY + 6);
            doc.fillColor(accentRose).fontSize(8).font('Helvetica').text(`${sub.wrong}`, 300, currentY + 6);
            doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`${sub.unattempted}`, 355, currentY + 6);
            doc.fillColor(darkText).fontSize(8).font('Helvetica-Bold').text(`${Number(sub.accuracy || 0).toFixed(1)}%`, 415, currentY + 6);

            const st = sub.performanceStatus || (sub.accuracy >= 75 ? 'STRONG' : sub.accuracy >= 50 ? 'GOOD' : 'CRITICAL');
            const stColor = st === 'STRONG' || st === 'EXCELLENT' ? accentEmerald : st === 'GOOD' ? primaryColor : accentRose;
            doc.fillColor(stColor).fontSize(7.5).font('Helvetica-Bold').text(st, 475, currentY + 6);

            currentY += 22;
          });
        }

        // 6. Page 1 Footer Note
        const p1FooterY = 780;
        doc.rect(40, p1FooterY, 515, 0.5).fill(borderColor);
        doc.fillColor(mutedText).fontSize(7).font('Helvetica').text(
          `Page 1 of 3   •   Brainros Assessment Engine   •   Deep Diagnostics continue on Page 2`,
          40,
          p1FooterY + 6,
          { width: 515, align: 'center' },
        );

        // ═══════════════════════════════════════════════════════════════
        // PAGE 2: CHAPTER DIAGNOSIS, TIME & STRATEGY INSIGHTS
        // ═══════════════════════════════════════════════════════════════
        doc.addPage();

        // Header
        doc.rect(40, 40, 515, 38).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(13).font('Helvetica-Bold').text('BRAINROS — Diagnostic & Attempt Strategy Analysis', 55, 52);
        doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica').text(`Candidate: ${data.student.name}   |   Exam: ${data.exam.title}`, 320, 54, { width: 220, align: 'right' });

        let p2Y = 95;

        // 1. Chapter-Wise Diagnostic Performance
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Chapter Diagnosis & Concept Mastery', 40, p2Y);
        p2Y += 16;

        const masteredChapters = data.chapters?.mastered || [];
        const criticalChapters = data.chapters?.criticalFocus || data.chapters?.revisionNeeded || [];

        const colW = 252;
        const boxH = 110;

        // Left Box: Mastered Chapters
        doc.rect(40, p2Y, colW, boxH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(accentEmerald).fontSize(8.5).font('Helvetica-Bold').text('✓ Mastered & High Confidence Chapters', 50, p2Y + 9);
        if (masteredChapters.length === 0) {
          doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('No high-mastery chapters identified in this attempt.', 50, p2Y + 28);
        } else {
          let chY = p2Y + 26;
          masteredChapters.slice(0, 4).forEach((ch) => {
            doc.fillColor(darkText).fontSize(7.5).font('Helvetica-Bold').text(`• ${ch.name}`, 50, chY, { width: 155 });
            doc.fillColor(accentEmerald).fontSize(7.5).font('Helvetica-Bold').text(`${Number(ch.accuracy).toFixed(0)}% Acc`, 215, chY, { width: 70, align: 'right' });
            chY += 19;
          });
        }

        // Right Box: Critical Focus Chapters
        doc.rect(303, p2Y, colW, boxH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(accentRose).fontSize(8.5).font('Helvetica-Bold').text('⚠ High Negative / Revision Focus Areas', 313, p2Y + 9);
        if (criticalChapters.length === 0) {
          doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('No critical failure zones detected.', 313, p2Y + 28);
        } else {
          let chY = p2Y + 26;
          criticalChapters.slice(0, 4).forEach((ch) => {
            doc.fillColor(darkText).fontSize(7.5).font('Helvetica-Bold').text(`• ${ch.name}`, 313, chY, { width: 155 });
            doc.fillColor(accentRose).fontSize(7.5).font('Helvetica-Bold').text(`${Number(ch.accuracy).toFixed(0)}% Acc`, 478, chY, { width: 70, align: 'right' });
            chY += 19;
          });
        }

        p2Y += boxH + 18;

        // 2. Time Management & Pacing Analytics
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Time Management & Question Pacing Analysis', 40, p2Y);
        p2Y += 16;

        doc.rect(40, p2Y, 515, 80).fillAndStroke(lightBg, borderColor);

        const pacing = data.timeAnalysis?.pacingMetrics || { rushedCount: 0, optimalPaceCount: 0, overthoughtCount: 0 };
        const avgTimeQ = data.timeAnalysis?.averageTimePerQuestionSeconds || data.attempt.averageTimePerQuestion || 0;

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('Pacing Distribution', 52, p2Y + 10);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Optimal Pace: ${pacing.optimalPaceCount} questions`, 52, p2Y + 28);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Rushed (<20s): ${pacing.rushedCount} questions`, 52, p2Y + 44);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Overthought: ${pacing.overthoughtCount} questions`, 52, p2Y + 60);

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('Speed Benchmarks', 220, p2Y + 10);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Average Time / Question: ${Number(avgTimeQ).toFixed(1)}s`, 220, p2Y + 28);
        const timeCorr = data.timeAnalysis?.timeOnCorrectSeconds ? `${Math.round(data.timeAnalysis.timeOnCorrectSeconds)}s` : 'N/A';
        const timeWrong = data.timeAnalysis?.timeOnWrongSeconds ? `${Math.round(data.timeAnalysis.timeOnWrongSeconds)}s` : 'N/A';
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Time on Correct Answers: ${timeCorr}`, 220, p2Y + 44);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Time on Wrong Answers: ${timeWrong}`, 220, p2Y + 60);

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('Pacing Extremes', 390, p2Y + 10);
        const fastSec = data.timeAnalysis?.fastestQuestionSeconds !== undefined ? `${data.timeAnalysis.fastestQuestionSeconds}s` : 'N/A';
        const slowSec = data.timeAnalysis?.slowestQuestionSeconds !== undefined ? `${data.timeAnalysis.slowestQuestionSeconds}s` : 'N/A';
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Fastest Response: ${fastSec}`, 390, p2Y + 28);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(`Slowest Response: ${slowSec}`, 390, p2Y + 44);
        const timeWasted = data.timeAnalysis?.timeWastedSeconds ? `${Math.round(data.timeAnalysis.timeWastedSeconds / 60)}m wasted` : 'Low time waste';
        doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`Time Waste Index: ${timeWasted}`, 390, p2Y + 60);

        p2Y += 98;

        // 3. Attempt Strategy & Negative Marking Penalty
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Attempt Strategy & AI Diagnostic Analysis', 40, p2Y);
        p2Y += 16;

        const stratDiagH = data.strategy?.whyStatement ? 115 : 90;
        doc.rect(40, p2Y, 515, stratDiagH).fillAndStroke(lightBg, borderColor);

        const negPenalty = data.strategy?.negativeMarkingPenalty ?? data.strategy?.avoidableLossMarks ?? (data.attempt.wrongAnswers * 1);
        const potScore = data.strategy?.scoreWithoutNegativeMarking ?? (data.attempt.score + negPenalty);
        const riskProf = (data.strategy?.primaryClassification || data.strategy?.riskCategory || (data.attempt.accuracy < 60 ? 'HIGH_RISK' : 'BALANCED')).replace(/_/g, ' ');

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('AI Strategy Classification', 52, p2Y + 10);
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text(riskProf, 52, p2Y + 24);
        if (data.strategy?.confidence) {
          doc.fillColor(primaryColor).fontSize(7.5).font('Helvetica-Bold').text(`[Confidence: ${data.strategy.confidence}]`, 52, p2Y + 40);
        }

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('Negative Marking Diagnostic', 220, p2Y + 10);
        doc.fillColor(accentRose).fontSize(12).font('Helvetica-Bold').text(`-${negPenalty} Marks Lost`, 220, p2Y + 24);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('Avoidable Negative Loss', 220, p2Y + 40);

        doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold').text('Projected Potential Score', 380, p2Y + 10);
        doc.fillColor(accentEmerald).fontSize(12).font('Helvetica-Bold').text(`${potScore} / ${data.attempt.maxScore}`, 380, p2Y + 24);
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('If wrong guesses were skipped', 380, p2Y + 40);

        const gainMsg = data.strategy?.whyStatement || data.strategy?.potentialScoreGainMessage || `Eliminating low-confidence guesses could recover approximately ~${negPenalty} marks.`;
        doc.rect(52, p2Y + 58, 491, stratDiagH - 66).fill('#EEF2FF');
        doc.fillColor(primaryColor).fontSize(7.5).font('Helvetica-Bold').text('AI Diagnostic Insight:', 60, p2Y + 63);
        doc.fillColor(darkText).fontSize(7.5).font('Helvetica').text(gainMsg, 160, p2Y + 63, { width: 375, height: stratDiagH - 74 });

        // Page 2 Footer
        const p2FooterY = 780;
        doc.rect(40, p2FooterY, 515, 0.5).fill(borderColor);
        doc.fillColor(mutedText).fontSize(7).font('Helvetica').text(
          `Page 2 of Report   •   Brainros Assessment Engine   •   Actionable Recommendations & Audit continue on next page`,
          40,
          p2FooterY + 6,
          { width: 515, align: 'center' },
        );

        // ═══════════════════════════════════════════════════════════════
        // PAGE 3+: RECOMMENDATIONS & QUESTION-BY-QUESTION AUDIT
        // ═══════════════════════════════════════════════════════════════
        doc.addPage();

        // Header
        doc.rect(40, 40, 515, 38).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(13).font('Helvetica-Bold').text('BRAINROS — Personalized Recommendations & Question Audit', 55, 52);
        doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica').text(`Candidate: ${data.student.name}`, 320, 54, { width: 220, align: 'right' });

        let p3Y = 95;

        // 1. Actionable Recommendations
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Actionable Performance Recommendations', 40, p3Y);
        p3Y += 16;

        const recs = data.recommendations && data.recommendations.length > 0
          ? data.recommendations
          : [
              {
                priority: 'HIGH',
                title: 'Eliminate Negative Guessing in Low-Confidence Sections',
                description: 'A significant portion of score loss came from wrong attempts. Skip uncertain questions during Phase 1.',
                actionStep: 'Adopt the 2-Round exam attempt strategy: complete confident questions first before attempting moderate ones.',
              },
              {
                priority: 'MEDIUM',
                title: 'Strengthen Concept Clarity in Critical Focus Chapters',
                description: 'Review foundational theory and practice standard difficulty problems in marked weak chapters.',
                actionStep: 'Complete 20-30 targeted practice problems daily in chapters with under 50% accuracy.',
              },
            ];

        recs.slice(0, 3).forEach((rec) => {
          doc.rect(40, p3Y, 515, 48).fillAndStroke(lightBg, borderColor);

          const prioColor = rec.priority === 'HIGH' ? accentRose : rec.priority === 'MEDIUM' ? accentAmber : primaryColor;
          doc.rect(48, p3Y + 8, 42, 14).fill(prioColor);
          doc.fillColor('#FFFFFF').fontSize(6.5).font('Helvetica-Bold').text((rec.priority || 'NORMAL').toUpperCase(), 50, p3Y + 11, { width: 38, align: 'center' });

          doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text(rec.title, 98, p3Y + 8);
          doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text(rec.description, 98, p3Y + 22, { width: 445 });
          if (rec.actionStep) {
            doc.fillColor(primaryColor).fontSize(7.5).font('Helvetica-Bold').text(`Action: ${rec.actionStep}`, 98, p3Y + 34, { width: 445 });
          }

          p3Y += 56;
        });

        p3Y += 10;

        // 2. Question-by-Question Response Audit Summary Table
        doc.fillColor(secondaryColor).fontSize(11).font('Helvetica-Bold').text('Question-by-Question Response Audit Breakdown', 40, p3Y);
        p3Y += 16;

        const drawTableHeader = (yPos: number) => {
          doc.rect(40, yPos, 515, 18).fill(secondaryColor);
          doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold');
          doc.text('Q#', 48, yPos + 5);
          doc.text('SECTION', 78, yPos + 5);
          doc.text('STATUS', 185, yPos + 5);
          doc.text('ANSWER DETAILS', 255, yPos + 5);
          doc.text('TIME', 440, yPos + 5);
          doc.text('MARKS', 490, yPos + 5);
          return yPos + 18;
        };

        const reviews = data.questionsReview || [];
        if (reviews.length === 0) {
          doc.rect(40, p3Y, 515, 24).fillAndStroke('#FFFFFF', borderColor);
          doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Detailed question audit recorded in student portal review.', 50, p3Y + 7);
          p3Y += 24;
        } else {
          p3Y = drawTableHeader(p3Y);

          reviews.forEach((q, idx) => {
            if (p3Y > 735) {
              doc.addPage();
              doc.rect(40, 40, 515, 38).fill(secondaryColor);
              doc.fillColor('#FFFFFF').fontSize(13).font('Helvetica-Bold').text('BRAINROS — Question Audit (Continued)', 55, 52);
              doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica').text(`Candidate: ${data.student.name}`, 320, 54, { width: 220, align: 'right' });
              p3Y = drawTableHeader(95);
            }

            const rowBg = idx % 2 === 0 ? '#FFFFFF' : lightBg;
            const rowHeight = 20;
            doc.rect(40, p3Y, 515, rowHeight).fillAndStroke(rowBg, borderColor);

            doc.fillColor(darkText).fontSize(7.5).font('Helvetica-Bold').text(`Q${q.displayOrder || idx + 1}`, 48, p3Y + 5);
            doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text((q.sectionName || 'General').slice(0, 16), 78, p3Y + 5);

            if (!q.isAttempted) {
              doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('— Skipped', 185, p3Y + 5);
            } else if (q.isCorrect) {
              doc.fillColor(accentEmerald).fontSize(7.5).font('Helvetica-Bold').text('✓ Correct', 185, p3Y + 5);
            } else {
              doc.fillColor(accentRose).fontSize(7.5).font('Helvetica-Bold').text('✗ Incorrect', 185, p3Y + 5);
            }

            const ansDetail = q.givenAnswer
              ? `Ans: ${q.givenAnswer.slice(0, 18)}${q.correctAnswer ? ` (Correct: ${q.correctAnswer.slice(0, 14)})` : ''}`
              : (q.correctAnswer ? `Correct: ${q.correctAnswer.slice(0, 24)}` : '—');
            doc.fillColor(darkText).fontSize(7).font('Helvetica').text(ansDetail, 255, p3Y + 5, { width: 175 });

            const qTimeStr = q.timeSpentSeconds ? `${q.timeSpentSeconds}s` : '—';
            doc.fillColor(darkText).fontSize(7.5).font('Helvetica').text(qTimeStr, 440, p3Y + 5);

            const marksStr = q.marksAwarded !== undefined ? (q.marksAwarded > 0 ? `+${q.marksAwarded}` : `${q.marksAwarded}`) : '0';
            doc.fillColor(q.marksAwarded > 0 ? accentEmerald : q.marksAwarded < 0 ? accentRose : mutedText).fontSize(7.5).font('Helvetica-Bold').text(marksStr, 490, p3Y + 5);

            p3Y += rowHeight;
          });
        }

        // Official Verification Footer
        const p3FooterY = 770;
        doc.rect(40, p3FooterY, 515, 0.5).fill(borderColor);
        doc.fillColor(mutedText).fontSize(7).font('Helvetica').text(
          `Brainros Exam Management System  •  Automated Performance Audit  •  Generated on ${new Date().toLocaleString('en-IN')}  •  Strictly Confidential`,
          40,
          p3FooterY + 6,
          { width: 515, align: 'center' },
        );

        doc.end();
      } catch (err) {
        this.logger.error(`[ExamReportPdfService] Failed to generate PDF: ${err.message}`, err.stack);
        reject(err);
      }
    });
  }
}
