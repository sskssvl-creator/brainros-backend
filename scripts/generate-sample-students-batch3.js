const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function generateSampleFiles() {
  const students = [
    {
      name: 'Aarav Sharma',
      mobile: '9840011221',
      email: 'aarav.sharma@example.com',
      state: 'Maharashtra',
      city: 'Mumbai',
      class: '12th',
      examTarget: 'NEET',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Ananya Deshmukh',
      mobile: '9840011222',
      email: 'ananya.deshmukh@example.com',
      state: 'Maharashtra',
      city: 'Pune',
      class: '11th',
      examTarget: 'JEE',
      preferredLanguage: 'MARATHI',
    },
    {
      name: 'Rohan Gupta',
      mobile: '9840011223',
      email: 'rohan.gupta@example.com',
      state: 'Delhi',
      city: 'New Delhi',
      class: '12th',
      examTarget: 'NEET + JEE',
      preferredLanguage: 'HINDI',
    },
    {
      name: 'Sneha Patel',
      mobile: '9840011224',
      email: 'sneha.patel@example.com',
      state: 'Gujarat',
      city: 'Ahmedabad',
      class: 'Dropper',
      examTarget: 'NEET',
      preferredLanguage: 'GUJARATI',
    },
    {
      name: 'Aditya Kulkarni',
      mobile: '9840011225',
      email: 'aditya.k@example.com',
      state: 'Maharashtra',
      city: 'Nagpur',
      class: '11th',
      examTarget: 'CET',
      preferredLanguage: 'ENGLISH',
    },
    {
      name: 'Pooja Iyer',
      mobile: '9840011226',
      email: 'pooja.iyer@example.com',
      state: 'Tamil Nadu',
      city: 'Chennai',
      class: '12th',
      examTarget: 'JEE',
      preferredLanguage: 'ENGLISH',
    },
  ];

  // 1. Create Excel File
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Brainros Exam System';
  const worksheet = workbook.addWorksheet('Students', {
    views: [{ showGridLines: true }],
  });

  worksheet.columns = [
    { header: 'Full Name *', key: 'name', width: 24 },
    { header: 'Mobile Number * (10 Digits)', key: 'mobile', width: 28 },
    { header: 'Email Address (Optional)', key: 'email', width: 28 },
    { header: 'State *', key: 'state', width: 20 },
    { header: 'City / District *', key: 'city', width: 22 },
    { header: 'Class / Grade * (e.g. 11th, 12th, Dropper)', key: 'class', width: 26 },
    { header: 'Exam Target * (Options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET)', key: 'examTarget', width: 42 },
    { header: 'Preferred Language * (e.g. ENGLISH, HINDI, GUJARATI, MARATHI)', key: 'preferredLanguage', width: 26 },
  ];

  // Header style
  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '4F46E5' },
    };
    cell.font = {
      name: 'Segoe UI',
      size: 11,
      bold: true,
      color: { argb: 'FFFFFF' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  students.forEach((s) => worksheet.addRow(s));

  for (let r = 2; r <= students.length + 1; r++) {
    const row = worksheet.getRow(r);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
  }

  const rootExcelPath = path.resolve(__dirname, '../../sample_students_upload_batch3.xlsx');
  const backendExcelPath = path.resolve(__dirname, '../sample_students_upload_batch3.xlsx');
  await workbook.xlsx.writeFile(rootExcelPath);
  await workbook.xlsx.writeFile(backendExcelPath);
  console.log('Created Excel file at:', rootExcelPath);

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
  const rootCsvPath = path.resolve(__dirname, '../../sample_students_upload_batch3.csv');
  const backendCsvPath = path.resolve(__dirname, '../sample_students_upload_batch3.csv');
  fs.writeFileSync(rootCsvPath, csvContent, 'utf-8');
  fs.writeFileSync(backendCsvPath, csvContent, 'utf-8');
  console.log('Created CSV file at:', rootCsvPath);
}

generateSampleFiles().catch(console.error);
