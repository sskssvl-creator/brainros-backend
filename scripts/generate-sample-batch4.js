const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function generateBatch4Files() {
  // ─── 1. BATCH 4 STUDENTS DATA ───
  const students = [
    {
      name: 'Ishaan Verma',
      mobile: '9850011221',
      email: 'ishaan.verma@example.com',
      state: 'Maharashtra',
      city: 'Mumbai',
      class: 'Class 12',
      examTarget: 'JEE',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Diya Sengupta',
      mobile: '9850011222',
      email: 'diya.s@example.com',
      state: 'West Bengal',
      city: 'Kolkata',
      class: 'Class 11',
      examTarget: 'NEET',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Kabir Singhania',
      mobile: '9850011223',
      email: 'kabir.s@example.com',
      state: 'Delhi',
      city: 'New Delhi',
      class: 'Dropper',
      examTarget: 'NEET + JEE',
      preferredLanguage: 'HINDI',
    },
    {
      name: 'Tanvi Joshi',
      mobile: '9850011224',
      email: 'tanvi.j@example.com',
      state: 'Maharashtra',
      city: 'Pune',
      class: '12th',
      examTarget: 'JEE + State CET',
      preferredLanguage: 'MARATHI',
    },
    {
      name: 'Manish Patel',
      mobile: '9850011225',
      email: 'manish.p@example.com',
      state: 'Gujarat',
      city: 'Surat',
      class: '11th',
      examTarget: 'CET',
      preferredLanguage: 'GUJARATI',
    },
    {
      name: 'Shruti Raman',
      mobile: '9850011226',
      email: 'shruti.raman@example.com',
      state: 'Tamil Nadu',
      city: 'Chennai',
      class: '12th',
      examTarget: 'NEET',
      preferredLanguage: 'TAMIL',
    },
    {
      name: 'Arjun Reddy',
      mobile: '9850011227',
      email: 'arjun.reddy@example.com',
      state: 'Telangana',
      city: 'Hyderabad',
      class: 'Dropper',
      examTarget: 'JEE',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Meera Nambiar',
      mobile: '9850011228',
      email: 'meera.n@example.com',
      state: 'Karnataka',
      city: 'Bengaluru',
      class: 'Class 11',
      examTarget: 'NEET + State CET',
      preferredLanguage: 'ENGLISH',
    },
  ];

  // 1A. Student Excel File
  const studentWb = new ExcelJS.Workbook();
  studentWb.creator = 'Brainros Exam System';
  const studentSheet = studentWb.addWorksheet('Students', {
    views: [{ showGridLines: true }],
  });

  studentSheet.columns = [
    { header: 'Full Name *', key: 'name', width: 24 },
    { header: 'Mobile Number * (10 Digits)', key: 'mobile', width: 28 },
    { header: 'Email Address (Optional)', key: 'email', width: 28 },
    { header: 'State *', key: 'state', width: 20 },
    { header: 'City / District *', key: 'city', width: 22 },
    { header: 'Class / Grade * (e.g. 11th, 12th, Dropper)', key: 'class', width: 26 },
    { header: 'Exam Target * (Options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET)', key: 'examTarget', width: 44 },
    { header: 'Preferred Language * (e.g. ENGLISH, HINDI, GUJARATI, MARATHI, TAMIL)', key: 'preferredLanguage', width: 26 },
  ];

  const studentHRow = studentSheet.getRow(1);
  studentHRow.height = 28;
  studentHRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4F46E5' } };
    cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  students.forEach((s) => studentSheet.addRow(s));

  for (let r = 2; r <= students.length + 1; r++) {
    const row = studentSheet.getRow(r);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
  }

  const rootStudentXlsx = path.resolve(__dirname, '../../sample_students_upload_batch4.xlsx');
  const backendStudentXlsx = path.resolve(__dirname, '../sample_students_upload_batch4.xlsx');
  await studentWb.xlsx.writeFile(rootStudentXlsx);
  await studentWb.xlsx.writeFile(backendStudentXlsx);
  console.log('Created Student Excel:', rootStudentXlsx);

  // 1B. Student CSV File
  const studentCsvHeaders = [
    'Full Name *',
    'Mobile Number * (10 Digits)',
    'Email Address (Optional)',
    'State *',
    'City / District *',
    'Class / Grade *',
    'Exam Target *',
    'Preferred Language *',
  ].join(',');

  const studentCsvRows = students.map((s) =>
    [
      `"${s.name}"`,
      `"${s.mobile}"`,
      `"${s.email}"`,
      `"${s.state}"`,
      `"${s.city}"`,
      `"${s.class}"`,
      `"${s.examTarget}"`,
      `"${s.preferredLanguage}"`,
    ].join(','),
  );

  const studentCsvContent = [studentCsvHeaders, ...studentCsvRows].join('\r\n');
  const rootStudentCsv = path.resolve(__dirname, '../../sample_students_upload_batch4.csv');
  const backendStudentCsv = path.resolve(__dirname, '../sample_students_upload_batch4.csv');
  fs.writeFileSync(rootStudentCsv, studentCsvContent, 'utf-8');
  fs.writeFileSync(backendStudentCsv, studentCsvContent, 'utf-8');
  console.log('Created Student CSV:', rootStudentCsv);


  // ─── 2. BATCH 4 SCHOOLS DATA ───
  const schools = [
    {
      schoolName: 'Delhi Public School R.K. Puram',
      code: 'DPS-RKP-401',
      city: 'New Delhi',
      state: 'Delhi',
      board: 'CBSE',
      contactPhone: '9860011221',
      contactEmail: 'admissions@dpsrkp.net',
      principalName: 'Dr. Padma Srinivasan',
      principalEmail: 'principal@dpsrkp.net',
      principalPhone: '9860011221',
      address: 'Sector XII, R.K. Puram',
      pinCode: '110022',
    },
    {
      schoolName: 'Bombay Scottish School',
      code: 'BSS-MAH-402',
      city: 'Mumbai',
      state: 'Maharashtra',
      board: 'ICSE',
      contactPhone: '9860022332',
      contactEmail: 'office@bombayscottish.edu',
      principalName: 'Sunita George',
      principalEmail: 'sunita.g@bombayscottish.edu',
      principalPhone: '9860022332',
      address: 'Veer Savarkar Marg, Mahim',
      pinCode: '400016',
    },
    {
      schoolName: 'National Public School Indiranagar',
      code: 'NPS-BLR-403',
      city: 'Bengaluru',
      state: 'Karnataka',
      board: 'CBSE',
      contactPhone: '9860033443',
      contactEmail: 'info@npsinr.com',
      principalName: 'Shantha Chandran',
      principalEmail: 'principal@npsinr.com',
      principalPhone: '9860033443',
      address: '12th A Main Road, Indiranagar',
      pinCode: '560008',
    },
    {
      schoolName: 'St. Xavier Collegiate School',
      code: 'SXCS-KOL-404',
      city: 'Kolkata',
      state: 'West Bengal',
      board: 'ICSE',
      contactPhone: '9860044554',
      contactEmail: 'admin@sxcs.edu.in',
      principalName: 'Fr. Thamacin Arulappan',
      principalEmail: 'rector@sxcs.edu.in',
      principalPhone: '9860044554',
      address: '30 Mother Teresa Sarani',
      pinCode: '700016',
    },
  ];

  const schoolWb = new ExcelJS.Workbook();
  schoolWb.creator = 'Brainros Exam System';
  const schoolSheet = schoolWb.addWorksheet('Schools', {
    views: [{ showGridLines: true }],
  });

  schoolSheet.columns = [
    { header: 'School Name *', key: 'schoolName', width: 35 },
    { header: 'Code *', key: 'code', width: 18 },
    { header: 'City *', key: 'city', width: 20 },
    { header: 'State *', key: 'state', width: 20 },
    { header: 'Board * (CBSE/ICSE/STATE_BOARD)', key: 'board', width: 22 },
    { header: 'Contact Phone * (10 Digits)', key: 'contactPhone', width: 24 },
    { header: 'Contact Email', key: 'contactEmail', width: 28 },
    { header: 'Principal Name', key: 'principalName', width: 24 },
    { header: 'Principal Email', key: 'principalEmail', width: 28 },
    { header: 'Principal Phone', key: 'principalPhone', width: 22 },
    { header: 'Address', key: 'address', width: 32 },
    { header: 'PIN Code', key: 'pinCode', width: 14 },
  ];

  const schoolHRow = schoolSheet.getRow(1);
  schoolHRow.height = 28;
  schoolHRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '059669' } };
    cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  schools.forEach((s) => schoolSheet.addRow(s));

  for (let r = 2; r <= schools.length + 1; r++) {
    const row = schoolSheet.getRow(r);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
  }

  const rootSchoolXlsx = path.resolve(__dirname, '../../sample_schools_upload_batch4.xlsx');
  const backendSchoolXlsx = path.resolve(__dirname, '../sample_schools_upload_batch4.xlsx');
  await schoolWb.xlsx.writeFile(rootSchoolXlsx);
  await schoolWb.xlsx.writeFile(backendSchoolXlsx);
  console.log('Created School Excel:', rootSchoolXlsx);

  const schoolCsvHeaders = [
    'School Name *',
    'Code *',
    'City *',
    'State *',
    'Board *',
    'Contact Phone *',
    'Contact Email',
    'Principal Name',
    'Principal Email',
    'Principal Phone',
    'Address',
    'PIN Code',
  ].join(',');

  const schoolCsvRows = schools.map((s) =>
    [
      `"${s.schoolName}"`,
      `"${s.code}"`,
      `"${s.city}"`,
      `"${s.state}"`,
      `"${s.board}"`,
      `"${s.contactPhone}"`,
      `"${s.contactEmail}"`,
      `"${s.principalName}"`,
      `"${s.principalEmail}"`,
      `"${s.principalPhone}"`,
      `"${s.address}"`,
      `"${s.pinCode}"`,
    ].join(','),
  );

  const schoolCsvContent = [schoolCsvHeaders, ...schoolCsvRows].join('\r\n');
  const rootSchoolCsv = path.resolve(__dirname, '../../sample_schools_upload_batch4.csv');
  const backendSchoolCsv = path.resolve(__dirname, '../sample_schools_upload_batch4.csv');
  fs.writeFileSync(rootSchoolCsv, schoolCsvContent, 'utf-8');
  fs.writeFileSync(backendSchoolCsv, schoolCsvContent, 'utf-8');
  console.log('Created School CSV:', rootSchoolCsv);
}

generateBatch4Files().catch(console.error);
