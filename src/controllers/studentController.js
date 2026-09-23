const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const generateTempPassword = require('../utils/generatePassword')
const { normalizePhone } = require('../lib/phone')

// Vô hiệu hoá các ký tự đặc biệt của regex trong chuỗi người dùng gõ.
//
// Hai lý do, đều đã đo được:
//  - SAI KẾT QUẢ: gõ "0909.876" thì dấu chấm là "ký tự bất kỳ", nên "0909X876"
//    cũng khớp.
//  - TREO MÁY CHỦ: gõ "(a+)+$" rồi để MongoDB chạy trên chuỗi vài chục ký tự
//    là regex bùng nổ — thử ở Node mất 10 giây cho 28 ký tự. Đây là đầu vào
//    của người dùng, không được đưa thẳng vào regex.
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// GET /api/students?search=&status=&page=&limit=
const getStudents = asyncHandler(async function getStudents(req, res) {
  const { search = '', status, page = 1, limit = 20 } = req.query

  const query = {}

  if (search) {
    // Tìm theo tên, số điện thoại hoặc email, không phân biệt hoa thường.
    // Số điện thoại tra theo dạng đã chuẩn hoá: admin gõ "090 123" vẫn ra
    // học viên lưu "0901234567".
    const safe = escapeRegex(search.trim())
    const digits = search.replace(/\D/g, '')
    query.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
      ...(digits ? [{ phone: { $regex: digits } }] : []),
    ]
  }

  if (status && ['active', 'locked'].includes(status)) {
    query.status = status
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1)
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
  const skip = (pageNum - 1) * limitNum

  const [students, total] = await Promise.all([
    Student.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    Student.countDocuments(query),
  ])

  res.json({
    data: students,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    },
  })
})

// GET /api/students/:id
const getStudent = asyncHandler(async function getStudent(req, res) {
  const student = await Student.findById(req.params.id)

  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  res.json(student)
})

// POST /api/students
const createStudent = asyncHandler(async function createStudent(req, res) {
  const { name, email, phone, course } = req.body

  if (!name || !phone) {
    res.status(400)
    throw new Error('Vui lòng nhập đầy đủ tên và số điện thoại học viên.')
  }

  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    res.status(400)
    throw new Error('Số điện thoại không hợp lệ.')
  }

  const existing = await Student.findOne({ phone: normalizedPhone })
  if (existing) {
    res.status(409)
    throw new Error('Số điện thoại này đã được đăng ký cho một học viên khác.')
  }

  // Email nay tuỳ chọn, nhưng có thì vẫn không được trùng.
  const cleanEmail = typeof email === 'string' ? email.toLowerCase().trim() : ''
  if (cleanEmail) {
    const emailTaken = await Student.findOne({ email: cleanEmail })
    if (emailTaken) {
      res.status(409)
      throw new Error('Email này đã được dùng bởi học viên khác.')
    }
  }

  // MẬT KHẨU BAN ĐẦU = SỐ ĐIỆN THOẠI.
  //
  // Yêu cầu của khách: giáo viên khỏi phải đọc mật khẩu ngẫu nhiên qua điện
  // thoại cho từng học viên, chỉ cần nói "đăng nhập bằng số điện thoại của em".
  //
  // ĐÁNH ĐỔI ĐÃ BIẾT VÀ ĐÃ CHẤP NHẬN: số điện thoại nằm trong bảng quản trị,
  // trong file nhập liệu, và bạn cùng lớp thường biết của nhau — nên ai cầm
  // danh sách lớp là đăng nhập được vào tài khoản bất kỳ chưa đổi mật khẩu.
  // Khách đã chọn KHÔNG bắt đổi ở lần đăng nhập đầu, chỉ để sẵn màn hình đổi
  // trong menu. Muốn siết lại thì thêm cờ "phải đổi mật khẩu" vào model rồi
  // chặn ở ProtectedStudentRoute.
  const tempPassword = normalizedPhone

  const student = await Student.create({
    name,
    phone: normalizedPhone,
    email: cleanEmail, // '' -> setter trong model đổi thành undefined
    course,
    password: tempPassword,
  })

  const studentObj = student.toObject()
  delete studentObj.password

  res.status(201).json({
    student: studentObj,
    tempPassword,
  })
})

