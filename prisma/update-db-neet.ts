import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Checking database for NEET blueprints and exams...');

  // Update TEMPLATE_NEET exam if totalQuestions is 200
  const updatedExams = await prisma.exam.updateMany({
    where: {
      totalQuestions: 200,
    },
    data: {
      totalQuestions: 180,
    },
  });
  console.log(`Updated ${updatedExams.count} exams with 200 questions to 180 questions.`);

  // Update ExamBlueprint if totalQuestions is 200
  const updatedBlueprints = await (prisma as any).examBlueprint.updateMany({
    where: {
      totalQuestions: 200,
    },
    data: {
      totalQuestions: 180,
    },
  });
  console.log(`Updated ${updatedBlueprints.count} blueprints with 200 questions to 180 questions.`);

  // Update blueprint rules with selectionCount: 50 -> 45
  const updatedRules = await (prisma as any).blueprintRule.updateMany({
    where: {
      selectionCount: 50,
    },
    data: {
      selectionCount: 45,
    },
  });
  console.log(`Updated ${updatedRules.count} blueprint rules with 50 questions to 45 questions.`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
