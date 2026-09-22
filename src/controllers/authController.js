const jwt = require('jsonwebtoken')
const Admin = require('../models/Admin')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const { normalizePhone } = require('../lib/phone')

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
  const { phone, password } = req.body

  if (!phone || !password) {
    res.status(400)
    throw new Error('Vui lòng nhập số điện thoại và mật khẩu.')
  }

  // Chuẩn hoá trước khi tra: học viên gõ "090 123 4567" hay "+84901234567"
  // đều phải tìm ra cùng một tài khoản đã lưu dạng "0901234567".
  const normalized = normalizePhone(phone)
  if (!normalized) {
    res.status(400)
    throw new Error('Số điện thoại không hợp lệ.')
  }

  const student = await Student.findOne({ phone: normalized }).select('+password')

  // CÙNG MỘT THÔNG BÁO cho "không có tài khoản" và "sai mật khẩu". Tách ra thì
  // kẻ dò sẽ biết số nào có tài khoản trong hệ thống — mà số điện thoại thì dễ
  // đoán hơn email nhiều.
  if (!student) {
    res.status(401)
    throw new Error('Số điện thoại hoặc mật khẩu không đúng.')
  }

  if (student.status === 'locked') {
    res.status(403)
    throw new Error('Tài khoản của bạn đã bị khóa. Vui lòng liên hệ trung tâm để được hỗ trợ.')
  }

  const isMatch = await student.comparePassword(password)
  if (!isMatch) {
    res.status(401)
    throw new Error('Số điện thoại hoặc mật khẩu không đúng.')
  }

  // ===== Kiểm tra giới hạn thiết bị (1 desktop + 1 mobile) =====
  const { deviceId, deviceType } = req.body
  if (!deviceId || !['desktop', 'mobile'].includes(deviceType)) {
    res.status(400)
    throw new Error('Thiếu thông tin thiết bị.')
  }

  const slot = student.devices?.[deviceType]
  const deviceLabel = deviceType === 'mobile' ? 'điện thoại' : 'máy tính'

  if (!slot || !slot.deviceId) {
    // Slot trống -> ghi nhận thiết bị này làm thiết bị đầu tiên
    if (!student.devices) student.devices = {}
    student.devices[deviceType] = {
      deviceId,
      userAgent: req.headers['user-agent'] || '',
      firstLoginAt: new Date(),
    }
    await student.save()
  } else if (slot.deviceId !== deviceId) {
    // Slot đã có thiết bị khác -> chặn
    res.status(403)
    throw new Error(
      `Tài khoản này đã được sử dụng trên một ${deviceLabel} khác. ` +
      `Nếu bạn vừa đổi thiết bị, vui lòng liên hệ trung tâm để được hỗ trợ mở khóa.`
    )
  }
  // Nếu slot.deviceId === deviceId -> đúng thiết bị cũ, cho qua bình thường
  // ============================================================

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