// PUT /api/students/:id — cập nhật thông tin cơ bản (không đổi mật khẩu/trạng thái ở route này)
const updateStudent = asyncHandler(async function updateStudent(req, res) {
  const { name, email, phone, course } = req.body

  const student = await Student.findById(req.params.id)
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  if (phone !== undefined) {
    const normalizedPhone = normalizePhone(phone)
    if (!normalizedPhone) {
      res.status(400)
      throw new Error('Số điện thoại không hợp lệ.')
    }
    if (normalizedPhone !== student.phone) {
      const phoneTaken = await Student.findOne({ phone: normalizedPhone })
      if (phoneTaken) {
        res.status(409)
        throw new Error('Số điện thoại này đã được dùng bởi học viên khác.')
      }
      student.phone = normalizedPhone
    }
  }

  if (email !== undefined) {
    const cleanEmail = typeof email === 'string' ? email.toLowerCase().trim() : ''
    if (cleanEmail && cleanEmail !== student.email) {
      const emailTaken = await Student.findOne({ email: cleanEmail })
      if (emailTaken) {
        res.status(409)
        throw new Error('Email này đã được dùng bởi học viên khác.')
      }
    }
    // Xoá email (gửi lên chuỗi rỗng) cũng là một cập nhật hợp lệ.
    student.email = cleanEmail
  }

  if (name !== undefined) student.name = name
  if (course !== undefined) student.course = course

  try {
    await student.save()
  } catch (err) {
    // Học viên tạo từ trước khi đổi sang đăng nhập bằng số có thể đang mang
    // số không hợp lệ (dữ liệu thử "1900 8198" chẳng hạn). save() kiểm cả bản
    // ghi nên admin chỉ đổi TÊN cũng bị chặn — báo đúng việc cần làm thay vì
    // một câu "số không hợp lệ" khiến họ tưởng mình vừa gõ sai.
    if (err.name === 'ValidationError' && err.errors?.phone && phone === undefined) {
      res.status(400)
      throw new Error(
        `Số điện thoại đang lưu ("${student.phone}") không hợp lệ. Hãy sửa số điện thoại trước rồi cập nhật thông tin khác.`
      )
    }
    throw err
  }

  res.json(student)
})

// PATCH /api/students/:id/status — khóa / mở khóa tài khoản
const toggleStudentStatus = asyncHandler(async function toggleStudentStatus(req, res) {
  const student = await Student.findById(req.params.id)
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  student.status = student.status === 'active' ? 'locked' : 'active'
  await student.save()

  res.json(student)
})

// DELETE /api/students/:id
const deleteStudent = asyncHandler(async function deleteStudent(req, res) {
  const student = await Student.findById(req.params.id)
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  await student.deleteOne()

  res.json({ message: 'Đã xóa học viên.' })
})

// PATCH /api/students/:id/reset-password — admin cấp lại mật khẩu tạm mới
// PATCH /api/auth/student/change-password — HỌC VIÊN tự đổi mật khẩu của mình.
//
// Khác resetStudentPassword bên dưới (admin đặt lại hộ): ở đây phải biết mật
// khẩu hiện tại mới đổi được. Không có bước đó thì ai mượn được máy đang mở
// sẵn là đổi mật khẩu chiếm luôn tài khoản.
const MIN_PASSWORD_LENGTH = 6

const changeOwnPassword = asyncHandler(async function changeOwnPassword(req, res) {
  const { currentPassword, newPassword } = req.body

  if (!currentPassword || !newPassword) {
    res.status(400)
    throw new Error('Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.')
  }
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
    res.status(400)
    throw new Error(`Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`)
  }
  if (newPassword === currentPassword) {
    res.status(400)
    throw new Error('Mật khẩu mới phải khác mật khẩu hiện tại.')
  }

  // req.student do protectStudent gắn vào, nhưng nó KHÔNG kèm password (model
  // để select: false) — phải nạp lại kèm trường đó mới so sánh được.
  const student = await Student.findById(req.student._id).select('+password')
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy tài khoản.')
  }

  const isMatch = await student.comparePassword(currentPassword)
  if (!isMatch) {
    res.status(401)
    throw new Error('Mật khẩu hiện tại không đúng.')
  }

  student.password = newPassword // pre('save') trong model tự băm lại
  await student.save()

  // KHÔNG cấp token mới và cũng không thu hồi token cũ: hệ thống dùng JWT nên
  // không có danh sách phiên để xoá. Token đang cầm vẫn dùng được tới khi hết
  // hạn — đó là hành vi có chủ đích, để học viên không bị đá ra ngay sau khi
  // vừa đổi mật khẩu thành công.
  res.json({ message: 'Đã đổi mật khẩu thành công.' })
})

const resetStudentPassword = asyncHandler(async function resetStudentPassword(req, res) {
  const student = await Student.findById(req.params.id)
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  const tempPassword = generateTempPassword()
  student.password = tempPassword // sẽ tự hash lại nhờ pre('save') hook trong model
  await student.save()

  res.json({ message: 'Đã đặt lại mật khẩu.', tempPassword })
})

// PATCH /api/students/:id/reset-devices  body: { target: 'desktop' | 'mobile' | 'both' }
const resetStudentDevices = asyncHandler(async function resetStudentDevices(req, res) {
  const { target } = req.body
  if (!['desktop', 'mobile', 'both'].includes(target)) {
    res.status(400)
    throw new Error('Loại thiết bị cần reset không hợp lệ.')
  }

  const student = await Student.findById(req.params.id)
  if (!student) {
    res.status(404)
    throw new Error('Không tìm thấy học viên.')
  }

  if (!student.devices) student.devices = {}
  const emptySlot = { deviceId: null, userAgent: '', firstLoginAt: null }

  if (target === 'desktop' || target === 'both') student.devices.desktop = emptySlot
  if (target === 'mobile' || target === 'both') student.devices.mobile = emptySlot

  await student.save()
  res.json({
    message: 'Đã reset thiết bị thành công.',
    devices: student.devices,
  })
})

module.exports = {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  toggleStudentStatus,
  deleteStudent,
  resetStudentPassword,
  resetStudentDevices,
  changeOwnPassword,
}
