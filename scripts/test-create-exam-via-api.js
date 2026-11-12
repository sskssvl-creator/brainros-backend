const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

async function main() {
  console.log('1. Authenticating Super Admin...');
  const otpRes = await axios.post('http://127.0.0.1:3000/auth/login/request-otp', {
    identifier: '9000000000',
  });
  const loginRequestId = otpRes.data?.data?.loginRequestId;
  console.log('LoginRequestId:', loginRequestId);

  const verifyRes = await axios.post('http://127.0.0.1:3000/auth/login/verify-otp', {
    loginRequestId,
    otp: '123456',
  });
  const token = verifyRes.data?.data?.accessToken;
  console.log('Obtained JWT token for Super Admin:', !!token);

  // 2. Upload 180-Question CSV
  console.log('2. Uploading 180-question paper CSV to /admin/exam-manager/create-from-upload...');
  const csvPath = path.resolve(__dirname, '../../neet_180_questions_all_subjects.csv');
  const fileBuffer = fs.readFileSync(csvPath);

  const form = new FormData();
  form.append('questionFile', fileBuffer, {
    filename: 'neet_180_questions_all_subjects.csv',
    contentType: 'text/csv',
  });
  form.append('title', 'NEET All-India Grand Mock Test 2026 (180 Questions)');
  form.append('blueprintId', 'b634f8f2-15a0-45d3-b5a2-e142d337c15b');
  form.append('description', 'Full 180-Question NEET paper across Physics, Chemistry, Botany, and Zoology');
  form.append('durationMinutes', '200');
  form.append('defaultMarksPerQuestion', '4');
  form.append('defaultNegativeMarks', '1');

  try {
    const uploadRes = await axios.post('http://127.0.0.1:3000/admin/exam-manager/create-from-upload', form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    console.log('Upload Result Status:', uploadRes.status);
    console.log('Upload Result Data:', JSON.stringify(uploadRes.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error('Upload Error Status:', err.response.status);
      console.error('Upload Error Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error:', err.message);
    }
  }
}

main().catch(console.error);
