import { v2 as cloudinary } from 'cloudinary';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

cloudinary.config({
  cloud_name: 'dnmjmdf1n',
  api_key: '455258273723275',
  api_secret: '2zN1fmD0ZAqF_9QR1MZtVpqKjqE',
});

// SVG for Circuit Diagram
const circuitSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320" width="600" height="320">
  <defs>
    <style>
      .wire { stroke: #1e293b; stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .text { font-family: system-ui, -apple-system, sans-serif; font-size: 15px; fill: #0f172a; font-weight: 600; text-anchor: middle; }
      .label { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; fill: #475569; text-anchor: middle; }
      .battery-long { stroke: #0284c7; stroke-width: 3.5; }
      .battery-short { stroke: #0284c7; stroke-width: 5; }
      .node { fill: #0f172a; }
      .resistor { stroke: #d97706; stroke-width: 3.5; fill: none; }
    </style>
  </defs>
  <rect width="600" height="320" fill="#f8fafc" rx="12" stroke="#e2e8f0" stroke-width="2"/>
  
  <!-- Outer Circuit Wire -->
  <path d="M 80 80 L 220 80" class="wire" />
  <!-- Resistor 1: 3 Ohm -->
  <path d="M 220 80 L 230 65 L 245 95 L 260 65 L 275 95 L 290 65 L 305 95 L 315 80" class="resistor" />
  <path d="M 315 80 L 520 80 L 520 240 L 400 240" class="wire" />
  
  <!-- Battery: 12V -->
  <path d="M 400 240 L 320 240" class="wire" />
  <line x1="320" y1="220" x2="320" y2="260" class="battery-long" />
  <line x1="310" y1="228" x2="310" y2="252" class="battery-short" />
  <line x1="300" y1="220" x2="300" y2="260" class="battery-long" />
  <line x1="290" y1="228" x2="290" y2="252" class="battery-short" />
  <path d="M 290 240 L 80 240 L 80 80" class="wire" />
  
  <!-- Middle Branch with 4 Ohm Resistor -->
  <circle cx="300" cy="80" r="4.5" class="node" />
  <circle cx="300" cy="240" r="4.5" class="node" />
  <path d="M 300 80 L 300 120" class="wire" />
  <path d="M 300 120 L 285 130 L 315 145 L 285 160 L 315 175 L 285 190 L 315 205 L 300 215" class="resistor" />
  <path d="M 300 215 L 300 240" class="wire" />
  
  <!-- Labels -->
  <text x="268" y="55" class="text">3 Ω</text>
  <text x="345" y="165" class="text">4 Ω</text>
  <text x="305" y="280" class="text">12 V</text>
  <text x="330" y="215" class="label">+</text>
  <text x="280" y="215" class="label">-</text>
  <text x="300" y="30" class="text" fill="#1e40af">Circuit Diagram</text>
</svg>`;

// Graph A (Correct: 0 for r < R/2, increases for R/2 < r < R, decays 1/r for r > R)
const graphASvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 200" width="280" height="200">
  <rect width="280" height="200" fill="#ffffff" rx="8" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="20" y="28" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0f172a">A</text>
  <!-- Axes -->
  <line x1="40" y1="160" x2="250" y2="160" stroke="#334155" stroke-width="2" />
  <line x1="40" y1="160" x2="40" y2="30" stroke="#334155" stroke-width="2" />
  <text x="255" y="165" font-family="sans-serif" font-size="12" fill="#334155">r</text>
  <text x="35" y="25" font-family="sans-serif" font-size="12" fill="#334155">|B|</text>
  <!-- Labels R/2 and R -->
  <line x1="100" y1="160" x2="100" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="100" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R/2</text>
  <line x1="160" y1="160" x2="160" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="160" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R</text>
  <!-- Curve: 0 from 40 to 100, curved up from 100 to 160, 1/r decay after 160 -->
  <path d="M 40 160 L 100 160 Q 135 150 160 70 Q 195 120 240 140" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Graph B (Linear from origin to R, decay)
const graphBSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 200" width="280" height="200">
  <rect width="280" height="200" fill="#ffffff" rx="8" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="20" y="28" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0f172a">B</text>
  <line x1="40" y1="160" x2="250" y2="160" stroke="#334155" stroke-width="2" />
  <line x1="40" y1="160" x2="40" y2="30" stroke="#334155" stroke-width="2" />
  <text x="255" y="165" font-family="sans-serif" font-size="12" fill="#334155">r</text>
  <text x="35" y="25" font-family="sans-serif" font-size="12" fill="#334155">|B|</text>
  <line x1="100" y1="160" x2="100" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="100" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R/2</text>
  <line x1="160" y1="160" x2="160" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="160" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R</text>
  <!-- Straight line from 0 to R, then decay -->
  <path d="M 40 160 L 160 70 Q 195 120 240 140" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Graph C (Constant then decay)
const graphCSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 200" width="280" height="200">
  <rect width="280" height="200" fill="#ffffff" rx="8" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="20" y="28" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0f172a">C</text>
  <line x1="40" y1="160" x2="250" y2="160" stroke="#334155" stroke-width="2" />
  <line x1="40" y1="160" x2="40" y2="30" stroke="#334155" stroke-width="2" />
  <text x="255" y="165" font-family="sans-serif" font-size="12" fill="#334155">r</text>
  <text x="35" y="25" font-family="sans-serif" font-size="12" fill="#334155">|B|</text>
  <line x1="100" y1="160" x2="100" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="100" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R/2</text>
  <line x1="160" y1="160" x2="160" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="160" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R</text>
  <!-- Constant 0 then step up to constant then decay -->
  <path d="M 40 160 L 100 160 L 100 80 L 160 80 Q 195 125 240 145" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Graph D (Inverse)
const graphDSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 200" width="280" height="200">
  <rect width="280" height="200" fill="#ffffff" rx="8" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="20" y="28" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0f172a">D</text>
  <line x1="40" y1="160" x2="250" y2="160" stroke="#334155" stroke-width="2" />
  <line x1="40" y1="160" x2="40" y2="30" stroke="#334155" stroke-width="2" />
  <text x="255" y="165" font-family="sans-serif" font-size="12" fill="#334155">r</text>
  <text x="35" y="25" font-family="sans-serif" font-size="12" fill="#334155">|B|</text>
  <line x1="100" y1="160" x2="100" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="100" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R/2</text>
  <line x1="160" y1="160" x2="160" y2="165" stroke="#64748b" stroke-width="1.5"/>
  <text x="160" y="178" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#64748b">R</text>
  <!-- Decay immediately -->
  <path d="M 40 50 Q 80 120 160 145 L 240 155" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

async function uploadSvg(svgStr: string, publicId: string): Promise<string> {
  const base64Data = `data:image/svg+xml;base64,${Buffer.from(svgStr).toString('base64')}`;
  const res = await cloudinary.uploader.upload(base64Data, {
    public_id: publicId,
    folder: 'exam_questions',
    overwrite: true,
    resource_type: 'image',
  });
  return res.secure_url;
}

async function run() {
  console.log('Uploading SVGs to Cloudinary...');
  const circuitUrl = await uploadSvg(circuitSvg, 'circuit_diagram_jee_q1');
  console.log('Circuit URL:', circuitUrl);

  const graphAUrl = await uploadSvg(graphASvg, 'graph_a_cylinder_q2');
  console.log('Graph A URL:', graphAUrl);

  const graphBUrl = await uploadSvg(graphBSvg, 'graph_b_cylinder_q2');
  console.log('Graph B URL:', graphBUrl);

  const graphCUrl = await uploadSvg(graphCSvg, 'graph_c_cylinder_q2');
  console.log('Graph C URL:', graphCUrl);

  const graphDUrl = await uploadSvg(graphDSvg, 'graph_d_cylinder_q2');
  console.log('Graph D URL:', graphDUrl);

  // Now update database
  const connectionString = "postgresql://brainros:ezGiFsS3ZVaswPzhWCAobvGdp9lisiE7@dpg-dan18dp42hec73cr26d0-a.oregon-postgres.render.com/brainros";
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter } as any);

  const examId = 'd500b151-d82f-45d0-b672-0b55e2d9c4cc';
  console.log(`\nUpdating exam ${examId} in database...`);

  const q1Content = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'In the circuit shown in the figure, the current through the circuit branch is:' }
        ]
      },
      {
        type: 'image',
        attrs: {
          src: circuitUrl,
          alt: 'Circuit Diagram'
        }
      }
    ]
  };

  const optUrls = {
    A: graphAUrl,
    B: graphBUrl,
    C: graphCUrl,
    D: graphDUrl,
  };

  // Find EVQs
  const evQuestions = await prisma.examVersionQuestion.findMany({
    where: { examVersion: { examId } },
    include: { options: true, translations: true },
    orderBy: { sequenceNumber: 'asc' },
  });

  console.log(`Found ${evQuestions.length} ExamVersionQuestions`);

  // Update Q1
  if (evQuestions.length > 0) {
    const q1 = evQuestions[0];
    console.log(`Updating Q1 (${q1.id})...`);
    await prisma.examVersionQuestion.update({
      where: { id: q1.id },
      data: { questionContent: q1Content as any },
    });
    if (q1.sourceQuestionId) {
      await prisma.question.update({
        where: { id: q1.sourceQuestionId },
        data: { questionContent: q1Content as any },
      });
      // also update translation if exists
      await prisma.questionTranslation.updateMany({
        where: { questionId: q1.sourceQuestionId },
        data: { questionContent: q1Content as any },
      });
    }
  }

  // Update Q2 Options
  if (evQuestions.length > 1) {
    const q2 = evQuestions[1];
    console.log(`Updating Q2 (${q2.id}) options...`);
    for (const opt of q2.options) {
      const url = (optUrls as any)[opt.optionKey];
      if (url) {
        const optContent = {
          type: 'doc',
          content: [
            {
              type: 'image',
              attrs: {
                src: url,
                alt: `Graph ${opt.optionKey}`
              }
            }
          ]
        };

        await prisma.examVersionOption.update({
          where: { id: opt.id },
          data: { optionContent: optContent as any },
        });

        if (opt.sourceOptionId) {
          await prisma.questionOption.update({
            where: { id: opt.sourceOptionId },
            data: { optionContent: optContent as any },
          });
          await prisma.questionOptionTranslation.updateMany({
            where: { optionId: opt.sourceOptionId },
            data: { optionContent: optContent as any },
          });
        }
      }
    }
  }

  console.log('Successfully updated all images with valid Cloudinary URLs!');
  await prisma.$disconnect();
  await pool.end();
}

run().catch(console.error);
