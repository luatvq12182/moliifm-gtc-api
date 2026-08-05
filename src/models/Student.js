const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

const studentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    // Placeholder đơn giản dạng chuỗi (vd. "HSK1") — khi module Giáo trình/Khóa
    // học/Bài học được thiết kế xong, nên đổi field này thành tham chiếu
    // (ObjectId ref: 'Course') hoặc mảng nhiều khóa nếu học viên học song song
    // nhiều khóa cùng lúc.
    course: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['active', 'locked'],
      default: 'active',
    },
    // 2 slot thiết bị được phép: 1 desktop + 1 mobile. Ghi nhận deviceId ở
    // lần đăng nhập đầu tiên của mỗi loại; thiết bị khác cùng loại sẽ bị chặn
    // cho tới khi admin reset slot đó về null.
    devices: {
      desktop: {
        deviceId: { type: String, default: null },
        userAgent: { type: String, default: '' },
        firstLoginAt: { type: Date, default: null },
      },
      mobile: {
        deviceId: { type: String, default: null },
        userAgent: { type: String, default: '' },
        firstLoginAt: { type: Date, default: null },
      },
    },
  },
  { timestamps: true }
)

studentSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next()
  const salt = await bcrypt.genSalt(10)
  this.password = await bcrypt.hash(this.password, salt)
  next()
})

studentSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password)
}

module.exports = mongoose.model('Student', studentSchema)
