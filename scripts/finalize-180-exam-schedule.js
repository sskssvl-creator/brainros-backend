const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const examId = 'd466b5a3-8347-4567-97e8-473c7f3fffa5';

async function main() {
  console.log('1. Enabling all 8 regional languages for exam:', examId);
  const activeLangs = await prisma.preferredLanguage.findMany({ where: { isActive: true } });

  for (let i = 0; i < activeLangs.length; i++) {
    const l = activeLangs[i];
    await prisma.examLanguage.upsert({
      where: {
        examId_languageId: { examId, languageId: l.id },
      },
      create: {
        examId,
        languageId: l.id,
        isDefault: (l.code || '').toLowerCase() === 'en',
        displayOrder: i + 1,
      },
      update: {},
    });
  }
  console.log(`Attached ${activeLangs.length} languages (English + 8 regional).`);

  // 2. Set status to PUBLISHED
  const publishedStatus = await prisma.examStatus.findUnique({ where: { name: 'PUBLISHED' } });
  if (publishedStatus) {
    await prisma.exam.update({
      where: { id: examId },
      data: { statusId: publishedStatus.id },
    });
    console.log('Exam status updated to PUBLISHED.');
  }

  // 3. Create active schedule
  const now = new Date();
  const startTime = new Date(now.getTime() - 1000 * 60 * 5); // 5 mins ago
  const endTime = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days ahead

  const superAdmin = await prisma.user.findFirst({ where: { email: 'superadmin@brainros.test' } });
  const schedule = await prisma.examSchedule.create({
    data: {
      exam: { connect: { id: examId } },
      examVersion: { connect: { id: '83f4b1dd-de6a-4a8f-8b88-efb7ce655b13' } },
      scheduledBy: { connect: { id: superAdmin.id } },
      startTime,
      endTime,
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
    },
  });

  console.log('Active schedule created. Ready for AI Translation and Student attempt!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
