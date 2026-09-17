import { Controller, Get, Param, Query, Header } from '@nestjs/common';
import { ExamService } from '../exam.service';
import { ExamFilterDto } from '../dto/exam.dto';

@Controller('public/exams')
export class PublicExamController {
  constructor(private readonly examService: ExamService) {}

  @Get()
  getPublicExams(@Query() filter: ExamFilterDto) {
    return this.examService.findExams(filter);
  }

  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml')
  async getDynamicSitemap() {
    const examsResult = await this.examService.findExams({ limit: 100 });
    const exams = Array.isArray(examsResult)
      ? examsResult
      : (examsResult as any)?.data || [];

    const baseDomain = 'https://www.brainros.com';
    const now = new Date().toISOString().split('T')[0];

    const staticUrls = [
      { loc: `${baseDomain}/`, priority: '1.0', changefreq: 'daily' },
      { loc: `${baseDomain}/exams`, priority: '0.9', changefreq: 'daily' },
      { loc: `${baseDomain}/exams/neet`, priority: '0.9', changefreq: 'weekly' },
      { loc: `${baseDomain}/exams/jee`, priority: '0.9', changefreq: 'weekly' },
      { loc: `${baseDomain}/exams/cet`, priority: '0.8', changefreq: 'weekly' },
      { loc: `${baseDomain}/about`, priority: '0.7', changefreq: 'monthly' },
      { loc: `${baseDomain}/contact`, priority: '0.6', changefreq: 'monthly' },
      { loc: `${baseDomain}/login`, priority: '0.5', changefreq: 'monthly' },
      { loc: `${baseDomain}/register`, priority: '0.5', changefreq: 'monthly' },
    ];

    const dynamicExamUrls = exams.map((ex: any) => ({
      loc: `${baseDomain}/exams/${ex.id}`,
      priority: '0.8',
      changefreq: 'weekly',
      lastmod: ex.updatedAt ? new Date(ex.updatedAt).toISOString().split('T')[0] : now,
    }));

    const allUrls = [...staticUrls, ...dynamicExamUrls];

    const xmlItems = allUrls
      .map(
        (item) => `  <url>
    <loc>${item.loc}</loc>
    <lastmod>${item.lastmod || now}</lastmod>
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>
  </url>`,
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlItems}
</urlset>`;
  }

  @Get(':id')
  getPublicExamById(@Param('id') id: string) {
    return this.examService.findExamById(id);
  }
}
