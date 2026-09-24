// Middleware xử lý lỗi tập trung — đặt cuối cùng trong app.js.
// Nhận diện vài loại lỗi phổ biến từ Mongoose để trả message dễ hiểu hơn,
// thay vì luôn trả nguyên message kỹ thuật của MongoDB.
function errorHandler(err, req, res, next) {
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500
  let message = err.message || 'Lỗi hệ thống, vui lòng thử lại sau.'

  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ message: 'File vượt quá dung lượng cho phép.' })
    return
  }

  // Lỗi trùng khóa unique (vd. số điện thoại đã tồn tại)
  if (err.code === 11000) {
    statusCode = 409
    const field = Object.keys(err.keyPattern || { field: 1 })[0]
    const value = (err.keyValue || {})[field]

    // GIÁ TRỊ RỖNG THÌ KHÔNG PHẢI "ĐÃ TỒN TẠI".
    //
    // Email là trường tuỳ chọn. Nếu chỉ mục chưa ở dạng sparse thì MongoDB coi
    // mọi bản ghi KHÔNG có email là cùng một giá trị null và từ chối bản ghi
    // thứ hai. Lúc đó câu 'Giá trị "email" đã tồn tại' hoàn toàn đánh lạc
    // hướng — người dùng đang để trống email chứ có nhập gì đâu mà trùng.
    if (value === null || value === undefined || value === '') {
      message =
        `Chưa lưu được vì cơ sở dữ liệu đang không cho phép nhiều học viên ` +
        `bỏ trống "${field}". Vui lòng báo kỹ thuật chạy migration.`
      console.error(
        `[CẤU HÌNH] Chỉ mục "${field}" chưa ở dạng sparse — chạy: npm run migrate:phone-login -- --apply`
      )
    } else {
      const label = field === 'phone' ? 'Số điện thoại' : field === 'email' ? 'Email' : field
      message = `${label} "${value}" đã được dùng bởi tài khoản khác.`
    }
  }

  // Lỗi validate của Mongoose (thiếu field required, sai enum...)
  if (err.name === 'ValidationError') {
    statusCode = 400
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ')
  }

  // Lỗi truyền sai định dạng ObjectId (vd. id không hợp lệ trên URL)
  if (err.name === 'CastError') {
    statusCode = 400
    message = `Giá trị id không hợp lệ: ${err.value}`
  }

  res.status(statusCode).json({
    message,
    // Mã do CHÍNH ỨNG DỤNG gắn (vd. ACCOUNT_LOCKED), để giao diện xử lý theo
    // tình huống mà không phải so khớp câu chữ tiếng Việt. Khác với err.code
    // của Mongo/multer ở trên — những mã đó đã được diễn giải thành message
    // rồi, không đẩy ra ngoài.
    code: err.appCode,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  })
}

module.exports = errorHandler
