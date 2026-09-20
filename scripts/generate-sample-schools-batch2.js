const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function createSampleSchoolsBatch2() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Brainros Exam Management System';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Schools', {
    views: [{ showGridLines: true }],
  });

  const headers = [
    { header: 'School Name *', key: 'name', width: 35 },
    { header: 'School Code * (e.g. SCH-001 or UDISE)', key: 'code', width: 32 },
    { header: 'Email Address (Optional)', key: 'email', width: 28 },
    { header: 'Phone Number (Optional)', key: 'phone', width: 20 },
    { header: 'State (Optional)', key: 'state', width: 20 },
    { header: 'City / District (Optional)', key: 'city', width: 25 },
    { header: 'Address (Optional)', key: 'address', width: 40 },
    { header: 'Status (Optional - Default: ACTIVE)', key: 'status', width: 22 },
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

  // 5 New Sample School Records (Batch 2)
  const sampleSchools = [
    {
      name: "The Mother's International School",
      code: 'MIS-DEL-201',
      email: 'principal@misdelhi.test',
      phone: '9820011223',
      state: 'Delhi',
      city: 'South Delhi',
      address: 'Sri Aurobindo Marg, New Delhi',
      status: 'ACTIVE',
    },
    {
      name: 'Bombay Scottish School',
      code: 'BSS-MUM-202',
      email: 'admin@bombayscottish.test',
      phone: '9820022334',
      state: 'Maharashtra',
      city: 'Mumbai',
      address: 'Veer Savarkar Marg, Mahim',
      status: 'ACTIVE',
    },
    {
      name: "Bishop Cotton Boys' School",
      code: 'BCB-BLR-203',
      email: 'office@bishopcotton.test',
      phone: '9820033445',
      state: 'Karnataka',
      city: 'Bengaluru Urban',
      address: "St. Mark's Road, Bengaluru",
      status: 'ACTIVE',
    },
    {
      name: 'Hyderabad Public School',
      code: 'HPS-HYD-204',
      email: 'contact@hpsbegumpet.test',
      phone: '9820044556',
      state: 'Telangana',
      city: 'Hyderabad',
      address: '1-11-87, Begumpet, Hyderabad',
      status: 'ACTIVE',
    },
    {
      name: 'Modern High School for Girls',
      code: 'MHS-KOL-205',
      email: 'info@mhsforgirls.test',
      phone: '9820055667',
      state: 'West Bengal',
      city: 'Kolkata',
      address: '78 Syed Amir Ali Avenue, Kolkata',
      status: 'ACTIVE',
    },
  ];

  sampleSchools.forEach((school) => {
    const row = sheet.addRow(school);
    row.height = 22;
    row.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.alignment = { vertical: 'middle' };
    });
  });

  // Destinations
  const destinations = [
    {
      xlsx: path.resolve(__dirname, '../sample_schools_upload_batch2.xlsx'),
      csv: path.resolve(__dirname, '../sample_schools_upload_batch2.csv'),
    },
    {
      xlsx: path.resolve(__dirname, '../../sample_schools_upload_batch2.xlsx'),
      csv: path.resolve(__dirname, '../../sample_schools_upload_batch2.csv'),
    },
  ];

  for (const dest of destinations) {
    await workbook.xlsx.writeFile(dest.xlsx);
    await workbook.csv.writeFile(dest.csv);
    console.log(`✅ Created: ${dest.xlsx}`);
    console.log(`✅ Created: ${dest.csv}`);
  }
}

createSampleSchoolsBatch2().catch(console.error);
