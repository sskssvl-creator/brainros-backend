import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import { FullAnalysisReport } from '../../result/interfaces/analysis.interface';

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
    [key: string]: any;
  };
  fullAnalysis?: FullAnalysisReport;
  rank?: {
    rank?: number;
    totalCandidates?: number;
    percentile?: number;
  };
  ranks?: Record<string, any>;
  subjects?: any[];
  chapters?: any;
  timeAnalysis?: any;
  strategy?: any;
  recommendations?: any[];
  questionsReview?: any[];
}

@Injectable()
export class ExamReportPdfService {
  private readonly logger = new Logger(ExamReportPdfService.name);

  /**
   * Generates a comprehensive, branded 14-Section Brainros Student Performance Analysis Report PDF
   * matching the official reference layout.
   */
  async generateReportPdf(data: ExamReportPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          margin: 40,
          size: 'A4',
          bufferPages: true,
          info: {
            Title: `BRAINROS Performance Report - ${data.exam.title} - ${data.student.name}`,
            Author: 'BRAINROS Assessment Engine',
            Subject: 'Official Student Performance Analysis & Diagnostic Report',
            Keywords: 'BRAINROS, NEET, JEE, CET, Mock Test, Performance Report, Analytics',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => {
          try {
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

        // Fonts
        const fRegular = 'Helvetica';
        const fBold = 'Helvetica-Bold';

        // Palette
        const brandNavy = '#0F172A';
        const brandIndigo = '#4338CA';
        const darkText = '#1E293B';
        const mutedText = '#64748B';
        const lightBg = '#F8FAFC';
        const borderColor = '#CBD5E1';
        const borderLight = '#E2E8F0';
        const badgeBg = '#EEF2FF';

        const fa = data.fullAnalysis;

        // ═══════════════════════════════════════════════════════════════════
        // PAGE 1: HEADER, STUDENT DETAILS, OVERALL & SUBJECT-WISE ANALYSIS
        // ═══════════════════════════════════════════════════════════════════

        // Main Header Banner
        doc.rect(40, 40, 515, 60).fill(brandNavy);
        doc.fillColor('#FFFFFF').fontSize(18).font(fBold).text('BRAINROS 2026', 55, 48);
        doc.fillColor('#A5B4FC').fontSize(9).font(fBold).text('STUDENT PERFORMANCE ANALYSIS REPORT', 55, 70);
        doc.fillColor('#94A3B8').fontSize(7.5).font(fRegular).text('NEET / JEE / CET MOCK TEST SERIES', 55, 82);

        const examTargetLabel = data.exam.examTargetName || 'Competitive Mock Test';
        doc.fillColor('#FFFFFF').fontSize(10).font(fBold).text(data.exam.title, 310, 50, { width: 235, align: 'right' });
        doc.fillColor('#94A3B8').fontSize(7.5).font(fRegular).text(
          `Target: ${examTargetLabel}  |  Total Marks: ${data.exam.totalMarks}`,
          310,
          74,
          { width: 235, align: 'right' },
        );

        let y = 110;

        // Helper: Section Title
        const drawSectionHeader = (title: string, currentY: number): number => {
          if (currentY > 720) {
            doc.addPage();
            currentY = 45;
          }
          doc.rect(40, currentY, 515, 20).fill(brandIndigo);
          doc.fillColor('#FFFFFF').fontSize(8.5).font(fBold).text(title, 48, currentY + 5.5);
          return currentY + 24;
        };

        // ── 1. STUDENT DETAILS ──────────────────────────────────────────────
        y = drawSectionHeader('1. STUDENT DETAILS', y);
        const s1 = fa?.section1StudentDetails;
        const studentDetailsData = [
          ['Student Name', s1?.studentName || data.student.name, 'Test Number', s1?.testNumber || data.exam.title],
          ['Student ID', s1?.studentId || data.student.studentCode || 'N/A', 'Test Date', s1?.testDate || 'Recently'],
          ['Examination', s1?.examination || data.exam.title, 'Test Mode', s1?.testMode || 'Online'],
          ['Class', s1?.className || '12th / 2nd PUC', 'Total Questions', String(s1?.totalQuestions ?? data.attempt.totalQuestions)],
          ['Maximum Marks', String(s1?.maximumMarks ?? data.exam.totalMarks), 'Performance Level', fa?.section2OverallPerformance?.performanceLevel || 'Good'],
        ];

        doc.rect(40, y, 515, studentDetailsData.length * 16).fillAndStroke(lightBg, borderColor);
        let s1RowY = y;
        studentDetailsData.forEach((row) => {
          doc.rect(40, s1RowY, 110, 16).fillAndStroke('#F1F5F9', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(row[0], 46, s1RowY + 4);
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(row[1], 156, s1RowY + 4, { width: 130 });

          doc.rect(295, s1RowY, 100, 16).fillAndStroke('#F1F5F9', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(row[2], 301, s1RowY + 4);
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(row[3], 401, s1RowY + 4, { width: 145 });

          s1RowY += 16;
        });
        y = s1RowY + 12;

        // ── 2. OVERALL PERFORMANCE ─────────────────────────────────────────
        y = drawSectionHeader('2. OVERALL PERFORMANCE', y);
        const s2 = fa?.section2OverallPerformance;
        const overallRows = [
          ['Total Marks', `${s2?.totalMarks ?? data.attempt.score} / ${s2?.maximumMarks ?? data.exam.totalMarks}`],
          ['Percentage', `${(s2?.percentage ?? data.attempt.percentage).toFixed(2)}%`],
          ['Correct Answers', String(s2?.correctAnswers ?? data.attempt.correctAnswers)],
          ['Incorrect Answers', String(s2?.incorrectAnswers ?? data.attempt.wrongAnswers)],
          ['Unattempted', String(s2?.unattempted ?? data.attempt.unattempted)],
          ['Accuracy', `${(s2?.accuracy ?? data.attempt.accuracy).toFixed(2)}%`],
          ['Overall Percentile', s2?.overallPercentile ? `${s2.overallPercentile.toFixed(2)}` : 'Not Available'],
          ['Estimated Rank', s2?.estimatedRank ? `#${s2.estimatedRank}` : 'Not Available'],
          ['Performance Level', s2?.performanceLevel || 'Good'],
        ];

        const s2CardW = 250;
        doc.rect(40, y, 515, Math.ceil(overallRows.length / 2) * 16).fillAndStroke(lightBg, borderColor);
        let s2RowY = y;
        for (let i = 0; i < overallRows.length; i += 2) {
          const left = overallRows[i];
          const right = overallRows[i + 1];

          // Left
          doc.rect(40, s2RowY, 130, 16).fillAndStroke('#F1F5F9', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(left[0], 46, s2RowY + 4);
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(left[1], 176, s2RowY + 4);

          // Right
          if (right) {
            doc.rect(295, s2RowY, 130, 16).fillAndStroke('#F1F5F9', borderLight);
            doc.fillColor(darkText).fontSize(7.5).font(fBold).text(right[0], 301, s2RowY + 4);
            doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(right[1], 431, s2RowY + 4);
          }
          s2RowY += 16;
        }
        y = s2RowY + 12;

        // ── 3. SUBJECT-WISE ANALYSIS ────────────────────────────────────────
        y = drawSectionHeader('3. SUBJECT-WISE ANALYSIS', y);
        const s3 = fa?.section3SubjectWiseAnalysis;
        const colWidths = [115, 50, 50, 55, 60, 55, 65, 65]; // total 515
        const headers = ['Subject', 'Max', 'Score', '%', 'Correct', 'Wrong', 'Unattempted', 'Accuracy'];

        // Table Header
        doc.rect(40, y, 515, 18).fill('#1E293B');
        let hX = 40;
        headers.forEach((h, idx) => {
          doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text(h, hX + 4, y + 5, { width: colWidths[idx] - 8, align: idx === 0 ? 'left' : 'center' });
          hX += colWidths[idx];
        });
        y += 18;

        const tableRows = s3?.rows || [];
        tableRows.forEach((r, idx) => {
          doc.rect(40, y, 515, 16).fillAndStroke(idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          let rX = 40;
          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(r.subject, rX + 4, y + 4, { width: colWidths[0] - 8 });
          rX += colWidths[0];
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(String(r.max), rX, y + 4, { width: colWidths[1], align: 'center' });
          rX += colWidths[1];
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(String(r.score), rX, y + 4, { width: colWidths[2], align: 'center' });
          rX += colWidths[2];
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`${r.percentage.toFixed(1)}%`, rX, y + 4, { width: colWidths[3], align: 'center' });
          rX += colWidths[3];
          doc.fillColor('#15803D').fontSize(7.5).font(fBold).text(String(r.correct), rX, y + 4, { width: colWidths[4], align: 'center' });
          rX += colWidths[4];
          doc.fillColor('#B91C1C').fontSize(7.5).font(fBold).text(String(r.wrong), rX, y + 4, { width: colWidths[5], align: 'center' });
          rX += colWidths[5];
          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(String(r.unattempted), rX, y + 4, { width: colWidths[6], align: 'center' });
          rX += colWidths[6];
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(`${r.accuracy.toFixed(1)}%`, rX, y + 4, { width: colWidths[7], align: 'center' });
          y += 16;
        });

        // Total Row
        if (s3?.total) {
          doc.rect(40, y, 515, 18).fillAndStroke('#E2E8F0', borderColor);
          let rX = 40;
          doc.fillColor(darkText).fontSize(8).font(fBold).text('TOTAL', rX + 4, y + 5, { width: colWidths[0] - 8 });
          rX += colWidths[0];
          doc.fillColor(darkText).fontSize(8).font(fBold).text(String(s3.total.max), rX, y + 5, { width: colWidths[1], align: 'center' });
          rX += colWidths[1];
          doc.fillColor(brandIndigo).fontSize(8).font(fBold).text(String(s3.total.score), rX, y + 5, { width: colWidths[2], align: 'center' });
          rX += colWidths[2];
          doc.fillColor(darkText).fontSize(8).font(fBold).text(`${s3.total.percentage.toFixed(1)}%`, rX, y + 5, { width: colWidths[3], align: 'center' });
          rX += colWidths[3];
          doc.fillColor('#15803D').fontSize(8).font(fBold).text(String(s3.total.correct), rX, y + 5, { width: colWidths[4], align: 'center' });
          rX += colWidths[4];
          doc.fillColor('#B91C1C').fontSize(8).font(fBold).text(String(s3.total.wrong), rX, y + 5, { width: colWidths[5], align: 'center' });
          rX += colWidths[5];
          doc.fillColor(mutedText).fontSize(8).font(fBold).text(String(s3.total.unattempted), rX, y + 5, { width: colWidths[6], align: 'center' });
          rX += colWidths[6];
          doc.fillColor(brandIndigo).fontSize(8).font(fBold).text(`${s3.total.accuracy.toFixed(1)}%`, rX, y + 5, { width: colWidths[7], align: 'center' });
          y += 24;
        }

        // ═══════════════════════════════════════════════════════════════════
        // PAGE 2: SUBJECT PERFORMANCE & TOPIC-WISE PERFORMANCE
        // ═══════════════════════════════════════════════════════════════════
        doc.addPage();
        y = 45;

        // ── 4. SUBJECT PERFORMANCE ──────────────────────────────────────────
        y = drawSectionHeader('4. SUBJECT PERFORMANCE', y);
        const s4 = fa?.section4SubjectPerformance || [];
        s4.forEach((subj) => {
          if (y > 700) {
            doc.addPage();
            y = 45;
          }
          doc.rect(40, y, 515, 68).fillAndStroke(lightBg, borderColor);
          doc.rect(40, y, 515, 16).fill('#F1F5F9');
          doc.fillColor(brandNavy).fontSize(8).font(fBold).text(
            `${subj.subjectName.toUpperCase()} — ${subj.score} / ${subj.maxScore} — Performance Level: ${subj.performanceLevel}`,
            48,
            y + 4,
          );

          doc.fillColor('#15803D').fontSize(7.5).font(fBold).text('Strong Areas: ', 48, y + 20);
          doc.fillColor(darkText).font(fRegular).text(subj.strongAreas.join('; ') || 'Standard chapter coverage', 110, y + 20, { width: 435 });

          doc.fillColor('#B91C1C').fontSize(7.5).font(fBold).text('Areas Requiring Improvement: ', 48, y + 34);
          doc.fillColor(darkText).font(fRegular).text(subj.areasRequiringImprovement.join('; ') || 'Numerical speed and formula derivation', 170, y + 34, { width: 375 });

          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text('Recommendation: ', 48, y + 48);
          doc.fillColor(darkText).font(fRegular).text(subj.recommendation, 125, y + 48, { width: 420 });

          y += 74;
        });
        y += 6;

        // ── 5. TOPIC-WISE PERFORMANCE ───────────────────────────────────────
        y = drawSectionHeader('5. TOPIC-WISE PERFORMANCE', y);
        const s5 = fa?.section5TopicWisePerformance || [];
        const tCols = [235, 120, 80, 80]; // total 515
        const tHeaders = ['Topic / Chapter', 'Subject', 'Accuracy', 'Status'];

        doc.rect(40, y, 515, 18).fill('#1E293B');
        let thX = 40;
        tHeaders.forEach((h, idx) => {
          doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text(h, thX + 4, y + 5, { width: tCols[idx] - 8, align: idx >= 2 ? 'center' : 'left' });
          thX += tCols[idx];
        });
        y += 18;

        s5.forEach((top, idx) => {
          if (y > 740) {
            doc.addPage();
            y = 45;
            // Repeat Header
            doc.rect(40, y, 515, 18).fill('#1E293B');
            let rthX = 40;
            tHeaders.forEach((h, i) => {
              doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text(h, rthX + 4, y + 5, { width: tCols[i] - 8, align: i >= 2 ? 'center' : 'left' });
              rthX += tCols[i];
            });
            y += 18;
          }

          doc.rect(40, y, 515, 15).fillAndStroke(idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          let trX = 40;
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(top.topic, trX + 4, y + 3.5, { width: tCols[0] - 8 });
          trX += tCols[0];
          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(top.subjectName, trX + 4, y + 3.5, { width: tCols[1] - 8 });
          trX += tCols[1];
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(`${top.accuracy.toFixed(1)}%`, trX, y + 3.5, { width: tCols[2], align: 'center' });
          trX += tCols[2];

          const statusColor = top.status === 'Strong' || top.status === 'Excellent' ? '#15803D' : top.status === 'Good' ? '#2563EB' : top.status === 'Needs Improvement' ? '#D97706' : '#B91C1C';
          doc.fillColor(statusColor).fontSize(7.5).font(fBold).text(top.status, trX, y + 3.5, { width: tCols[3], align: 'center' });

          y += 15;
        });
        y += 14;

        // ═══════════════════════════════════════════════════════════════════
        // PAGE 3: STRENGTHS, ERRORS, TIME, TREND & EXPECTED TARGETS
        // ═══════════════════════════════════════════════════════════════════
        doc.addPage();
        y = 45;

        // ── 6. STRENGTH & WEAKNESS ANALYSIS ────────────────────────────────
        y = drawSectionHeader('6. STRENGTH & WEAKNESS ANALYSIS', y);
        const s6 = fa?.section6StrengthWeakness;
        const halfW = 252;

        // Strengths Box
        doc.rect(40, y, halfW, 76).fillAndStroke('#F0FDF4', '#BBF7D0');
        doc.rect(40, y, halfW, 16).fill('#DCFCE7');
        doc.fillColor('#15803D').fontSize(7.5).font(fBold).text('TOP STRENGTHS', 48, y + 4);
        let sY = y + 20;
        (s6?.topStrengths || ['Solid foundational preparation']).forEach((st, i) => {
          doc.fillColor('#166534').fontSize(7).font(fRegular).text(`${i + 1}. ${st}`, 48, sY, { width: halfW - 16 });
          sY += 13;
        });

        // Weaknesses Box
        doc.rect(303, y, halfW, 76).fillAndStroke('#FEF2F2', '#FECACA');
        doc.rect(303, y, halfW, 16).fill('#FEE2E2');
        doc.fillColor('#B91C1C').fontSize(7.5).font(fBold).text('PRIORITY WEAKNESSES', 311, y + 4);
        let wY = y + 20;
        (s6?.priorityWeaknesses || ['Focus on calculation speed']).forEach((wk, i) => {
          doc.fillColor('#991B1B').fontSize(7).font(fRegular).text(`${i + 1}. ${wk}`, 311, wY, { width: halfW - 16 });
          wY += 13;
        });
        y += 86;

        // ── 7. ERROR ANALYSIS ──────────────────────────────────────────────
        y = drawSectionHeader('7. ERROR ANALYSIS', y);
        const s7 = fa?.section7ErrorAnalysis;
        const eCols = [235, 140, 140];
        doc.rect(40, y, 515, 16).fill('#1E293B');
        doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text('Error Type', 46, y + 4);
        doc.text('No. of Questions', 275, y + 4, { width: 140, align: 'center' });
        doc.text('Impact', 415, y + 4, { width: 140, align: 'center' });
        y += 16;

        (s7?.categories || []).forEach((ec, i) => {
          doc.rect(40, y, 515, 14).fillAndStroke(i % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(ec.errorType, 46, y + 3);
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(String(ec.questionCount), 275, y + 3, { width: 140, align: 'center' });
          const impactCol = ec.impact === 'High' ? '#B91C1C' : ec.impact === 'Medium' ? '#D97706' : '#15803D';
          doc.fillColor(impactCol).fontSize(7.5).font(fBold).text(ec.impact, 415, y + 3, { width: 140, align: 'center' });
          y += 14;
        });

        // Error Narrative Callout Box
        doc.rect(40, y, 515, 26).fillAndStroke('#FEF3C7', '#FDE68A');
        doc.fillColor('#92400E').fontSize(7.5).font(fRegular).text(
          s7?.narrative || 'Maintain an Error Notebook after every BRAINROS test to convert mistakes into marks.',
          48,
          y + 6,
          { width: 499 },
        );
        y += 34;

        // ── 8. TIME MANAGEMENT ─────────────────────────────────────────────
        y = drawSectionHeader('8. TIME MANAGEMENT', y);
        const s8 = fa?.section8TimeManagement;
        const tmCols = [175, 170, 170];
        doc.rect(40, y, 515, 16).fill('#1E293B');
        doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text('Section', 46, y + 4);
        doc.text('Recommended Time', 215, y + 4, { width: 170, align: 'center' });
        doc.text('Student Time', 385, y + 4, { width: 170, align: 'center' });
        y += 16;

        (s8?.rows || []).forEach((tm, i) => {
          doc.rect(40, y, 515, 14).fillAndStroke(i % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(tm.section, 46, y + 3);
          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(`${tm.recommendedMinutes} min`, 215, y + 3, { width: 170, align: 'center' });
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(`${tm.studentMinutes} min`, 385, y + 3, { width: 170, align: 'center' });
          y += 14;
        });

        // Time Strategy Rounds
        doc.rect(40, y, 515, 24).fillAndStroke('#F1F5F9', borderLight);
        doc.fillColor(brandNavy).fontSize(7).font(fBold).text('Exam Rounds Strategy:', 48, y + 4);
        doc.fillColor(mutedText).font(fRegular).text('Round 1: Easy/Direct Qs  •  Round 2: Moderate Problems  •  Round 3: Calculation Heavy  •  Final 15m: Review & Verification', 48, y + 13, { width: 499 });
        y += 32;

        // ── 9. BRAINROS PERFORMANCE TREND ──────────────────────────────────
        y = drawSectionHeader('9. BRAINROS PERFORMANCE TREND', y);
        const s9 = fa?.section9PerformanceTrend;
        const trCols = [175, 170, 170];
        doc.rect(40, y, 515, 16).fill('#1E293B');
        doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text('Test', 46, y + 4);
        doc.text('Score', 215, y + 4, { width: 170, align: 'center' });
        doc.text('Percentile', 385, y + 4, { width: 170, align: 'center' });
        y += 16;

        (s9?.history || []).slice(-5).forEach((tp, i) => {
          doc.rect(40, y, 515, 14).fillAndStroke(i % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(`${tp.testNumber} (${tp.testTitle})`, 46, y + 3, { width: 165 });
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(String(tp.score), 215, y + 3, { width: 170, align: 'center' });
          doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(tp.percentile ? `${tp.percentile.toFixed(2)}` : '—', 385, y + 3, { width: 170, align: 'center' });
          y += 14;
        });

        doc.rect(40, y, 515, 18).fillAndStroke(lightBg, borderLight);
        doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(s9?.trendSummary || 'Steady baseline recorded.', 46, y + 4, { width: 503 });
        y += 26;

        // ── 10. EXPECTED PERFORMANCE ───────────────────────────────────────
        y = drawSectionHeader('10. EXPECTED PERFORMANCE', y);
        const s10 = fa?.section10ExpectedPerformance;
        const targetCols = [128, 128, 128, 131];
        doc.rect(40, y, 515, 34).fillAndStroke(lightBg, borderColor);
        doc.rect(40, y, 515, 14).fill('#F1F5F9');

        doc.fillColor(darkText).fontSize(7).font(fBold);
        doc.text('Current Score', 40, y + 3, { width: targetCols[0], align: 'center' });
        doc.text('Short-Term Target', 40 + targetCols[0], y + 3, { width: targetCols[1], align: 'center' });
        doc.text('Strong Target', 40 + targetCols[0] + targetCols[1], y + 3, { width: targetCols[2], align: 'center' });
        doc.text('Excellent Target', 40 + targetCols[0] + targetCols[1] + targetCols[2], y + 3, { width: targetCols[3], align: 'center' });

        doc.fontSize(8.5).font(fBold);
        doc.fillColor(darkText).text(`${s10?.currentScore ?? data.attempt.score} / ${s10?.maxScore ?? data.exam.totalMarks}`, 40, y + 18, { width: targetCols[0], align: 'center' });
        doc.fillColor(brandIndigo).text(`${s10?.shortTermTarget ?? 550}+`, 40 + targetCols[0], y + 18, { width: targetCols[1], align: 'center' });
        doc.fillColor('#15803D').text(`${s10?.strongTarget ?? 600}+`, 40 + targetCols[0] + targetCols[1], y + 18, { width: targetCols[2], align: 'center' });
        doc.fillColor('#4338CA').text(`${s10?.excellentTarget ?? 650}+`, 40 + targetCols[0] + targetCols[1] + targetCols[2], y + 18, { width: targetCols[3], align: 'center' });

        // ═══════════════════════════════════════════════════════════════════
        // PAGE 4: 14-DAY PLAN, CHECKLIST, PARENT SUMMARY & PERFORMANCE INDEX
        // ═══════════════════════════════════════════════════════════════════
        doc.addPage();
        y = 45;

        // ── 11. 14-DAY IMPROVEMENT PLAN ────────────────────────────────────
        y = drawSectionHeader('11. 14-DAY IMPROVEMENT PLAN', y);
        const s11 = fa?.section11FourteenDayPlan;
        (s11?.blocks || []).forEach((blk) => {
          if (y > 730) {
            doc.addPage();
            y = 45;
          }
          doc.rect(40, y, 515, 26).fillAndStroke(lightBg, borderLight);
          doc.rect(40, y, 95, 26).fill('#EEF2FF');
          doc.fillColor(brandIndigo).fontSize(7.5).font(fBold).text(blk.period, 44, y + 8, { width: 87, align: 'center' });

          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(blk.title, 142, y + 4);
          doc.fillColor(mutedText).fontSize(7).font(fRegular).text(
            `${blk.focusChapters.join(', ')}  |  ${blk.activities[0] || 'Standard practice'}  |  ${blk.practiceVolume || ''}`,
            142,
            y + 15,
            { width: 405 },
          );
          y += 28;
        });
        y += 6;

        // ── 12. PERSONALIZED ACTION CHECKLIST ──────────────────────────────
        y = drawSectionHeader('12. PERSONALIZED ACTION CHECKLIST', y);
        const s12 = fa?.section12ActionChecklist;
        doc.rect(40, y, 515, Math.ceil((s12?.items?.length || 8) / 2) * 15 + 4).fillAndStroke(lightBg, borderColor);
        let chkY = y + 4;
        const chkItems = s12?.items || [];
        for (let i = 0; i < chkItems.length; i += 2) {
          const c1 = chkItems[i];
          const c2 = chkItems[i + 1];

          doc.fillColor(brandIndigo).fontSize(8).font(fBold).text('[ ]', 48, chkY);
          doc.fillColor(darkText).fontSize(7).font(fRegular).text(c1?.text || '', 62, chkY + 0.5, { width: 220 });

          if (c2) {
            doc.fillColor(brandIndigo).fontSize(8).font(fBold).text('[ ]', 300, chkY);
            doc.fillColor(darkText).fontSize(7).font(fRegular).text(c2.text, 314, chkY + 0.5, { width: 230 });
          }
          chkY += 15;
        }
        y = chkY + 8;

        // ── 13. PARENT SUMMARY ─────────────────────────────────────────────
        y = drawSectionHeader('13. PARENT SUMMARY', y);
        const s13 = fa?.section13ParentSummary;
        doc.rect(40, y, 515, 52).fillAndStroke('#F8FAFC', borderColor);
        doc.fillColor(darkText).fontSize(7.5).font(fRegular).text(
          s13?.summaryParagraph || 'Student has demonstrated steady performance with opportunities for targeted score expansion in priority subjects.',
          48,
          y + 6,
          { width: 499, lineGap: 2 },
        );
        y += 58;

        // ── 14. BRAINROS PERFORMANCE INDEX ─────────────────────────────────
        y = drawSectionHeader('14. BRAINROS PERFORMANCE INDEX', y);
        const s14 = fa?.section14PerformanceIndex;
        const piCols = [215, 150, 150];
        doc.rect(40, y, 515, 16).fill('#1E293B');
        doc.fillColor('#FFFFFF').fontSize(7).font(fBold).text('Evaluation Dimension', 46, y + 4);
        doc.text('Rating', 255, y + 4, { width: 150, align: 'center' });
        doc.text('Score', 405, y + 4, { width: 150, align: 'center' });
        y += 16;

        (s14?.metrics || []).forEach((m, i) => {
          doc.rect(40, y, 515, 14).fillAndStroke(i % 2 === 0 ? '#FFFFFF' : '#F8FAFC', borderLight);
          doc.fillColor(darkText).fontSize(7.5).font(fBold).text(m.dimension, 46, y + 3);

          // Star representation
          const fullStars = Math.min(5, Math.max(0, Math.round(m.ratingStars)));
          const starStr = '★'.repeat(fullStars) + '☆'.repeat(5 - fullStars);
          doc.fillColor('#D97706').fontSize(8.5).font(fBold).text(starStr, 255, y + 2.5, { width: 150, align: 'center' });

          doc.fillColor(mutedText).fontSize(7.5).font(fRegular).text(m.ratingLabel, 405, y + 3, { width: 150, align: 'center' });
          y += 14;
        });

        // Overall Index Rating Banner
        doc.rect(40, y, 515, 20).fillAndStroke('#EEF2FF', brandIndigo);
        doc.fillColor(brandNavy).fontSize(8).font(fBold).text('OVERALL BRAINROS PERFORMANCE RATING: ', 48, y + 5.5);
        doc.fillColor(brandIndigo).fontSize(9).font(fBold).text(s14?.overallRating || 'VERY GOOD', 255, y + 5);

        doc.end();
      } catch (err) {
        this.logger.error(`[ExamReportPdfService] Failed to generate PDF: ${err.message}`, err.stack);
        reject(err);
      }
    });
  }

  /**
   * Footer stamped on every page dynamically
   */
  private drawPageFooter(doc: any, pageNum: number, totalPages: number) {
    const footerY = 800;
    doc.rect(40, footerY, 515, 0.5).fill('#CBD5E1');
    doc.fillColor('#64748B').fontSize(6.5).font('Helvetica').text(
      `BRAINROS — TEST. ANALYSE. IMPROVE. ACHIEVE.   •   "Every test should tell the student what to study next."   •   Page ${pageNum} of ${totalPages}`,
      40,
      footerY + 6,
      { width: 515, align: 'center' },
    );
  }
}
