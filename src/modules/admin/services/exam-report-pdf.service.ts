import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';

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
    strongestSubject?: {
      name: string;
      accuracy: number;
      score: number;
      maxScore: number;
      correct: number;
      wrong: number;
      timeSpentSeconds?: number;
      avgSpeedSeconds?: number;
    };
    weakestSubject?: {
      name: string;
      accuracy: number;
      score: number;
      maxScore: number;
      correct: number;
      wrong: number;
      timeSpentSeconds?: number;
      avgSpeedSeconds?: number;
    };
  };
  rank?: {
    rank?: number;
    totalCandidates?: number;
    percentile?: number;
  };
  ranks?: {
    overall?: {
      rank?: number;
      totalCandidates?: number;
      percentile?: number;
    };
    state?: {
      rank?: number;
      totalCandidates?: number;
      percentile?: number;
      scopeName?: string;
    };
    district?: {
      rank?: number;
      totalCandidates?: number;
      percentile?: number;
      scopeName?: string;
    };
    school?: {
      rank?: number;
      totalCandidates?: number;
      percentile?: number;
      scopeName?: string;
    };
    category?: {
      rank?: number;
      totalCandidates?: number;
      percentile?: number;
      scopeName?: string;
    };
    predictedRank?: {
      min: number;
      max: number;
      confidence?: string;
    };
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
    questionType?: string;
    isAttempted: boolean;
    isCorrect: boolean;
    marksAwarded: number;
    negativeMarks?: number;
    timeSpentSeconds?: number;
    explanation?: string;
    options: Array<{
      id: string;
      optionLabel: string;
      optionKey?: string;
      optionText: string;
      isCorrect: boolean;
    }>;
    studentAnswer?: {
      selectedOptionId?: string;
      selectedOptionLabel?: string;
      selectedOptionText?: string;
      numericalAnswer?: number | null;
    };
    correctAnswer?: {
      optionLabel?: string;
      optionText?: string;
    };
  }>;
}

@Injectable()
export class ExamReportPdfService {
  private readonly logger = new Logger(ExamReportPdfService.name);

