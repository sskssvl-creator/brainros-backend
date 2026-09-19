import { SeedContext, SeederResult } from './types';
import {
  NotificationChannel,
  NotificationType,
  DataQualityStatus,
} from '@prisma/client';

export async function seedMasterData(ctx: SeedContext): Promise<SeederResult> {
  const start = Date.now();
  const created: Record<string, number> = {};
  const reused: Record<string, number> = {};

  const inc = (type: string, isNew: boolean) => {
    if (isNew) created[type] = (created[type] || 0) + 1;
    else reused[type] = (reused[type] || 0) + 1;
  };

  const { prisma } = ctx;

  // 1. Roles
  const rolesList = [
    { name: 'SUPER_ADMIN', description: 'System Super Administrator with unrestricted access' },
    { name: 'ADMIN', description: 'Academic and Platform Administrator' },
    { name: 'STUDENT', description: 'Registered Test Candidate / Student' },
    { name: 'PARENT', description: 'Parent / Guardian with performance view' },
    { name: 'INSTITUTION_ADMIN', description: 'B2B Institution Administrator' },
    { name: 'SALES_AGENT', description: 'Partner and Sales Representative' },
    { name: 'ACCOUNTANT', description: 'Billing and Financial Auditor' },
  ];

  for (const r of rolesList) {
    const existing = await prisma.role.findUnique({ where: { name: r.name } });
    if (existing) {
      ctx.roles.set(r.name, existing);
      inc('roles', false);
    } else {
      const rec = await prisma.role.create({ data: r });
      ctx.roles.set(r.name, rec);
      inc('roles', true);
    }
  }

  // 2. Permissions
  const permissionsList = [
    { code: 'exam:create', description: 'Create exams' },
    { code: 'exam:edit', description: 'Edit exams' },
    { code: 'exam:approve', description: 'Approve exams for publishing' },
    { code: 'exam:schedule', description: 'Schedule exams' },
    { code: 'exam:activate', description: 'Activate live exams' },
    { code: 'exam:attempt', description: 'Attempt student exams' },
    { code: 'question:create', description: 'Author questions' },
    { code: 'question:review', description: 'Review & approve questions' },
    { code: 'chapter:view', description: 'View chapters' },
    { code: 'chapter:create', description: 'Create chapters' },
    { code: 'chapter:update', description: 'Update chapters' },
    { code: 'chapter:delete', description: 'Delete/archive chapters' },
    { code: 'chapter:manage', description: 'Full chapter master management' },
    { code: 'student:manage', description: 'Manage student profiles' },
    { code: 'institution:manage', description: 'Manage institutions & batches' },
    { code: 'analytics:view', description: 'View performance analytics' },
    { code: 'parent:view', description: 'View linked student analytics' },
  ];

  for (const p of permissionsList) {
    const existing = await prisma.permission.findUnique({ where: { code: p.code } });
    if (existing) {
      ctx.permissions.set(p.code, existing);
      inc('permissions', false);
    } else {
      const rec = await prisma.permission.create({ data: p });
      ctx.permissions.set(p.code, rec);
      inc('permissions', true);
    }
  }

  // Link permissions to SUPER_ADMIN & ADMIN
  const superAdminRole = ctx.roles.get('SUPER_ADMIN');
  if (superAdminRole) {
    for (const p of ctx.permissions.values()) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: superAdminRole.id, permissionId: p.id } },
        update: {},
        create: { roleId: superAdminRole.id, permissionId: p.id },
      });
    }
  }

  const adminRole = ctx.roles.get('ADMIN');
  if (adminRole) {
    const adminPermCodes = [
      'exam:create',
      'exam:edit',
      'exam:schedule',
      'question:create',
      'question:review',
      'chapter:view',
      'student:manage',
      'analytics:view',
    ];
    for (const code of adminPermCodes) {
      const p = ctx.permissions.get(code);
      if (p) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: adminRole.id, permissionId: p.id } },
          update: {},
          create: { roleId: adminRole.id, permissionId: p.id },
        });
      }
    }
  }

  // 3. Preferred Languages (9 Mandatory Regional Languages)
  const languagesList = [
    { code: 'en', name: 'ENGLISH', nativeName: 'English', displayOrder: 1 },
    { code: 'kn', name: 'KANNADA', nativeName: 'ಕನ್ನಡ', displayOrder: 2 },
    { code: 'hi', name: 'HINDI', nativeName: 'हिन्दी', displayOrder: 3 },
    { code: 'ta', name: 'TAMIL', nativeName: 'தமிழ்', displayOrder: 4 },
    { code: 'te', name: 'TELUGU', nativeName: 'తెలుగు', displayOrder: 5 },
    { code: 'mr', name: 'MARATHI', nativeName: 'मराठी', displayOrder: 6 },
    { code: 'ml', name: 'MALAYALAM', nativeName: 'മലയാളം', displayOrder: 7 },
    { code: 'bn', name: 'BENGALI', nativeName: 'বাংলা', displayOrder: 8 },
    { code: 'gu', name: 'GUJARATI', nativeName: 'ગુજરાતી', displayOrder: 9 },
  ];

  for (const l of languagesList) {
    const existing = await prisma.preferredLanguage.findFirst({
      where: { OR: [{ code: l.code }, { name: l.name }] },
    });
    if (existing) {
      ctx.languages.set(l.code, existing);
      ctx.languages.set(l.name, existing);
      inc('languages', false);
    } else {
      const rec = await prisma.preferredLanguage.create({ data: l });
      ctx.languages.set(l.code, rec);
      ctx.languages.set(l.name, rec);
      inc('languages', true);
    }
  }

  // 4. Student Classes
  const classesList = [
    { name: 'CLASS_11', description: '11th Standard / 1st PUC' },
    { name: 'CLASS_12', description: '12th Standard / 2nd PUC' },
    { name: 'DROPPER', description: 'Repeater / Long Term Batch' },
    { name: 'FOUNDATION', description: '9th & 10th Foundation' },
  ];

  for (const c of classesList) {
    const existing = await prisma.studentClass.findUnique({ where: { name: c.name } });
    if (existing) {
      ctx.classes.set(c.name, existing);
      inc('student_classes', false);
    } else {
      const rec = await prisma.studentClass.create({ data: c });
      ctx.classes.set(c.name, rec);
      inc('student_classes', true);
    }
  }

  // 5. Exam Targets (Focus Exams: JEE, CET, NEET & Combos)
  const targetsList = [
    { name: 'JEE', description: 'Joint Entrance Examination (Engineering)' },
    { name: 'CET', description: 'Common Entrance Test (State Level)' },
    { name: 'NEET', description: 'National Eligibility cum Entrance Test (UG Medical)' },
    { name: 'NEET + JEE', description: 'NEET and JEE Combo' },
    { name: 'NEET + State CET', description: 'NEET and State CET Combo' },
    { name: 'JEE + State CET', description: 'JEE and State CET Combo' },
    { name: 'JEE + NEET + State CET', description: 'JEE, NEET and State CET All-in-One Combo' },
  ];

  for (const t of targetsList) {
    const existing = await prisma.examTarget.findUnique({ where: { name: t.name } });
    if (existing) {
      ctx.examTargets.set(t.name, existing);
      inc('exam_targets', false);
    } else {
      const rec = await prisma.examTarget.create({ data: t });
      ctx.examTargets.set(t.name, rec);
      inc('exam_targets', true);
    }
  }

  // 6. Difficulty Levels
  const difficultiesList = [
    { name: 'EASY', displayOrder: 1 },
    { name: 'MEDIUM', displayOrder: 2 },
    { name: 'HARD', displayOrder: 3 },
    { name: 'VERY_HARD', displayOrder: 4 },
  ];

  for (const d of difficultiesList) {
    const existing = await prisma.difficultyLevel.findUnique({ where: { name: d.name } });
    if (existing) {
      ctx.difficulties.set(d.name, existing);
      inc('difficulty_levels', false);
    } else {
      const rec = await prisma.difficultyLevel.create({ data: d });
      ctx.difficulties.set(d.name, rec);
      inc('difficulty_levels', true);
    }
  }

  // 7. Question Types
  const questionTypesList = [
    { code: 'SINGLE_CORRECT', name: 'Single Choice Correct' },
    { code: 'MULTIPLE_CORRECT', name: 'Multiple Choice Correct' },
    { code: 'NUMERICAL', name: 'Numerical Answer' },
    { code: 'ASSERTION_REASON', name: 'Assertion & Reason' },
    { code: 'MATCH_FOLLOWING', name: 'Matrix Match / Matching' },
    { code: 'CASE_BASED', name: 'Case Study / Passage Based' },
  ];

  for (const qt of questionTypesList) {
    const existing = await prisma.questionType.findUnique({ where: { code: qt.code } });
    if (existing) {
      ctx.questionTypes.set(qt.code, existing);
      inc('question_types', false);
    } else {
      const rec = await prisma.questionType.create({ data: qt });
      ctx.questionTypes.set(qt.code, rec);
      inc('question_types', true);
    }
  }

  // 8. Exam Statuses
  const examStatusesList = [
    'GENERATING',
    'DRAFT',
    'SUBMITTED',
    'APPROVED',
    'SCHEDULED',
    'ACTIVE',
    'ENDED',
    'COMPLETED',
    'CANCELLED',
  ];

  for (const s of examStatusesList) {
    const existing = await prisma.examStatus.findUnique({ where: { name: s } });
    if (existing) {
      ctx.examStatuses.set(s, existing);
      inc('exam_statuses', false);
    } else {
      const rec = await prisma.examStatus.create({ data: { name: s } });
      ctx.examStatuses.set(s, rec);
      inc('exam_statuses', true);
    }
  }

  // 9. Attempt Statuses
  const attemptStatusesList = [
    'NOT_STARTED',
    'IN_PROGRESS',
    'SUBMITTED',
    'AUTO_SUBMITTED',
    'EVALUATING',
    'EVALUATED',
    'CANCELLED',
  ];

  for (const s of attemptStatusesList) {
    const existing = await prisma.attemptStatus.findUnique({ where: { name: s } });
    if (existing) {
      ctx.attemptStatuses.set(s, existing);
      inc('attempt_statuses', false);
    } else {
      const rec = await prisma.attemptStatus.create({ data: { name: s } });
      ctx.attemptStatuses.set(s, rec);
      inc('attempt_statuses', true);
    }
  }

  // 10. Otp Purposes
  const otpPurposesList = [
    { name: 'LOGIN', description: 'Student & user login' },
    { name: 'REGISTER', description: 'Student onboarding' },
    { name: 'CHANGE_MOBILE', description: 'Phone number update' },
    { name: 'RESET_PASSWORD', description: 'Password recovery' },
    { name: 'VERIFY_MOBILE', description: 'Mobile verification' },
    { name: 'VERIFY_EMAIL', description: 'Email address verification' },
  ];

  for (const op of otpPurposesList) {
    await prisma.otpPurpose.upsert({
      where: { name: op.name },
      update: { description: op.description },
      create: op,
    });
    inc('otp_purposes', true);
  }

  // 11. States and Districts
  const statesData = [
    {
      name: 'Karnataka',
      code: 'KA',
      districts: ['Bengaluru Urban', 'Bengaluru Rural', 'Mysuru', 'Mangaluru', 'Hubballi-Dharwad', 'Belagavi', 'Shivamogga', 'Udupi'],
    },
    {
      name: 'Maharashtra',
      code: 'MH',
      districts: ['Mumbai City', 'Mumbai Suburban', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Aurangabad', 'Solapur'],
    },
    {
      name: 'Gujarat',
      code: 'GJ',
      districts: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Morbi', 'Gandhinagar'],
    },
    {
      name: 'Tamil Nadu',
      code: 'TN',
      districts: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli', 'Erode'],
    },
    {
      name: 'Delhi',
      code: 'DL',
      districts: ['New Delhi', 'North Delhi', 'South Delhi', 'East Delhi', 'West Delhi', 'Central Delhi'],
    },
    {
      name: 'Rajasthan',
      code: 'RJ',
      districts: ['Jaipur', 'Kota', 'Jodhpur', 'Udaipur', 'Ajmer', 'Bikaner', 'Sikar'],
    },
    {
      name: 'Telangana',
      code: 'TS',
      districts: ['Hyderabad', 'Rangareddy', 'Warangal', 'Medchal-Malkajgiri', 'Karimnagar', 'Nizamabad'],
    },
  ];

  for (const s of statesData) {
    let stateRec = await prisma.state.findUnique({ where: { code: s.code } });
    if (!stateRec) {
      stateRec = await prisma.state.create({
        data: { name: s.name, code: s.code, countryCode: 'IN' },
      });
      inc('states', true);
    } else {
      inc('states', false);
    }
    ctx.states.set(s.code, stateRec);
    ctx.states.set(s.name, stateRec);

    for (const dName of s.districts) {
      const dKey = `${s.code}:${dName}`;
      const existingDist = await prisma.district.findUnique({
        where: { stateId_name: { stateId: stateRec.id, name: dName } },
      });
      if (existingDist) {
        ctx.districts.set(dKey, existingDist);
        inc('districts', false);
      } else {
        const dRec = await prisma.district.create({
          data: { stateId: stateRec.id, name: dName },
        });
        ctx.districts.set(dKey, dRec);
        inc('districts', true);
      }
    }
  }

  // 12. Prediction Model Config
  await prisma.predictionModelConfig.upsert({
    where: { modelCode: 'HISTORICAL_INTERPOLATION' },
    update: { isActive: true },
    create: {
      modelCode: 'HISTORICAL_INTERPOLATION',
      modelName: 'Piecewise Cubic Hermite Historical Interpolator',
      version: 'v1.0.0',
      configuration: {
        minHistoricalExams: 1,
        minTotalCandidates: 1000,
        confidenceThresholds: { high: 80, medium: 50 },
      },
      isActive: true,
    },
  });
  inc('prediction_model_configs', true);

  // 13. Historical Exams & Datasets for Predicted Rank
  const historicalExams = [
    {
      examName: 'NEET UG 2024 (Official All India)',
      examType: 'NEET',
      totalMarks: 720,
      totalCandidates: 2406079,
      durationMinutes: 200,
      dataQualityStatus: DataQualityStatus.VALID,
      source: 'OFFICIAL_SOURCE',
    },
    {
      examName: 'JEE Main 2024 Session 2 (Official All India)',
      examType: 'JEE_MAIN',
      totalMarks: 300,
      totalCandidates: 1179569,
      durationMinutes: 180,
      dataQualityStatus: DataQualityStatus.VALID,
      source: 'OFFICIAL_SOURCE',
    },
    {
      examName: 'MHT-CET 2024 (Official State Ranking)',
      examType: 'MHT_CET',
      totalMarks: 200,
      totalCandidates: 375000,
      durationMinutes: 180,
      dataQualityStatus: DataQualityStatus.VALID,
      source: 'OFFICIAL_SOURCE',
    },
  ];

  for (const he of historicalExams) {
    const existing = await prisma.historicalExam.findFirst({ where: { examName: he.examName } });
    const hExam = existing || (await prisma.historicalExam.create({ data: he }));
    inc('historical_exams', !existing);

    // Delete previous ranges if any to avoid duplication
    await prisma.historicalScoreRange.deleteMany({ where: { historicalExamId: hExam.id } });

    let ranges: Array<{ minScore: number; maxScore: number; minRank: number; maxRank: number; repScore: number; count: number }> = [];

    if (he.examType === 'NEET') {
      ranges = [
        { minScore: 700, maxScore: 720, minRank: 1, maxRank: 100, repScore: 710, count: 100 },
        { minScore: 650, maxScore: 699, minRank: 101, maxRank: 4500, repScore: 675, count: 4400 },
        { minScore: 600, maxScore: 649, minRank: 4501, maxRank: 20000, repScore: 625, count: 15500 },
        { minScore: 500, maxScore: 599, minRank: 20001, maxRank: 85000, repScore: 550, count: 65000 },
        { minScore: 400, maxScore: 499, minRank: 85001, maxRank: 220000, repScore: 450, count: 135000 },
        { minScore: 300, maxScore: 399, minRank: 220001, maxRank: 480000, repScore: 350, count: 260000 },
        { minScore: 150, maxScore: 299, minRank: 480001, maxRank: 1100000, repScore: 225, count: 620000 },
      ];
    } else if (he.examType === 'JEE_MAIN') {
      ranges = [
        { minScore: 270, maxScore: 300, minRank: 1, maxRank: 800, repScore: 285, count: 800 },
        { minScore: 240, maxScore: 269, minRank: 801, maxRank: 3500, repScore: 255, count: 2700 },
        { minScore: 200, maxScore: 239, minRank: 3501, maxRank: 12000, repScore: 220, count: 8500 },
        { minScore: 160, maxScore: 199, minRank: 12001, maxRank: 32000, repScore: 180, count: 20000 },
        { minScore: 120, maxScore: 159, minRank: 32001, maxRank: 70000, repScore: 140, count: 38000 },
        { minScore: 80, maxScore: 119, minRank: 70001, maxRank: 150000, repScore: 100, count: 80000 },
        { minScore: 40, maxScore: 79, minRank: 150001, maxRank: 350000, repScore: 60, count: 200000 },
      ];
    } else if (he.examType === 'MHT_CET') {
      ranges = [
        { minScore: 180, maxScore: 200, minRank: 1, maxRank: 350, repScore: 190, count: 350 },
        { minScore: 160, maxScore: 179, minRank: 351, maxRank: 1800, repScore: 170, count: 1450 },
        { minScore: 140, maxScore: 159, minRank: 1801, maxRank: 5500, repScore: 150, count: 3700 },
        { minScore: 120, maxScore: 139, minRank: 5501, maxRank: 14000, repScore: 130, count: 8500 },
        { minScore: 100, maxScore: 119, minRank: 14001, maxRank: 32000, repScore: 110, count: 18000 },
        { minScore: 70, maxScore: 99, minRank: 32001, maxRank: 75000, repScore: 85, count: 43000 },
        { minScore: 40, maxScore: 69, minRank: 75001, maxRank: 160000, repScore: 55, count: 85000 },
      ];
    }

    for (const r of ranges) {
      await prisma.historicalScoreRange.create({
        data: {
          historicalExamId: hExam.id,
          minScore: r.minScore,
          maxScore: r.maxScore,
          representativeScore: r.repScore,
          minRank: r.minRank,
          maxRank: r.maxRank,
          candidateCount: r.count,
          totalCandidates: he.totalCandidates,
          percentileMin: ((he.totalCandidates - r.maxRank) / he.totalCandidates) * 100,
          percentileMax: ((he.totalCandidates - r.minRank) / he.totalCandidates) * 100,
        },
      });
      inc('historical_score_ranges', true);
    }
  }

  // 14. Strategy Rules
  const strategyRules = [
    {
      code: 'HIGH_RISK_ATTEMPTING',
      name: 'High Risk Guesswork on Difficult Questions',
      category: 'RISK',
      metric: 'WRONG_HARD_QUESTIONS',
      operator: 'GT',
      threshold: 3,
      severity: 'HIGH',
      priority: 1,
      recommendationTemplate: 'You incurred negative marks on {count} hard questions. Prioritize accuracy over blind attempts.',
      titleTemplate: 'Excessive Wild Guessing Detected',
    },
    {
      code: 'UNDER_ATTEMPTING',
      name: 'Under-attempting in Easy/Medium Questions',
      category: 'ATTEMPT_COVERAGE',
      metric: 'UNATTEMPTED_EASY_PERCENT',
      operator: 'GT',
      threshold: 15,
      severity: 'MEDIUM',
      priority: 2,
      recommendationTemplate: 'You left {percent}% of easy questions unattempted. Ensure you scan the entire paper.',
      titleTemplate: 'Missed Scoring Opportunities',
    },
    {
      code: 'POOR_TIME_MANAGEMENT',
      name: 'Excessive Time on Single Questions',
      category: 'TIME_MANAGEMENT',
      metric: 'QUESTIONS_OVER_TIME_LIMIT',
      operator: 'GT',
      threshold: 4,
      severity: 'HIGH',
      priority: 3,
      recommendationTemplate: 'Spent > 3 minutes on {count} individual questions. Practice skipping and circling back.',
      titleTemplate: 'Time Trap Alert',
    },
  ];

  for (const sr of strategyRules) {
    await prisma.strategyRule.upsert({
      where: { code: sr.code },
      update: { name: sr.name, description: sr.name },
      create: sr,
    });
    inc('strategy_rules', true);
  }

  // 15. Notification Templates
  const notificationTemplates = [
    {
      notificationType: NotificationType.REGISTRATION_CONFIRMATION,
      channel: NotificationChannel.EMAIL,
      languageCode: 'en',
      subject: 'Welcome to Brainros Exam Portal',
      body: 'Hello {{name}}, your student account has been created successfully with Student ID {{studentId}}.',
    },
    {
      notificationType: NotificationType.EXAM_SCHEDULED,
      channel: NotificationChannel.EMAIL,
      languageCode: 'en',
      subject: 'New Mock Test Scheduled: {{examTitle}}',
      body: 'Dear {{name}}, the exam {{examTitle}} is scheduled for {{examDate}} from {{startTime}} to {{endTime}}.',
    },
    {
      notificationType: NotificationType.RESULT_AVAILABLE,
      channel: NotificationChannel.EMAIL,
      languageCode: 'en',
      subject: 'Score Card Ready: {{examTitle}}',
      body: 'Hello {{name}}, you scored {{score}}/{{maxScore}} ({{percentage}}%) in {{examTitle}}. Your All-India Rank is {{rank}}.',
    },
    {
      notificationType: NotificationType.SECURITY_ALERT,
      channel: NotificationChannel.EMAIL,
      languageCode: 'en',
      subject: 'Security Alert: New Sign-in from {{ipAddress}}',
      body: 'A new session was initiated on your account from IP {{ipAddress}} on {{time}}.',
    },
  ];

  for (const nt of notificationTemplates) {
    const existing = await prisma.notificationTemplate.findFirst({
      where: {
        notificationType: nt.notificationType,
        channel: nt.channel,
        languageCode: nt.languageCode,
        version: 1,
      },
    });

    if (existing) {
      await prisma.notificationTemplate.update({
        where: { id: existing.id },
        data: { body: nt.body, subject: nt.subject },
      });
      inc('notification_templates', false);
    } else {
      await prisma.notificationTemplate.create({
        data: { ...nt, version: 1, isActive: true },
      });
      inc('notification_templates', true);
    }
  }

  return {
    seederName: 'MasterDataSeeder',
    createdCounts: created,
    reusedCounts: reused,
    timeMs: Date.now() - start,
  };
}
