import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { ReportGeneratorService } from './report-generator.service';
import { CreateReportJobDto } from '../dto/institution.dto';

const REPORT_RETENTION_DAYS = 7;

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly generator: ReportGeneratorService,
  ) {}

  /**
   * Request a new asynchronous report generation job.
   */
  async createReportJob(
    institutionId: string,
    userId: string,
    dto: CreateReportJobDto,
  ) {
    const validReportTypes = [
      'STUDENT_WISE',
      'BATCH_WISE',
      'SUBJECT_ANALYSIS',
      'CHAPTER_ANALYSIS',
      'RANK_LIST',
    ];

    if (!validReportTypes.includes(dto.reportType)) {
      throw new BadRequestException(
        `Invalid report type '${dto.reportType}'. Valid types: ${validReportTypes.join(', ')}`,
      );
    }

    const format = dto.format?.toUpperCase() === 'PDF' ? 'PDF' : 'XLSX';

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REPORT_RETENTION_DAYS);

    // 1. Create ReportJob record in QUEUED status
    const reportJob = await this.prisma.reportJob.create({
      data: {
        institutionId,
        requestedById: userId,
        reportType: dto.reportType as any,
        format: format as any,
        filters: dto.filters || {},
        status: 'QUEUED',
        expiresAt,
      },
    });

    // 2. Trigger asynchronous generation in background
    this.processReportJobAsync(
      reportJob.id,
      institutionId,
      dto.reportType,
      format,
      dto.filters || {},
    ).catch((err) =>
      this.logger.error(
        `Error in async report background execution: ${err.message}`,
      ),
    );

    return reportJob;
  }

  /**
   * Background execution of report generation.
   */
  private async processReportJobAsync(
    reportJobId: string,
    institutionId: string,
    reportType: string,
    format: 'XLSX' | 'PDF',
    filters: Record<string, any>,
  ) {
    try {
      await this.prisma.reportJob.update({
        where: { id: reportJobId },
        data: { status: 'PROCESSING', startedAt: new Date(), progress: 10 },
      });

      // Generate document buffer
      const { buffer, fileName, contentType } =
        await this.generator.generateReport(
          institutionId,
          reportType,
          format,
          filters,
        );

      await this.prisma.reportJob.update({
        where: { id: reportJobId },
        data: { progress: 60 },
      });

      // Upload to storage
      const storageKey = `reports/${institutionId}/${Date.now()}_${fileName}`;
      await this.storage.uploadFile(storageKey, buffer, contentType);

      // Finalize job record
      await this.prisma.reportJob.update({
        where: { id: reportJobId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          storageKey,
          fileName,
          fileSize: buffer.length,
          completedAt: new Date(),
        },
      });

      this.logger.log(`Report job '${reportJobId}' successfully completed.`);
    } catch (err) {
      this.logger.error(`Report job '${reportJobId}' failed: ${err.message}`);
      await this.prisma.reportJob.update({
        where: { id: reportJobId },
        data: {
          status: 'FAILED',
          error: err.message || 'Report generation error',
        },
      });
    }
  }

  /**
   * List all report jobs for an institution.
   */
  async listReports(institutionId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const [reports, total] = await Promise.all([
      this.prisma.reportJob.findMany({
        where: { institutionId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reportJob.count({ where: { institutionId } }),
    ]);

    return {
      data: reports,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get single report job status.
   */
  async getReportStatus(reportJobId: string) {
    const report = await this.prisma.reportJob.findUnique({
      where: { id: reportJobId },
    });

    if (!report) {
      throw new NotFoundException(`Report job '${reportJobId}' not found.`);
    }

    let downloadUrl: string | null = null;
    if (report.status === 'COMPLETED' && report.storageKey) {
      downloadUrl = await this.storage.getDownloadUrl(report.storageKey);
    }

    return {
      ...report,
      downloadUrl,
    };
  }
}
