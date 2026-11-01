/**
 * Remediate Translation Integrity & Invalidate Redis Exam Caches
 *
 * 1. Backfills missing English QuestionOptionTranslation records from QuestionOption.optionText & optionContent
 * 2. Backfills missing English ExamVersionOptionTranslation records from ExamVersionOption.optionText & optionContent
 * 3. Sets isDefault: true on English in ExamLanguage where no default language is set
 * 4. Invalidates Redis exam question snapshots and attempt cache keys
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

const prisma = new PrismaClient();

async function main() {
  console.log('=== Starting Translation Integrity Remediation ===');

  // 1. Resolve English PreferredLanguage
  const enLang =
    (await prisma.preferredLanguage.findFirst({ where: { code: 'en' } })) ||
    (await prisma.preferredLanguage.findFirst());

  if (!enLang) {
    console.error('CRITICAL: No English or preferred language found in database!');
    process.exit(1);
  }
  console.log(`Resolved English language ID: ${enLang.id} (${enLang.code})`);

  // 2. Backfill QuestionOptionTranslation for English
  const allQuestionOptions = await prisma.questionOption.findMany({
    include: {
      translations: {
        where: { languageId: enLang.id },
      },
    },
  });

  let qOptBackfilled = 0;
  for (const opt of allQuestionOptions) {
    if (opt.translations.length === 0) {
      await prisma.questionOptionTranslation.create({
        data: {
          optionId: opt.id,
          languageId: enLang.id,
          optionText: opt.optionText || opt.optionLabel || '',
          optionContent: opt.optionContent || null,
        },
      });
      qOptBackfilled++;
    }
  }
  console.log(`Backfilled ${qOptBackfilled} English QuestionOptionTranslation records (out of ${allQuestionOptions.length} total options).`);

  // 3. Backfill ExamVersionOptionTranslation for English
  const allEvOptions = await prisma.examVersionOption.findMany({
    include: {
      translations: {
        where: { languageId: enLang.id },
      },
    },
  });

  let evOptBackfilled = 0;
  for (const evOpt of allEvOptions) {
    if (evOpt.translations.length === 0) {
      await prisma.examVersionOptionTranslation.create({
        data: {
          examVersionOptionId: evOpt.id,
          languageId: enLang.id,
          languageCode: 'en',
          optionText: evOpt.optionText || evOpt.optionLabel || '',
          optionContent: evOpt.optionContent || null,
        },
      });
      evOptBackfilled++;
    }
  }
  console.log(`Backfilled ${evOptBackfilled} English ExamVersionOptionTranslation records (out of ${allEvOptions.length} total EV options).`);

  // 4. Ensure every exam with ExamLanguage has an active default language
  const examLanguages = await prisma.examLanguage.findMany({
    include: { language: true },
  });

  const examMap = new Map();
  for (const el of examLanguages) {
    if (!examMap.has(el.examId)) examMap.set(el.examId, []);
    examMap.get(el.examId).push(el);
  }

  let defaultsFixed = 0;
  for (const [examId, langs] of examMap.entries()) {
    const hasDefault = langs.some((l) => l.isDefault);
    if (!hasDefault) {
      // Find English or first
      const enEl = langs.find((l) => l.language?.code?.toLowerCase() === 'en') || langs[0];
      if (enEl) {
        await prisma.examLanguage.update({
          where: { id: enEl.id },
          data: { isDefault: true },
        });
        defaultsFixed++;
        console.log(`Set isDefault: true for exam ${examId} on language ${enEl.language?.name || enEl.languageId}`);
      }
    }
  }
  console.log(`Fixed default language for ${defaultsFixed} exams.`);

  // 5. Invalidate Redis Caches
  try {
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    const redisPassword = process.env.REDIS_PASSWORD || undefined;

    const redis = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword,
      lazyConnect: true,
      connectTimeout: 2000,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });

    redis.on('error', (e) => {
      // suppress unhandled errors
    });

    await redis.connect();
    console.log('Connected to Redis.');

    const snapshotKeys = await redis.keys('exam:*:snapshot*');
    const attemptKeys = await redis.keys('attempt:*:state*');
    const allKeys = [...snapshotKeys, ...attemptKeys];

    if (allKeys.length > 0) {
      await redis.del(...allKeys);
      console.log(`Cleared ${allKeys.length} Redis cache keys (${snapshotKeys.length} snapshots, ${attemptKeys.length} attempt states).`);
    } else {
      console.log('No matching Redis cache keys to clear.');
    }

    await redis.quit();
  } catch (err) {
    console.warn(`Redis cleanup note: ${err.message}`);
  }

  console.log('=== Remediation Completed Successfully ===');
}

main()
  .catch((err) => {
    console.error('Remediation error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
