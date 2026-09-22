const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const { normalizePhone } = require('../lib/phone')

const studentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // SỐ ĐIỆN THOẠI LÀ ĐỊNH DANH ĐĂNG NHẬP.
    //
    // Khách hàng đổi từ email sang số điện thoại vì học viên gần như ai cũng có
    // số, còn email thì không. Luôn lưu ở dạng chuẩn "0xxxxxxxxx" (xem
    // lib/phone.js) — setter dưới đây đảm bảo điều đó ở mọi đường ghi, kể cả
    // script hay ai đó gọi Student.create trực tiếp mà quên chuẩn hoá.
    phone: {
      type: String,
      required: [true, 'Thiếu số điện thoại.'],
      unique: true,
      trim: true,
      set: (v) => normalizePhone(v) || v, // giữ nguyên giá trị rác để validator báo lỗi rõ
      validate: {
        validator: (v) => normalizePhone(v) === v && v !== '',
        message: 'Số điện thoại không hợp lệ.',
      },
    },
    // Email nay là TUỲ CHỌN.
    //
    // Hai bẫy về chỉ mục duy nhất khi một trường trở thành tuỳ chọn:
    //
    //  1. Chỉ mục unique thường coi "không có trường" là giá trị null, và hai
    //     bản ghi cùng null là TRÙNG. Học viên thứ hai không có email sẽ nổ
    //     lỗi duplicate key. Phải dùng `sparse` để chỉ mục bỏ qua bản ghi
    //     không có trường này.
    //
    //  2. `sparse` chỉ bỏ qua khi trường VẮNG MẶT hoặc null — KHÔNG bỏ qua
    //     chuỗi rỗng "". Nếu lưu email = "" cho học viên không có email thì
    //     sparse vô tác dụng. Setter dưới đây đổi "" thành undefined để Mongoose
    //     không ghi trường đó xuống.
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      set: (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
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
