const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const job = await prisma.aiTranslationJob.findUnique({ where: { id: '294a4a14-1814-4901-bee4-5dc24022a82a' } });
  if (!job) { console.log('Job not found'); return; }
  console.log('Current status:', job.status);
  
  // Reset all language statuses to WAITING
  const langStatuses = (job.languageStatuses || []);
  const resetStatuses = langStatuses.map(l => ({
    ...l,
    status: 'WAITING',
    completedQuestions: 0,
    failedBatches: 0,
    errorMessage: undefined,
  }));
  
  await prisma.aiTranslationJob.update({
    where: { id: '294a4a14-1814-4901-bee4-5dc24022a82a' },
    data: {
      status: 'QUEUED',
      overallProgress: 0,
      languageStatuses: resetStatuses,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
    },
  });
  console.log('Job reset to QUEUED with all languages WAITING');
  await prisma.$disconnect();
})().catch(async e => { console.error(e); await prisma.$disconnect(); });
