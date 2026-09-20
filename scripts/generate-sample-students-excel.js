const ExcelJS = require('exceljs');
const path = require('path');

async function createSampleStudentsExcel() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Brainros Exam Management System';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Students', {
    views: [{ showGridLines: true }],
  });

  const headers = [
    { header: 'Full Name *', key: 'name', width: 25 },
    { header: 'Mobile Number * (10 Digits)', key: 'mobile', width: 24 },
    { header: 'Email Address (Optional)', key: 'email', width: 30 },
    { header: 'State *', key: 'state', width: 20 },
    { header: 'City / District *', key: 'city', width: 24 },
    { header: 'Class / Grade * (e.g. 11th, 12th, Dropper)', key: 'class', width: 26 },
    { header: 'Exam Target * (Options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET)', key: 'examTarget', width: 42 },
    { header: 'Preferred Language * (e.g. ENGLISH, HINDI, GUJARATI)', key: 'preferredLanguage', width: 28 },
  ];

  sheet.columns = headers;

  // Style Header Row
  const headerRow = sheet.getRow(1);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' }, // Dark slate
    };
    cell.font = {
      name: 'Segoe UI',
      size: 11,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // 5 Sample Student Records
  const sampleStudents = [
    {
      name: 'Aarav Joshi',
      mobile: '9823456781',
      email: 'aarav.joshi@example.com',
      state: 'Karnataka',
      city: 'Bengaluru Urban',
      class: 'Class 12',
      examTarget: 'JEE',
      preferredLanguage: 'English',
    },
    {
      name: 'Sneha Kulkarni',
      mobile: '9823456782',
      email: 'sneha.k@example.com',
      state: 'Maharashtra',
      city: 'Pune',
      class: 'Class 12',
      examTarget: 'NEET',
      preferredLanguage: 'English',
    },
    {
      name: 'Tanmay Deshmukh',
      mobile: '9823456783',
      email: 'tanmay.d@example.com',
      state: 'Maharashtra',
      city: 'Mumbai',
      class: 'Class 11',
      examTarget: 'CET',
      preferredLanguage: 'Marathi',
    },
    {
      name: 'Ananya Iyer',
      mobile: '9823456784',
      email: 'ananya.iyer@example.com',
      state: 'Tamil Nadu',
      city: 'Chennai',
      class: 'Class 12',
      examTarget: 'NEET + JEE',
      preferredLanguage: 'English',
    },
    {
      name: 'Rohan Mehta',
      mobile: '9823456785',
      email: 'rohan.mehta@example.com',
      state: 'Gujarat',
      city: 'Ahmedabad',
      class: 'Dropper',
      examTarget: 'JEE + State CET',
      preferredLanguage: 'Gujarati',
    },
  ];

  sampleStudents.forEach((student) => {
    const row = sheet.addRow(student);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle' };
    });
  });

  const backendXlsx = path.resolve(__dirname, '../sample_students_upload.xlsx');
  const backendCsv = path.resolve(__dirname, '../sample_students_upload.csv');
  const rootXlsx = path.resolve(__dirname, '../../sample_students_upload.xlsx');
  const rootCsv = path.resolve(__dirname, '../../sample_students_upload.csv');

  await workbook.xlsx.writeFile(backendXlsx);
  await workbook.csv.writeFile(backendCsv);
  await workbook.xlsx.writeFile(rootXlsx);
  await workbook.csv.writeFile(rootCsv);

  console.log(`✅ Created backend Excel: ${backendXlsx}`);
  console.log(`✅ Created backend CSV: ${backendCsv}`);
  console.log(`✅ Created root Excel: ${rootXlsx}`);
  console.log(`✅ Created root CSV: ${rootCsv}`);
}

createSampleStudentsExcel().catch(console.error);
