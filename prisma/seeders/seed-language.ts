import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Load .env.production if present, otherwise fallback to .env
const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
}

const prisma = new PrismaClient();

const REGIONAL_LANGUAGES = [
  { code: 'en', name: 'English',   nativeName: 'English',   description: 'Universal default language',                      displayOrder: 1 },
  { code: 'kn', name: 'Kannada',   nativeName: 'ಕನ್ನಡ',      description: 'Regional language of Karnataka',                  displayOrder: 2 },
  { code: 'hi', name: 'Hindi',     nativeName: 'हिन्दी',      description: 'National language (Devanagari)',                  displayOrder: 3 },
  { code: 'ta', name: 'Tamil',     nativeName: 'தமிழ்',       description: 'Regional language of Tamil Nadu',                 displayOrder: 4 },
  { code: 'te', name: 'Telugu',    nativeName: 'తెలుగు',      description: 'Regional language of Andhra Pradesh & Telangana', displayOrder: 5 },
  { code: 'mr', name: 'Marathi',   nativeName: 'मराठी',       description: 'Regional language of Maharashtra',                displayOrder: 6 },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം',      description: 'Regional language of Kerala',                    displayOrder: 7 },
  { code: 'bn', name: 'Bengali',   nativeName: 'বাংলা',       description: 'Regional language of West Bengal',                displayOrder: 8 },
  { code: 'gu', name: 'Gujarati',  nativeName: 'ગુજરાતી',     description: 'Regional language of Gujarat',                   displayOrder: 9 },
];

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🌐 SEEDING PREFERRED LANGUAGES');
  console.log('════════════════════════════════════════════════════════════════\n');

  for (const lang of REGIONAL_LANGUAGES) {
    const existing = await prisma.preferredLanguage.findFirst({
      where: {
        OR: [{ code: lang.code }, { name: lang.name }],
      },
    });

    if (!existing) {
      const created = await prisma.preferredLanguage.create({
        data: {
          code: lang.code,
          name: lang.name,
          nativeName: lang.nativeName,
          description: lang.description,
          displayOrder: lang.displayOrder,
          isActive: true,
        },
      });
      console.log(`  ✓ Created: ${created.name} (${created.code}) [${created.id}]`);
    } else {
      const updated = await prisma.preferredLanguage.update({
        where: { id: existing.id },
        data: {
          code: lang.code,
          name: lang.name,
          nativeName: lang.nativeName,
          description: lang.description,
          displayOrder: lang.displayOrder,
          isActive: true,
        },
      });
      console.log(`  ↻ Updated: ${updated.name} (${updated.code}) [${updated.id}]`);
    }
  }

  const allLangs = await prisma.preferredLanguage.findMany({
    orderBy: { displayOrder: 'asc' },
  });

  console.log(`\n✨ Total Preferred Languages in Database: ${allLangs.length}`);
  allLangs.forEach((l, i) => {
    console.log(`  ${i + 1}. ${l.name} (${l.code}) - ${l.nativeName}`);
  });
  console.log('\n✨ All languages seeded successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding preferred languages:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
