const ExcelJS = require('exceljs');
const path = require('path');

async function createSampleSchoolsBatch3() {
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

  // 5 New Sample School Records (Batch 3)
  const sampleSchools = [
    {
      name: 'Dhirubhai Ambani International School',
      code: 'DAIS-MUM-301',
      email: 'admissions@dais.test',
      phone: '9830011223',
      state: 'Maharashtra',
      city: 'Mumbai',
      address: 'Bandra Kurla Complex, Bandra East',
      status: 'ACTIVE',
    },
    {
      name: 'The Doon School',
      code: 'DOON-DDN-302',
      email: 'admin@doonschool.test',
      phone: '9830022334',
      state: 'Uttarakhand',
      city: 'Dehradun',
      address: 'Mall Road, Dehradun',
      status: 'ACTIVE',
    },
    {
      name: 'La Martiniere for Boys',
      code: 'LMB-KOL-303',
      email: 'office@lamartiniere.test',
      phone: '9830033445',
      state: 'West Bengal',
      city: 'Kolkata',
      address: '11 Dr. U.N. Brahmachari Street',
      status: 'ACTIVE',
    },
    {
      name: 'Sanskriti School',
      code: 'SAN-DEL-304',
      email: 'principal@sanskritischool.test',
      phone: '9830044556',
      state: 'Delhi',
      city: 'New Delhi',
      address: 'Chanakyapuri, New Delhi',
      status: 'ACTIVE',
    },
    {
      name: 'Chettinad Vidyashram',
      code: 'CV-CHE-305',
      email: 'info@chettinadvidya.test',
      phone: '9830055667',
      state: 'Tamil Nadu',
      city: 'Chennai',
      address: 'R.A. Puram, Chennai',
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
      xlsx: path.resolve(__dirname, '../sample_schools_upload_batch3.xlsx'),
      csv: path.resolve(__dirname, '../sample_schools_upload_batch3.csv'),
    },
    {
      xlsx: path.resolve(__dirname, '../../sample_schools_upload_batch3.xlsx'),
      csv: path.resolve(__dirname, '../../sample_schools_upload_batch3.csv'),
    },
  ];

  for (const dest of destinations) {
    await workbook.xlsx.writeFile(dest.xlsx);
    await workbook.csv.writeFile(dest.csv);
    console.log(`✅ Created: ${dest.xlsx}`);
    console.log(`✅ Created: ${dest.csv}`);
  }
}

createSampleSchoolsBatch3().catch(console.error);
