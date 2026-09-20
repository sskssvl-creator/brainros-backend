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

const SUBJECTS_DATA = [
  {
    name: 'Physics',
    code: 'PHY',
    displayOrder: 1,
    chapters: [
      'Units and Measurements',
      'Motion in a Straight Line & Plane',
      'Laws of Motion',
      'Work, Energy and Power',
      'System of Particles & Rotational Motion',
      'Gravitation',
      'Mechanical Properties of Solids & Fluids',
      'Thermodynamics & Kinetic Theory',
      'Oscillations and Waves',
      'Electrostatics & Potential',
      'Current Electricity',
      'Magnetic Effects of Current & Magnetism',
      'Electromagnetic Induction & AC',
      'Electromagnetic Waves',
      'Ray and Wave Optics',
      'Dual Nature of Radiation and Matter',
      'Atoms and Nuclei',
      'Semiconductor Electronics',
    ],
  },
  {
    name: 'Chemistry',
    code: 'CHEM',
    displayOrder: 2,
    chapters: [
      'Some Basic Concepts of Chemistry',
      'Structure of Atom',
      'Classification of Elements & Periodicity',
      'Chemical Bonding and Molecular Structure',
      'Chemical Thermodynamics',
      'Equilibrium',
      'Redox Reactions',
      'Organic Chemistry - Some Basic Principles & Techniques',
      'Hydrocarbons',
      'Solutions',
      'Electrochemistry',
      'Chemical Kinetics',
      'd and f Block Elements',
      'Coordination Compounds',
      'Haloalkanes and Haloarenes',
      'Alcohols, Phenols and Ethers',
      'Aldehydes, Ketones and Carboxylic Acids',
      'Amines',
      'Biomolecules',
    ],
  },
  {
    name: 'Mathematics',
    code: 'MATH',
    displayOrder: 3,
    chapters: [
      'Sets, Relations and Functions',
      'Trigonometric Functions & Inverse Trigonometry',
      'Complex Numbers and Quadratic Equations',
      'Linear Inequalities',
      'Permutations and Combinations',
      'Binomial Theorem',
      'Sequences and Series',
      'Straight Lines and Conic Sections',
      'Introduction to 3D Geometry & Vectors',
      'Limits, Continuity and Differentiability',
      'Applications of Derivatives',
      'Integrals (Definite & Indefinite)',
      'Applications of Integrals',
      'Differential Equations',
      'Matrices and Determinants',
      'Probability and Statistics',
    ],
  },
  {
    name: 'Biology',
    code: 'BIO',
    displayOrder: 4,
    chapters: [
      'The Living World & Biological Classification',
      'Plant Kingdom',
      'Animal Kingdom',
      'Morphology & Anatomy of Flowering Plants',
      'Structural Organisation in Animals',
      'Cell: The Unit of Life & Cell Cycle',
      'Biomolecules (Biology)',
      'Photosynthesis & Respiration in Plants',
      'Plant Growth and Development',
      'Breathing and Exchange of Gases',
      'Body Fluids and Circulation',
      'Excretory Products and their Elimination',
      'Locomotion and Movement',
      'Neural Control and Chemical Coordination',
      'Reproduction in Organisms & Flowering Plants',
      'Human Reproduction and Reproductive Health',
      'Principles of Inheritance and Variation (Genetics)',
      'Molecular Basis of Inheritance',
      'Evolution',
      'Human Health and Disease',
      'Biotechnology: Principles and Processes',
      'Biotechnology and its Applications',
      'Organisms and Populations',
      'Ecosystem, Biodiversity and Conservation',
    ],
  },
];

// Target Exam mapping for subjects
const TARGET_SUBJECT_MAP: Record<string, string[]> = {
  'JEE': ['Physics', 'Chemistry', 'Mathematics'],
  'NEET': ['Physics', 'Chemistry', 'Biology'],
  'CET': ['Physics', 'Chemistry', 'Mathematics', 'Biology'],
  'NEET and JEE': ['Physics', 'Chemistry', 'Mathematics', 'Biology'],
  'NEET and State CET': ['Physics', 'Chemistry', 'Biology'],
  'JEE and State CET': ['Physics', 'Chemistry', 'Mathematics'],
  'JEE, NEET and State CET': ['Physics', 'Chemistry', 'Mathematics', 'Biology'],
};

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('📖 SEEDING 4 CORE SUBJECTS & CHAPTERS');
  console.log('════════════════════════════════════════════════════════════════\n');

  const subjectMap = new Map<string, string>(); // name -> id

  // 1. Seed Subjects and their Chapters
  for (const s of SUBJECTS_DATA) {
    const subject = await prisma.subject.upsert({
      where: { name: s.name },
      update: {
        code: s.code,
        displayOrder: s.displayOrder,
        isActive: true,
      },
      create: {
        name: s.name,
        code: s.code,
        displayOrder: s.displayOrder,
        isActive: true,
      },
    });

    subjectMap.set(s.name, subject.id);
    console.log(`\n📚 Subject: ${subject.name} (${subject.code})`);

    // Seed Chapters under this Subject
    let chOrder = 1;
    for (const chName of s.chapters) {
      const chapter = await prisma.chapter.upsert({
        where: {
          subjectId_name: {
            subjectId: subject.id,
            name: chName,
          },
        },
        update: {
          displayOrder: chOrder,
          isActive: true,
        },
        create: {
          subjectId: subject.id,
          name: chName,
          displayOrder: chOrder,
          isActive: true,
        },
      });
      console.log(`  ├── Ch ${chOrder}: ${chapter.name}`);
      chOrder++;
    }
  }

  // 2. Link Subjects to Target Exams
  console.log('\n🔗 Linking Subjects to Target Exams...');
  const allTargets = await prisma.examTarget.findMany();

  for (const target of allTargets) {
    const relevantSubjectNames = TARGET_SUBJECT_MAP[target.name] || ['Physics', 'Chemistry', 'Mathematics', 'Biology'];
    
    let order = 1;
    for (const subName of relevantSubjectNames) {
      const subId = subjectMap.get(subName);
      if (subId) {
        await prisma.examTargetSubject.upsert({
          where: {
            examTargetId_subjectId: {
              examTargetId: target.id,
              subjectId: subId,
            },
          },
          update: {
            displayOrder: order,
          },
          create: {
            examTargetId: target.id,
            subjectId: subId,
            displayOrder: order,
          },
        });
        order++;
      }
    }
    console.log(`  ✓ Linked ${relevantSubjectNames.join(', ')} ➔ ${target.name}`);
  }

  console.log('\n✨ All 4 core subjects, chapters, and target exam links seeded successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding subjects and chapters:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
