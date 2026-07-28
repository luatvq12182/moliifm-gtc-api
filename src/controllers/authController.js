const jwt = require('jsonwebtoken')
const Admin = require('../models/Admin')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')

function signToken(admin) {
  return jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

function signStudentToken(student) {
  return jwt.sign({ id: student._id, role: 'student' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

// POST /api/auth/login
const login = asyncHandler(async function login(req, res) {
  const { email, password } = req.body

  if (!email || !password) {
    res.status(400)
    throw new Error('Vui lòng nhập email và mật khẩu.')
  }

  // .select('+password') vì schema đã đặt select: false mặc định cho field này
  const admin = await Admin.findOne({ email: email.toLowerCase().trim() }).select('+password')

  if (!admin) {
    res.status(401)
    throw new Error('Email hoặc mật khẩu không đúng.')
  }

  const isMatch = await admin.comparePassword(password)
  if (!isMatch) {
    res.status(401)
    throw new Error('Email hoặc mật khẩu không đúng.')
  }

  const token = signToken(admin)

  res.json({
    token,
    admin: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
  })
})

// GET /api/auth/me (yêu cầu đã đăng nhập — dùng để frontend xác thực token còn hạn khi tải lại trang)
const getMe = asyncHandler(async function getMe(req, res) {
  const admin = req.admin
  res.json({
    id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
  })
})

// POST /api/auth/student/login
const studentLogin = asyncHandler(async function studentLogin(req, res) {
  const { email, password } = req.body

  if (!email || !password) {
    res.status(400)
    throw new Error('Vui lòng nhập email và mật khẩu.')
  }

  const student = await Student.findOne({ email: email.toLowerCase().trim() }).select('+password')

  if (!student) {
    res.status(401)
    throw new Error('Email hoặc mật khẩu không đúng.')
  }

  if (student.status === 'locked') {
    res.status(403)
    throw new Error('Tài khoản của bạn đã bị khóa. Vui lòng liên hệ trung tâm để được hỗ trợ.')
  }

  const isMatch = await student.comparePassword(password)
  if (!isMatch) {
    res.status(401)
    throw new Error('Email hoặc mật khẩu không đúng.')
  }

  const token = signStudentToken(student)

  res.json({
    token,
    student: {
      id: student._id,
      name: student.name,
      email: student.email,
      course: student.course,
    },
  })
})

// GET /api/auth/student/me
const getStudentMe = asyncHandler(async function getStudentMe(req, res) {
  const student = req.student
  res.json({
    id: student._id,
    name: student.name,
    email: student.email,
    course: student.course,
  })
})

module.exports = { login, getMe, studentLogin, getStudentMe }