  /**
   * Generates a comprehensive, multi-page Brainros Student Performance Report PDF.
   * Includes Overall KPI Scorecard, Strongest/Weakest Subject Highlights, Subject Breakdown,
   * Granular Ranks & Percentiles, Chapter Diagnosis, Time & Pacing Analytics,
   * Attempt Strategy, Smart Actionable Recommendations, and Complete Question-by-Question Solution Review.
   */
  async generateReportPdf(data: ExamReportPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          margin: 40,
          size: 'A4',
          bufferPages: true,
          info: {
            Title: `Brainros Exam Report - ${data.exam.title} - ${data.student.name}`,
            Author: 'Brainros Assessment Engine',
            Subject: 'Official Student Performance Analysis & Diagnostic Report',
            Keywords: 'Brainros, Live Exam, Student Report, Analytics, Diagnostics, Solution Review',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => {
          try {
            // Apply dynamic footers across all buffered pages
            const totalPages = doc.bufferedPageRange().count;
            for (let i = 0; i < totalPages; i++) {
              doc.switchToPage(i);
              this.drawPageFooter(doc, i + 1, totalPages);
            }
            doc.flushPages();
            resolve(Buffer.concat(buffers));
          } catch (footerErr) {
            reject(footerErr);
          }
        });
        doc.on('error', (err) => reject(err));

        // Font discovery with Indian / Unicode fallback support
        const fontRegular = this.resolveFont(false);
        const fontBold = this.resolveFont(true);
        const isCustomFont = fontRegular !== 'Helvetica';
        if (isCustomFont) {
          doc.registerFont('AppRegular', fontRegular);
          doc.registerFont('AppBold', fontBold);
        }
        const fRegular = isCustomFont ? 'AppRegular' : 'Helvetica';
        const fBold = isCustomFont ? 'AppBold' : 'Helvetica-Bold';

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
        doc.fillColor('#FFFFFF').fontSize(20).font(fBold).text('BRAINROS', 55, 50);
        doc.fillColor('#94A3B8').fontSize(8.5).font(fRegular).text('Official Live Exam Performance Analysis & Diagnostics', 55, 76);

        const targetBadge = data.exam.examTargetName ? ` [Target: ${data.exam.examTargetName}]` : '';
        doc.fillColor('#F1F5F9').fontSize(9.5).font(fBold).text(`${data.exam.title}${targetBadge}`, 290, 52, { width: 250, align: 'right' });
        doc.fillColor('#94A3B8').fontSize(7.5).font(fRegular).text(
          `Date: ${examDateStr}  |  Duration: ${data.exam.durationMinutes || 180}m  |  Total Marks: ${data.exam.totalMarks}`,
          290,
          76,
          { width: 250, align: 'right' },
        );

        // 2. Candidate Profile & Overall Rank Bar
        const profileY = 112;
        doc.rect(40, profileY, 515, 46).fillAndStroke(lightBg, borderColor);

        doc.fillColor(darkText).fontSize(10.5).font(fBold).text(data.student.name, 55, profileY + 9);
        doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(
          `Student ID: ${data.student.studentCode || 'N/A'}   •   Email: ${data.student.email}`,
          55,
          profileY + 26,
        );

        const primaryRank = data.ranks?.overall?.rank || data.rank?.rank;
        const primaryPercentile = data.ranks?.overall?.percentile ?? data.rank?.percentile;
        const primaryCandidates = data.ranks?.overall?.totalCandidates || data.rank?.totalCandidates;

        if (primaryRank) {
          doc.fillColor(primaryColor).fontSize(12).font(fBold).text(`Overall Rank: #${primaryRank}`, 340, profileY + 8, { width: 200, align: 'right' });
          const percentileStr = primaryPercentile !== undefined ? `Percentile: ${Number(primaryPercentile).toFixed(2)}%` : '';
          const totalCandStr = primaryCandidates ? ` / ${primaryCandidates.toLocaleString()} candidates` : '';
          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(`${percentileStr}${totalCandStr}`, 340, profileY + 26, { width: 200, align: 'right' });
        } else {
          doc.fillColor(mutedText).fontSize(8).font(fBold).text('Official Rank: Finalizing Snapshot', 340, profileY + 16, { width: 200, align: 'right' });
        }

        // 3. Executive KPI Tiles (Row 1)
        const tilesY = 168;
        const tileW = 122;
        const tileH = 54;
        const gap = 9;

        // Tile 1: Score
        doc.rect(40, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7).font(fBold).text('TOTAL MARKS OBTAINED', 48, tilesY + 8);
        doc.fillColor(primaryColor).fontSize(14).font(fBold).text(`${data.attempt.score} / ${data.attempt.maxScore}`, 48, tilesY + 21);
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text(`${Number(data.attempt.percentage).toFixed(1)}% Marks`, 48, tilesY + 39);

        // Tile 2: Accuracy
        doc.rect(40 + (tileW + gap), tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7).font(fBold).text('ACCURACY', 40 + (tileW + gap) + 8, tilesY + 8);
        doc.fillColor(accentEmerald).fontSize(14).font(fBold).text(`${Number(data.attempt.accuracy).toFixed(1)}%`, 40 + (tileW + gap) + 8, tilesY + 21);
        const accLabel = data.attempt.accuracy >= 75 ? 'Strong Discipline' : data.attempt.accuracy >= 50 ? 'Moderate Accuracy' : 'High Guessing Risk';
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text(accLabel, 40 + (tileW + gap) + 8, tilesY + 39);

        // Tile 3: Questions
        doc.rect(40 + (tileW + gap) * 2, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7).font(fBold).text('QUESTION BREAKDOWN', 40 + (tileW + gap) * 2 + 8, tilesY + 8);
        doc.fillColor(darkText).fontSize(10.5).font(fBold).text(
          `${data.attempt.correctAnswers} Correct • ${data.attempt.wrongAnswers} Wrong`,
          40 + (tileW + gap) * 2 + 8,
          tilesY + 22,
        );
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text(
          `${data.attempt.unattempted} Skipped (Total: ${data.attempt.totalQuestions})`,
          40 + (tileW + gap) * 2 + 8,
          tilesY + 39,
        );

        // Tile 4: Time & Speed
        doc.rect(40 + (tileW + gap) * 3, tilesY, tileW, tileH).fillAndStroke(lightBg, borderColor);
        doc.fillColor(mutedText).fontSize(7).font(fBold).text('TIME USED & SPEED', 40 + (tileW + gap) * 3 + 8, tilesY + 8);
        const timeFormatted = data.attempt.formattedTimeUsed || (data.attempt.timeUsedSeconds ? `${Math.floor(data.attempt.timeUsedSeconds / 60)}m ${data.attempt.timeUsedSeconds % 60}s` : 'N/A');
        doc.fillColor(secondaryColor).fontSize(12.5).font(fBold).text(timeFormatted, 40 + (tileW + gap) * 3 + 8, tilesY + 22);
        const avgSec = data.attempt.averageTimePerQuestion || data.timeAnalysis?.averageTimePerQuestionSeconds || 0;
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text(`Avg: ${Number(avgSec).toFixed(1)}s / question`, 40 + (tileW + gap) * 3 + 8, tilesY + 39);

        // 4. Performance Diagnosis & Speed-Accuracy Banner
        const bannerY = 230;
        doc.rect(40, bannerY, 515, 32).fillAndStroke(lightBg, borderColor);
        const statusText = data.attempt.overallStatus ? data.attempt.overallStatus.replace(/_/g, ' ') : 'EVALUATED';
        const quadrantText = data.attempt.speedAccuracyQuadrant ? data.attempt.speedAccuracyQuadrant.replace(/_/g, ' ') : 'Fast & Accurate (Optimal)';
        doc.fillColor(darkText).fontSize(8).font(fBold).text('Assessment Diagnosis:', 50, bannerY + 10);
        doc.fillColor(primaryColor).fontSize(8).font(fBold).text(statusText, 150, bannerY + 10);
        doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(`Strategy Profile: ${quadrantText}`, 235, bannerY + 10);
        const negPenalty = data.attempt.negativeMarksLost ?? (data.strategy?.negativeMarkingPenalty ?? (data.attempt.wrongAnswers * 1));
        const potScore = data.attempt.potentialMarks ?? (data.strategy?.scoreWithoutNegativeMarking ?? (data.attempt.score + negPenalty));
        doc.fillColor(accentRose).fontSize(7.5).font(fBold).text(
          `Negative Penalty: -${negPenalty} Marks  |  Potential: ${potScore} Marks`,
          370,
          bannerY + 10,
          { align: 'right', width: 175 },
        );

        // 5. Strongest & Weakest Subject Highlights (Matches UI Card)
        let currentY = 270;
        const strongest = data.attempt.strongestSubject || (data.subjects && data.subjects.find((s) => s.isStrongest));
        const weakest = data.attempt.weakestSubject || (data.subjects && data.subjects.length > 1 ? data.subjects.find((s) => s.isWeakest) : undefined);

        if (strongest) {
          const cardH = 50;
          const cardW = weakest ? 252 : 515;

          // Strongest Subject Box
          doc.rect(40, currentY, cardW, cardH).fillAndStroke('#ECFDF5', '#A7F3D0');
          doc.fillColor(accentEmerald).fontSize(7.5).font(fBold).text('★ STRONGEST SUBJECT', 50, currentY + 8);
          doc.fillColor(accentEmerald).fontSize(7.5).font(fBold).text(`${Number(strongest.accuracy || 0).toFixed(1)}% Accuracy`, 40 + cardW - 120, currentY + 8, { width: 110, align: 'right' });
          doc.fillColor(darkText).fontSize(11).font(fBold).text(strongest.name, 50, currentY + 20);
          const strongDetails = `Score: ${strongest.score}/${strongest.maxScore} Marks • ${strongest.correct} Correct, ${strongest.wrong} Wrong • Time: ${strongest.timeSpentSeconds ? Math.round(strongest.timeSpentSeconds / 60) : 0} mins`;
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text(strongDetails, 50, currentY + 36);

          // Weakest Subject Box (if exists)
          if (weakest && weakest.name !== strongest.name) {
            doc.rect(303, currentY, cardW, cardH).fillAndStroke('#FFF1F2', '#FECDD3');
            doc.fillColor(accentRose).fontSize(7.5).font(fBold).text('⚠ CRITICAL ATTENTION SUBJECT', 313, currentY + 8);
            doc.fillColor(accentRose).fontSize(7.5).font(fBold).text(`${Number(weakest.accuracy || 0).toFixed(1)}% Accuracy`, 303 + cardW - 120, currentY + 8, { width: 110, align: 'right' });
            doc.fillColor(darkText).fontSize(11).font(fBold).text(weakest.name, 313, currentY + 20);
            const weakDetails = `Score: ${weakest.score}/${weakest.maxScore} Marks • ${weakest.correct} Correct, ${weakest.wrong} Wrong • Focus Chapter Revision`;
            doc.fillColor(mutedText).fontSize(7).font(fRegular).text(weakDetails, 313, currentY + 36);
          }

          currentY += cardH + 12;
        }

        // 6. Complete Subject Performance Breakdown Table
        doc.fillColor(secondaryColor).fontSize(10.5).font(fBold).text('Subject Performance Breakdown', 40, currentY);
        currentY += 14;

        // Table Header
        doc.rect(40, currentY, 515, 19).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(7).font(fBold);
        doc.text('SUBJECT', 50, currentY + 5);
        doc.text('SCORE', 150, currentY + 5);
        doc.text('CORRECT', 215, currentY + 5);
        doc.text('WRONG', 265, currentY + 5);
        doc.text('SKIPPED', 315, currentY + 5);
        doc.text('ACCURACY', 365, currentY + 5);
        doc.text('TIME SPENT', 425, currentY + 5);
        doc.text('STATUS', 485, currentY + 5);
        currentY += 19;

        const subjects = data.subjects && data.subjects.length > 0 ? data.subjects : [];
        if (subjects.length === 0) {
          doc.rect(40, currentY, 515, 22).fillAndStroke('#FFFFFF', borderColor);
          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text('No subject-level breakdown recorded.', 50, currentY + 6);
          currentY += 22;
        } else {
          subjects.forEach((sub, idx) => {
            const rowBg = idx % 2 === 0 ? '#FFFFFF' : lightBg;
            doc.rect(40, currentY, 515, 20).fillAndStroke(rowBg, borderColor);

            let subName = sub.name;
            if (sub.isStrongest) subName += ' ★ (Top)';
            else if (sub.isWeakest) subName += ' ⚠ (Weak)';

            doc.fillColor(sub.isStrongest ? primaryColor : darkText).fontSize(7.5).font(fBold).text(subName, 50, currentY + 5, { width: 95 });
            doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text(`${sub.score} / ${sub.maxScore}`, 150, currentY + 5);
            doc.fillColor(accentEmerald).fontSize(7.5).font(fRegular).text(`${sub.correct}`, 215, currentY + 5);
            doc.fillColor(accentRose).fontSize(7.5).font(fRegular).text(`${sub.wrong}`, 265, currentY + 5);
            doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(`${sub.unattempted}`, 315, currentY + 5);
            doc.fillColor(darkText).fontSize(7.5).font(fBold).text(`${Number(sub.accuracy || 0).toFixed(1)}%`, 365, currentY + 5);
            const timeSubStr = sub.timeSpentSeconds !== undefined ? `${Math.floor(sub.timeSpentSeconds / 60)}m ${sub.timeSpentSeconds % 60}s` : '—';
            doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(timeSubStr, 425, currentY + 5);

            const st = sub.performanceStatus || (sub.accuracy >= 75 ? 'STRONG' : sub.accuracy >= 50 ? 'GOOD' : 'CRITICAL');
            const stColor = st === 'STRONG' || st === 'EXCELLENT' ? accentEmerald : st === 'GOOD' ? primaryColor : accentRose;
            doc.fillColor(stColor).fontSize(7).font(fBold).text(st, 485, currentY + 5);

            currentY += 20;
          });
        }

        // ═══════════════════════════════════════════════════════════════
        // PAGE 2: DIAGNOSTIC ANALYTICS, TIME, STRATEGY & RECOMMENDATIONS
        // ═══════════════════════════════════════════════════════════════
        doc.addPage();

        // Header Bar
        doc.rect(40, 40, 515, 36).fill(secondaryColor);
        doc.fillColor('#FFFFFF').fontSize(12).font(fBold).text('BRAINROS — Diagnostic Analytics & Attempt Strategy', 55, 50);
        doc.fillColor('#94A3B8').fontSize(7.5).font(fRegular).text(`Candidate: ${data.student.name}  |  Exam: ${data.exam.title}`, 320, 52, { width: 220, align: 'right' });

        let p2Y = 88;

        // 1. Ranks & Percentiles Snapshot (if rank breakdown available)
        const hasGranularRanks = data.ranks && (data.ranks.overall || data.ranks.category || data.ranks.state || data.ranks.predictedRank);
        if (hasGranularRanks) {
          doc.fillColor(secondaryColor).fontSize(10).font(fBold).text('Official Ranks & Comparative Percentiles', 40, p2Y);
          p2Y += 14;

          const rCardW = 122;
          const rCardH = 46;
          const rGap = 9;

          // Rank Card 1: All India / Overall Rank
          doc.rect(40, p2Y, rCardW, rCardH).fillAndStroke(lightBg, borderColor);
          doc.fillColor(mutedText).fontSize(6.5).font(fBold).text('ALL-INDIA / OVERALL RANK', 48, p2Y + 7);
          const ovRank = data.ranks?.overall?.rank || data.rank?.rank || '—';
          doc.fillColor(primaryColor).fontSize(12).font(fBold).text(`#${ovRank}`, 48, p2Y + 18);
          const ovPerc = data.ranks?.overall?.percentile ?? data.rank?.percentile;
          doc.fillColor(mutedText).fontSize(6.5).font(fRegular).text(ovPerc !== undefined ? `Percentile: ${Number(ovPerc).toFixed(2)}%` : 'Processing', 48, p2Y + 33);

          // Rank Card 2: Category Rank
          doc.rect(40 + (rCardW + rGap), p2Y, rCardW, rCardH).fillAndStroke(lightBg, borderColor);
          doc.fillColor(mutedText).fontSize(6.5).font(fBold).text('CATEGORY RANK', 40 + (rCardW + rGap) + 8, p2Y + 7);
          const catRank = data.ranks?.category?.rank ? `#${data.ranks.category.rank}` : '—';
          doc.fillColor(darkText).fontSize(12).font(fBold).text(catRank, 40 + (rCardW + rGap) + 8, p2Y + 18);
          const catName = data.ranks?.category?.scopeName || (data.ranks?.category?.percentile ? `${Number(data.ranks.category.percentile).toFixed(1)}%ile` : 'Standard');
          doc.fillColor(mutedText).fontSize(6.5).font(fRegular).text(catName, 40 + (rCardW + rGap) + 8, p2Y + 33);

          // Rank Card 3: State / District Rank
          doc.rect(40 + (rCardW + rGap) * 2, p2Y, rCardW, rCardH).fillAndStroke(lightBg, borderColor);
          doc.fillColor(mutedText).fontSize(6.5).font(fBold).text('STATE / REGIONAL RANK', 40 + (rCardW + rGap) * 2 + 8, p2Y + 7);
          const stRank = data.ranks?.state?.rank ? `#${data.ranks.state.rank}` : data.ranks?.district?.rank ? `#${data.ranks.district.rank}` : '—';
          doc.fillColor(darkText).fontSize(12).font(fBold).text(stRank, 40 + (rCardW + rGap) * 2 + 8, p2Y + 18);
          const stName = data.ranks?.state?.scopeName || data.ranks?.district?.scopeName || 'Regional Cohort';
          doc.fillColor(mutedText).fontSize(6.5).font(fRegular).text(stName, 40 + (rCardW + rGap) * 2 + 8, p2Y + 33);

          // Rank Card 4: Statistical Predicted Rank
          doc.rect(40 + (rCardW + rGap) * 3, p2Y, rCardW, rCardH).fillAndStroke(lightBg, borderColor);
          doc.fillColor(mutedText).fontSize(6.5).font(fBold).text('PREDICTED BENCHMARK', 40 + (rCardW + rGap) * 3 + 8, p2Y + 7);
          const predStr = data.ranks?.predictedRank?.min ? `${data.ranks.predictedRank.min.toLocaleString()} - ${data.ranks.predictedRank.max.toLocaleString()}` : 'Qualified';
          doc.fillColor(accentEmerald).fontSize(10).font(fBold).text(predStr, 40 + (rCardW + rGap) * 3 + 8, p2Y + 19);
          const predConf = data.ranks?.predictedRank?.confidence ? `Confidence: ${data.ranks.predictedRank.confidence}` : 'Historical Curve';
          doc.fillColor(mutedText).fontSize(6.5).font(fRegular).text(predConf, 40 + (rCardW + rGap) * 3 + 8, p2Y + 33);

          p2Y += rCardH + 12;
        }

        // 2. Chapter Diagnosis & Concept Mastery
        doc.fillColor(secondaryColor).fontSize(10).font(fBold).text('Chapter Diagnosis & Concept Mastery', 40, p2Y);
        p2Y += 14;

        const masteredChapters = data.chapters?.mastered || [];
        const revisionChapters = data.chapters?.revisionNeeded || [];
        const criticalChapters = data.chapters?.criticalFocus || [];

        const chColW = 166;
        const chBoxH = 88;

        // Box 1: Mastered
        doc.rect(40, p2Y, chColW, chBoxH).fillAndStroke('#F0FDF4', '#BBF7D0');
        doc.fillColor(accentEmerald).fontSize(7.5).font(fBold).text('✓ Mastered Concepts (>=75%)', 48, p2Y + 8);
        if (masteredChapters.length === 0) {
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text('No high-mastery chapters identified.', 48, p2Y + 24);
        } else {
          let lineY = p2Y + 24;
          masteredChapters.slice(0, 3).forEach((ch) => {
            doc.fillColor(darkText).fontSize(7).font(fBold).text(`• ${ch.name}`, 48, lineY, { width: 85 });
            doc.fillColor(accentEmerald).fontSize(7).font(fBold).text(`${Number(ch.accuracy).toFixed(0)}%`, 135, lineY, { width: 65, align: 'right' });
            lineY += 18;
          });
        }

        // Box 2: Revision Needed
        doc.rect(214, p2Y, chColW, chBoxH).fillAndStroke('#FFFBEB', '#FDE68A');
        doc.fillColor(accentAmber).fontSize(7.5).font(fBold).text('⚙ Moderate Revision (50-74%)', 222, p2Y + 8);
        if (revisionChapters.length === 0) {
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text('No moderate revision chapters.', 222, p2Y + 24);
        } else {
          let lineY = p2Y + 24;
          revisionChapters.slice(0, 3).forEach((ch) => {
            doc.fillColor(darkText).fontSize(7).font(fBold).text(`• ${ch.name}`, 222, lineY, { width: 85 });
            doc.fillColor(accentAmber).fontSize(7).font(fBold).text(`${Number(ch.accuracy).toFixed(0)}%`, 309, lineY, { width: 65, align: 'right' });
            lineY += 18;
          });
        }

        // Box 3: Critical Focus
        doc.rect(388, p2Y, chColW, chBoxH).fillAndStroke('#FEF2F2', '#FECDD3');
        doc.fillColor(accentRose).fontSize(7.5).font(fBold).text('⚠ Critical Focus (<50% / Losses)', 396, p2Y + 8);
        if (criticalChapters.length === 0) {
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text('No critical failure zones detected.', 396, p2Y + 24);
        } else {
          let lineY = p2Y + 24;
          criticalChapters.slice(0, 3).forEach((ch) => {
            doc.fillColor(darkText).fontSize(7).font(fBold).text(`• ${ch.name}`, 396, lineY, { width: 85 });
            doc.fillColor(accentRose).fontSize(7.5).font(fBold).text(`${Number(ch.accuracy).toFixed(0)}%`, 483, lineY, { width: 65, align: 'right' });
            lineY += 18;
          });
        }

        p2Y += chBoxH + 12;

        // 3. Time Management & Question Pacing Analysis
        doc.fillColor(secondaryColor).fontSize(10).font(fBold).text('Time Management & Question Pacing Analytics', 40, p2Y);
        p2Y += 14;

        doc.rect(40, p2Y, 515, 64).fillAndStroke(lightBg, borderColor);
        const pacing = data.timeAnalysis?.pacingMetrics || { rushedCount: 0, optimalPaceCount: 0, overthoughtCount: 0 };
        const avgTimeQ = data.timeAnalysis?.averageTimePerQuestionSeconds || data.attempt.averageTimePerQuestion || 0;

        // Column 1: Pacing Distribution
        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Pacing Distribution', 52, p2Y + 8);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Optimal Pace: ${pacing.optimalPaceCount} questions`, 52, p2Y + 22);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Rushed (<20s): ${pacing.rushedCount} questions`, 52, p2Y + 35);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Overthought: ${pacing.overthoughtCount} questions`, 52, p2Y + 48);

        // Column 2: Speed Benchmarks
        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Speed Benchmarks', 220, p2Y + 8);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Average Speed: ${Number(avgTimeQ).toFixed(1)}s / question`, 220, p2Y + 22);
        const timeCorr = data.timeAnalysis?.timeOnCorrectSeconds ? `${Math.round(data.timeAnalysis.timeOnCorrectSeconds)}s` : 'N/A';
        const timeWrong = data.timeAnalysis?.timeOnWrongSeconds ? `${Math.round(data.timeAnalysis.timeOnWrongSeconds)}s` : 'N/A';
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Time on Correct: ${timeCorr}`, 220, p2Y + 35);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Time on Wrong: ${timeWrong}`, 220, p2Y + 48);

