const ExcelJS = require('exceljs');
const path = require('path');

async function createSampleSchoolsExcel() {
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

  // 5 Sample School Records
  const sampleSchools = [
    {
      name: 'Delhi Public School, R.K. Puram',
      code: 'DPS-RKP-101',
      email: 'admin@dpsrkp.test',
      phone: '9876543210',
      state: 'Delhi',
      city: 'South West Delhi',
      address: 'Sector XII, R.K. Puram',
      status: 'ACTIVE',
    },
    {
      name: "St. Xavier's High School",
      code: 'STX-MUM-102',
      email: 'contact@stxaviers.test',
      phone: '9811223344',
      state: 'Maharashtra',
      city: 'Mumbai',
      address: '5 Mahapalika Marg, Dhobi Talao',
      status: 'ACTIVE',
    },
    {
      name: 'Kendriya Vidyalaya IIT Powai',
      code: 'KV-POW-103',
      email: 'kvpowai@brainros.test',
      phone: '9922334455',
      state: 'Maharashtra',
      city: 'Mumbai Suburban',
      address: 'IIT Campus, Powai',
      status: 'ACTIVE',
    },
    {
      name: 'National Public School, Indiranagar',
      code: 'NPS-BLR-104',
      email: 'info@npsindiranagar.test',
      phone: '9845012345',
      state: 'Karnataka',
      city: 'Bengaluru Urban',
      address: '12th Main Road, Indiranagar',
      status: 'ACTIVE',
    },
    {
      name: 'DAV Public School, Sector 14',
      code: 'DAV-GUR-105',
      email: 'principal@davgurgaon.test',
      phone: '9810054321',
      state: 'Haryana',
      city: 'Gurugram',
      address: 'Sector 14, Urban Estate',
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

  const xlsxPath = path.resolve(__dirname, '../sample_schools_upload.xlsx');
  const csvPath = path.resolve(__dirname, '../sample_schools_upload.csv');

  await workbook.xlsx.writeFile(xlsxPath);
  await workbook.csv.writeFile(csvPath);

  console.log(`✅ Created Excel file: ${xlsxPath}`);
  console.log(`✅ Created CSV file: ${csvPath}`);
}

createSampleSchoolsExcel().catch(console.error);
