const jwt = require('jsonwebtoken')
const Admin = require('../models/Admin')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')

const protectAdmin = asyncHandler(async function protectAdmin(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401)
    throw new Error('Chưa đăng nhập hoặc thiếu token xác thực.')
  }

  const token = authHeader.split(' ')[1]

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch (err) {
    res.status(401)
    throw new Error('Token không hợp lệ hoặc đã hết hạn.')
  }

  const admin = await Admin.findById(decoded.id)
  if (!admin) {
    res.status(401)
    throw new Error('Tài khoản admin không còn tồn tại.')
  }

  req.admin = admin
  next()
})

// Bảo vệ toàn bộ nội dung học (Giáo trình/Khóa học/Bài học) — chỉ học viên
// đã đăng nhập VÀ chưa bị khóa mới đọc được.
const protectStudent = asyncHandler(async function protectStudent(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401)
    throw new Error('Vui lòng đăng nhập để sử dụng chức năng này.')
  }

  const token = authHeader.split(' ')[1]

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch (err) {
    res.status(401)
    throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.')
  }

  const student = await Student.findById(decoded.id)
  if (!student) {
    res.status(401)
    throw new Error('Tài khoản học viên không còn tồn tại.')
  }

  if (student.status === 'locked') {
    res.status(403)
    throw new Error('Tài khoản của bạn đã bị khóa. Vui lòng liên hệ trung tâm để được hỗ trợ.')
  }

  req.student = student
  next()
})

module.exports = { protectAdmin, protectStudent }