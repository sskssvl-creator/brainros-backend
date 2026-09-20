const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function generateBatch5Files() {
  const students = [
    {
      name: 'Riddhi Kulkarni',
      mobile: '9870011221',
      email: 'riddhi.k@example.com',
      state: 'Maharashtra',
      city: 'Pune',
      class: '12th',
      examTarget: 'NEET',
      preferredLanguage: 'MARATHI',
    },
    {
      name: 'Varun Aggarwal',
      mobile: '9870011222',
      email: 'varun.a@example.com',
      state: 'Delhi',
      city: 'New Delhi',
      class: '11th',
      examTarget: 'JEE',
      preferredLanguage: 'HINDI',
    },
    {
      name: 'Kavya Nair',
      mobile: '9870011223',
      email: 'kavya.n@example.com',
      state: 'Karnataka',
      city: 'Bengaluru',
      class: 'Class 12',
      examTarget: 'NEET + State CET',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Devendra Rathore',
      mobile: '9870011224',
      email: 'devendra.r@example.com',
      state: 'Rajasthan',
      city: 'Jaipur',
      class: 'Dropper',
      examTarget: 'JEE',
      preferredLanguage: 'HINDI',
    },
    {
      name: 'Anjali Bhatt',
      mobile: '9870011225',
      email: 'anjali.b@example.com',
      state: 'Gujarat',
      city: 'Ahmedabad',
      class: '11th',
      examTarget: 'CET',
      preferredLanguage: 'GUJARATI',
    },
    {
      name: 'Siddharth Rao',
      mobile: '9870011226',
      email: 'siddharth.r@example.com',
      state: 'Telangana',
      city: 'Hyderabad',
      class: '12th',
      examTarget: 'JEE + State CET',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Deepika Sundaram',
      mobile: '9870011227',
      email: 'deepika.s@example.com',
      state: 'Tamil Nadu',
      city: 'Chennai',
      class: 'Dropper',
      examTarget: 'NEET',
      preferredLanguage: 'TAMIL',
    },
    {
      name: 'Harsh Vardhan',
      mobile: '9870011228',
      email: 'harsh.v@example.com',
      state: 'Uttar Pradesh',
      city: 'Lucknow',
      class: 'Class 11',
      examTarget: 'NEET + JEE',
      preferredLanguage: 'HINDI',
    },
    {
      name: 'Mitali Banerjee',
      mobile: '9870011229',
      email: 'mitali.b@example.com',
      state: 'West Bengal',
      city: 'Kolkata',
      class: '12th',
      examTarget: 'JEE',
      preferredLanguage: 'BENGALI',
    },
    {
      name: 'Chirag Shah',
      mobile: '9870011230',
      email: 'chirag.s@example.com',
      state: 'Maharashtra',
      city: 'Mumbai',
      class: 'Dropper',
      examTarget: 'NEET',
      preferredLanguage: 'ENGLISH',
    },
  ];

  // 1. Create Excel File
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Brainros Exam System';
  const sheet = wb.addWorksheet('Students', {
    views: [{ showGridLines: true }],
  });

  sheet.columns = [
    { header: 'Full Name *', key: 'name', width: 24 },
    { header: 'Mobile Number * (10 Digits)', key: 'mobile', width: 28 },
    { header: 'Email Address (Optional)', key: 'email', width: 28 },
    { header: 'State *', key: 'state', width: 20 },
    { header: 'City / District *', key: 'city', width: 22 },
    { header: 'Class / Grade * (e.g. 11th, 12th, Dropper)', key: 'class', width: 26 },
    { header: 'Exam Target * (Options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET)', key: 'examTarget', width: 44 },
    { header: 'Preferred Language * (e.g. ENGLISH, HINDI, GUJARATI, MARATHI, TAMIL, BENGALI)', key: 'preferredLanguage', width: 28 },
  ];

  const hRow = sheet.getRow(1);
  hRow.height = 28;
  hRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4F46E5' } };
    cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  students.forEach((s) => sheet.addRow(s));

  for (let r = 2; r <= students.length + 1; r++) {
    const row = sheet.getRow(r);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
  }

  const rootXlsx = path.resolve(__dirname, '../../sample_students_upload_batch5.xlsx');
  const backendXlsx = path.resolve(__dirname, '../sample_students_upload_batch5.xlsx');
  await wb.xlsx.writeFile(rootXlsx);
  await wb.xlsx.writeFile(backendXlsx);
  console.log('Created Student Excel Batch 5:', rootXlsx);

  // 2. Create CSV File
  const csvHeaders = [
    'Full Name *',
    'Mobile Number * (10 Digits)',
    'Email Address (Optional)',
    'State *',
    'City / District *',
    'Class / Grade *',
    'Exam Target *',
    'Preferred Language *',
  ].join(',');

  const csvRows = students.map((s) =>
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

  const csvContent = [csvHeaders, ...csvRows].join('\r\n');
  const rootCsv = path.resolve(__dirname, '../../sample_students_upload_batch5.csv');
  const backendCsv = path.resolve(__dirname, '../sample_students_upload_batch5.csv');
  fs.writeFileSync(rootCsv, csvContent, 'utf-8');
  fs.writeFileSync(backendCsv, csvContent, 'utf-8');
  console.log('Created Student CSV Batch 5:', rootCsv);
}

generateBatch5Files().catch(console.error);
