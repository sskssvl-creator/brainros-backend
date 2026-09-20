const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    await prisma.$connect();
    console.log('Successfully connected to database via Prisma!');
    const usersCount = await prisma.user.count();
    const studentsCount = await prisma.student.count();
    const examsCount = await prisma.exam.count();
    const attemptsCount = await prisma.attempt.count();
    const questionsCount = await prisma.question.count();
    const billsCount = await prisma.bill.count();
    const notificationsCount = await prisma.notification.count();
    console.log({
      usersCount,
      studentsCount,
      examsCount,
      attemptsCount,
      questionsCount,
      billsCount,
      notificationsCount,
    });
  } catch (err) {
    console.error('Connection error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}
main();