        // Column 3: Extremes & Waste
        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Pacing Extremes', 390, p2Y + 8);
        const fastSec = data.timeAnalysis?.fastestQuestionSeconds !== undefined ? `${data.timeAnalysis.fastestQuestionSeconds}s` : 'N/A';
        const slowSec = data.timeAnalysis?.slowestQuestionSeconds !== undefined ? `${data.timeAnalysis.slowestQuestionSeconds}s` : 'N/A';
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Fastest Response: ${fastSec}`, 390, p2Y + 22);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`Slowest Response: ${slowSec}`, 390, p2Y + 35);
        const timeWasted = data.timeAnalysis?.timeWastedSeconds ? `${Math.round(data.timeAnalysis.timeWastedSeconds / 60)}m wasted` : 'Minimal time waste';
        doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(`Time Waste Index: ${timeWasted}`, 390, p2Y + 48);

        p2Y += 76;

        // 4. Attempt Strategy & Negative Marking Diagnostic
        doc.fillColor(secondaryColor).fontSize(10).font(fBold).text('Attempt Strategy & Negative Marking Impact', 40, p2Y);
        p2Y += 14;

        doc.rect(40, p2Y, 515, 74).fillAndStroke(lightBg, borderColor);
        const riskProf = (data.strategy?.riskCategory || (data.attempt.accuracy < 60 ? 'HIGH_RISK' : 'BALANCED')).replace(/_/g, ' ');

        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Avoidable Negative Penalty', 52, p2Y + 8);
        doc.fillColor(accentRose).fontSize(12).font(fBold).text(`-${negPenalty} Marks`, 52, p2Y + 22);
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text('Lost to incorrect guesses', 52, p2Y + 38);

        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Projected Potential Score', 200, p2Y + 8);
        doc.fillColor(accentEmerald).fontSize(12).font(fBold).text(`${potScore} / ${data.attempt.maxScore}`, 200, p2Y + 22);
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text('If wrong attempts were skipped', 200, p2Y + 38);

        doc.fillColor(primaryColor).fontSize(7.5).font(fBold).text('Strategy Risk Profile', 360, p2Y + 8);
        doc.fillColor(darkText).fontSize(10).font(fBold).text(riskProf, 360, p2Y + 22);
        const attemptRatioStr = data.strategy?.attemptRatio ? `${Number(data.strategy.attemptRatio).toFixed(1)}% exam coverage` : `${data.attempt.totalQuestions - data.attempt.unattempted} questions attempted`;
        doc.fillColor(mutedText).fontSize(7).font(fRegular).text(attemptRatioStr, 360, p2Y + 38);

        const gainMsg = data.strategy?.potentialScoreGainMessage || `Eliminating low-confidence guesses could recover approximately ~${negPenalty} marks.`;
        doc.rect(48, p2Y + 52, 499, 16).fill('#EEF2FF');
        doc.fillColor(primaryColor).fontSize(7).font(fBold).text('Strategic Takeaway:', 54, p2Y + 56);
        doc.fillColor(darkText).fontSize(7).font(fRegular).text(gainMsg, 142, p2Y + 56, { width: 395, lineBreak: false });

        p2Y += 86;

        // 5. Actionable Performance Recommendations (Smart Insights)
        doc.fillColor(secondaryColor).fontSize(10).font(fBold).text('Actionable Performance Recommendations (Smart Insights)', 40, p2Y);
        p2Y += 14;

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
          doc.rect(40, p2Y, 515, 44).fillAndStroke(lightBg, borderColor);

          const prioColor = rec.priority === 'HIGH' ? accentRose : rec.priority === 'MEDIUM' ? accentAmber : primaryColor;
          doc.rect(48, p2Y + 7, 40, 13).fill(prioColor);
          doc.fillColor('#FFFFFF').fontSize(6).font(fBold).text((rec.priority || 'NORMAL').toUpperCase(), 48, p2Y + 10, { width: 40, align: 'center' });

          doc.fillColor(darkText).fontSize(8).font(fBold).text(rec.title, 96, p2Y + 7);
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text(rec.description, 96, p2Y + 20, { width: 445 });
          if (rec.actionStep) {
            doc.fillColor(primaryColor).fontSize(7).font(fBold).text(`Action: ${rec.actionStep}`, 96, p2Y + 31, { width: 445 });
          }

          p2Y += 50;
        });

        // ═══════════════════════════════════════════════════════════════
        // PAGE 3+: COMPREHENSIVE QUESTION-BY-QUESTION SOLUTION REVIEW AUDIT
        // ═══════════════════════════════════════════════════════════════
        const reviews = data.questionsReview || [];

        if (reviews.length > 0) {
          doc.addPage();
          let pReviewY = this.drawReviewPageHeader(doc, fBold, fRegular, secondaryColor, data.student.name, data.exam.title);

          // Review Summary Strip
          const correctQCount = reviews.filter((r) => r.isCorrect).length;
          const wrongQCount = reviews.filter((r) => r.isAttempted && !r.isCorrect).length;
          const unattemptedQCount = reviews.filter((r) => !r.isAttempted).length;

          doc.rect(40, pReviewY, 515, 24).fillAndStroke(lightBg, borderColor);
          doc.fillColor(darkText).fontSize(8).font(fBold).text(
            `Total Questions: ${reviews.length}   |   Correct: ${correctQCount}   |   Incorrect: ${wrongQCount}   |   Skipped: ${unattemptedQCount}   |   Marks: ${data.attempt.score} / ${data.attempt.maxScore}`,
            50,
            pReviewY + 7,
          );
          pReviewY += 32;

          // Render every question with full text, options, student choice, correct answer, and explanation
          reviews.forEach((q) => {
            const cardWidth = 515;
            const textWidth = cardWidth - 24;

            // Calculate card height dynamically
            const qText = q.questionText || 'Question statement';
            const qTextH = doc.heightOfString(qText, { width: textWidth, font: fRegular, size: 8 });
            const answerBarH = 22;
            const optionsH = q.options && q.options.length > 0 ? q.options.length * 16 + 8 : 16;
            const explH = q.explanation ? doc.heightOfString(`Solution / Key Insight: ${q.explanation}`, { width: textWidth - 16, font: fRegular, size: 7.5 }) + 14 : 0;
            const totalCardH = 24 + qTextH + 8 + answerBarH + 8 + optionsH + (explH ? explH + 6 : 0) + 12;

            // Page overflow check (leaves margin for bottom footer)
            if (pReviewY + totalCardH > 750) {
              doc.addPage();
              pReviewY = this.drawReviewPageHeader(doc, fBold, fRegular, secondaryColor, data.student.name, data.exam.title);
            }

            // Draw Question Card Container
            doc.rect(40, pReviewY, cardWidth, totalCardH).fillAndStroke('#FFFFFF', borderColor);

            // Card Header Bar
            doc.rect(40, pReviewY, cardWidth, 20).fill(lightBg);
            doc.fillColor(darkText).fontSize(8).font(fBold).text(
              `Question #${q.displayOrder}   •   Section: ${q.sectionName || 'General'}`,
              50,
              pReviewY + 5,
            );

            // Status Badge on Header Right
            const statusBadgeW = 140;
            const statusBadgeX = 40 + cardWidth - statusBadgeW - 8;
            if (q.isCorrect) {
              const ptsStr = `✓ Correct (+${q.marksAwarded} Marks${q.timeSpentSeconds ? ` • ${q.timeSpentSeconds}s` : ''})`;
              doc.fillColor(accentEmerald).fontSize(7.5).font(fBold).text(ptsStr, statusBadgeX, pReviewY + 5, { width: statusBadgeW, align: 'right' });
            } else if (q.isAttempted) {
              const negStr = `✗ Incorrect (-${q.negativeMarks ?? 1} Marks${q.timeSpentSeconds ? ` • ${q.timeSpentSeconds}s` : ''})`;
              doc.fillColor(accentRose).fontSize(7.5).font(fBold).text(negStr, statusBadgeX, pReviewY + 5, { width: statusBadgeW, align: 'right' });
            } else {
              doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text('— Unattempted (0 Marks)', statusBadgeX, pReviewY + 5, { width: statusBadgeW, align: 'right' });
            }

            let cardContentY = pReviewY + 26;

            // Question Text
            doc.fillColor(darkText).fontSize(8).font(fRegular).text(qText, 52, cardContentY, { width: textWidth });
            cardContentY += qTextH + 8;

            // Answer Comparison Bar (Shows Student Choice vs Official Answer)
            doc.rect(50, cardContentY, textWidth, answerBarH).fill('#F8FAFC');

            // Left: Student Selection
            const studentLabel = q.studentAnswer?.selectedOptionLabel;
            const studentText = q.studentAnswer?.selectedOptionText;
            if (q.isAttempted && studentLabel) {
              const selColor = q.isCorrect ? accentEmerald : accentRose;
              const selIcon = q.isCorrect ? '✓' : '✗';
              doc.fillColor(mutedText).fontSize(7).font(fRegular).text('Your Answer:', 56, cardContentY + 6);
              doc.fillColor(selColor).fontSize(7).font(fBold).text(
                `${selIcon} Option ${studentLabel} (${this.truncateText(studentText || '', 35)})`,
                106,
                cardContentY + 6,
              );
            } else {
              doc.fillColor(mutedText).fontSize(7).font(fRegular).text('Your Answer: Not Attempted', 56, cardContentY + 6);
            }

            // Right: Official Correct Answer
            const corrLabel = q.correctAnswer?.optionLabel;
            const corrText = q.correctAnswer?.optionText;
            if (corrLabel) {
              doc.fillColor(mutedText).fontSize(7).font(fRegular).text('Official Answer:', 320, cardContentY + 6);
              doc.fillColor(accentEmerald).fontSize(7).font(fBold).text(
                `✓ Option ${corrLabel} (${this.truncateText(corrText || '', 30)})`,
                380,
                cardContentY + 6,
              );
            }

            cardContentY += answerBarH + 8;

            // Options List (A, B, C, D)
            if (q.options && q.options.length > 0) {
              q.options.forEach((opt) => {
                const isSelected = q.studentAnswer?.selectedOptionId === opt.id || q.studentAnswer?.selectedOptionLabel === opt.optionLabel;
                const isCorrect = opt.isCorrect;

                let optBg = '#FFFFFF';
                let optBorder = borderColor;
                if (isCorrect && isSelected) {
                  optBg = '#ECFDF5';
                  optBorder = '#A7F3D0';
                } else if (isSelected && !isCorrect) {
                  optBg = '#FFF1F2';
                  optBorder = '#FECDD3';
                } else if (isCorrect && !isSelected) {
                  optBg = '#F0FDF4';
                  optBorder = '#BBF7D0';
                }

                doc.rect(52, cardContentY, textWidth - 4, 15).fillAndStroke(optBg, optBorder);

                const labelCircleColor = isCorrect ? accentEmerald : isSelected ? accentRose : darkText;
                doc.fillColor(labelCircleColor).fontSize(7).font(fBold).text(`(${opt.optionLabel})`, 58, cardContentY + 3);
                doc.fillColor(darkText).fontSize(7).font(fRegular).text(opt.optionText || '', 80, cardContentY + 3, { width: 280 });

                // Badges on right of option
                let badgeX = 52 + textWidth - 145;
                if (isSelected) {
                  const tagColor = isCorrect ? primaryColor : accentRose;
                  doc.fillColor(tagColor).fontSize(6.5).font(fBold).text(
                    isCorrect ? '[Your Choice ✓]' : '[Your Choice ✗]',
                    badgeX,
                    cardContentY + 3,
                  );
                  badgeX += 65;
                }
                if (isCorrect) {
                  doc.fillColor(accentEmerald).fontSize(6.5).font(fBold).text('[✓ Correct Answer]', badgeX, cardContentY + 3);
                }

                cardContentY += 16;
              });
            }

            // Explanation / Solution (if provided)
            if (q.explanation) {
              cardContentY += 4;
              doc.rect(52, cardContentY, textWidth - 4, explH).fill('#EEF2FF');
              doc.fillColor(primaryColor).fontSize(7).font(fBold).text('Solution / Explanation:', 58, cardContentY + 4);
              doc.fillColor(darkText).fontSize(7).font(fRegular).text(q.explanation, 58, cardContentY + 14, { width: textWidth - 16 });
              cardContentY += explH;
            }

            pReviewY += totalCardH + 10;
          });
        }

        doc.end();
      } catch (err) {
        this.logger.error(`[ExamReportPdfService] Failed to generate PDF: ${err.message}`, err.stack);
        reject(err);
      }
    });
  }

  /**
   * Header for Question Review continuation pages
   */
  private drawReviewPageHeader(doc: any, fBold: string, fRegular: string, secondaryColor: string, studentName: string, examTitle: string): number {
    doc.rect(40, 40, 515, 34).fill(secondaryColor);
    doc.fillColor('#FFFFFF').fontSize(11).font(fBold).text('BRAINROS — Question-by-Question Solution & Review Audit', 55, 48);
    doc.fillColor('#94A3B8').fontSize(7.5).font(fRegular).text(
      `Candidate: ${studentName}  |  Exam: ${examTitle}`,
      300,
      50,
      { width: 240, align: 'right' },
    );
    return 84;
  }

  /**
   * Footer stamped on every page dynamically
   */
  private drawPageFooter(doc: any, pageNum: number, totalPages: number) {
    const footerY = 800;
    doc.rect(40, footerY, 515, 0.5).fill('#E2E8F0');
    doc.fillColor('#64748B').fontSize(6.5).font('Helvetica').text(
      `Page ${pageNum} of ${totalPages}   •   Brainros Assessment Engine   •   Official Examination Performance & Diagnostic Report   •   Strictly Confidential`,
      40,
      footerY + 6,
      { width: 515, align: 'center' },
    );
  }

  /**
   * Resolves available TrueType fonts with support for Gujarati/Devanagari scripts
   */
  private resolveFont(bold: boolean): string {
    const fontCandidates = bold
      ? [
          'C:\\Windows\\Fonts\\shrutib.ttf',
          'C:\\Windows\\Fonts\\arialbd.ttf',
          'C:\\Windows\\Fonts\\segoeuib.ttf',
        ]
      : [
          'C:\\Windows\\Fonts\\shruti.ttf',
          'C:\\Windows\\Fonts\\arial.ttf',
          'C:\\Windows\\Fonts\\segoeui.ttf',
        ];

    for (const fontPath of fontCandidates) {
      if (fs.existsSync(fontPath)) {
        return fontPath;
      }
    }
    return bold ? 'Helvetica-Bold' : 'Helvetica';
  }

  private truncateText(text: string, maxLen: number): string {
    if (!text) return '';
    return text.length > maxLen ? `${text.substring(0, maxLen - 1)}…` : text;
  }
}
