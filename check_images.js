require('dotenv').config();
const { PrismaClient } = require('./node_modules/.prisma/client');

const prisma = new PrismaClient();

async function main() {
  const qs = await prisma.question.findMany({
    where: { questionContent: { not: null } },
    select: { id: true, questionContent: true },
    take: 5,
  });

  console.log('Found ' + qs.length + ' questions with questionContent');
  for (const q of qs) {
    const content = JSON.stringify(q.questionContent);
    const hasImage = content.includes('"image"') || content.includes('"src"');
    console.log('Q_ID: ' + q.id);
    console.log('Has image node: ' + hasImage);
    console.log('Content preview: ' + content.substring(0, 500));
    console.log('---');
  }

  const opts = await prisma.questionOption.findMany({
    where: { optionContent: { not: null } },
    select: { id: true, questionId: true, optionContent: true },
    take: 5,
  });

  console.log('\nFound ' + opts.length + ' options with optionContent');
  for (const o of opts) {
    const content = JSON.stringify(o.optionContent);
    const hasImage = content.includes('"image"') || content.includes('"src"');
    console.log('OPT_ID: ' + o.id + ', Q_ID: ' + o.questionId);
    console.log('Has image: ' + hasImage);
    console.log('Content preview: ' + content.substring(0, 500));
    console.log('---');
  }

  const trans = await prisma.questionTranslation.findMany({
    where: { questionContent: { not: null } },
    select: { id: true, questionId: true, questionContent: true },
    take: 3,
  });
  console.log('\nFound ' + trans.length + ' translations with questionContent');
  for (const t of trans) {
    const content = JSON.stringify(t.questionContent);
    const hasImage = content.includes('"image"') || content.includes('"src"');
    console.log('TRANS_ID: ' + t.id + ', Q_ID: ' + t.questionId);
    console.log('Has image: ' + hasImage);
    console.log('Content preview: ' + content.substring(0, 500));
    console.log('---');
  }

  await prisma.$disconnect();
}

main().catch(function(e) {
  console.error(e);
  process.exit(1);
});
