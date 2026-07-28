// Chạy: npm run seed:admin
// Tạo tài khoản admin đầu tiên từ thông tin khai báo trong .env
// (ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD). Bỏ qua nếu email đã tồn tại.
require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const Admin = require('../models/Admin')

async function seedAdmin() {
  await connectDB()

  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env

  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Thiếu ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD trong file .env')
    process.exit(1)
  }

  const existing = await Admin.findOne({ email: ADMIN_EMAIL.toLowerCase().trim() })
  if (existing) {
    console.log(`Admin với email ${ADMIN_EMAIL} đã tồn tại, bỏ qua.`)
    process.exit(0)
  }

  const admin = await Admin.create({
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'super_admin',
  })

  console.log('Đã tạo tài khoản admin đầu tiên:')
  console.log(`  Email: ${admin.email}`)
  console.log(`  Mật khẩu: (giữ đúng như đã đặt trong .env, đã được hash khi lưu vào DB)`)

  await mongoose.connection.close()
  process.exit(0)
}

seedAdmin().catch((err) => {
  console.error('Lỗi khi seed admin:', err)
  process.exit(1)
})
