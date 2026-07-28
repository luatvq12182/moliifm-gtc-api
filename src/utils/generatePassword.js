// Sinh mật khẩu tạm ngẫu nhiên cho học viên mới tạo (admin sẽ gửi cho học viên
// qua email/SMS ở bước sau; hiện tại module gửi thông báo chưa làm nên chỉ trả
// thẳng mật khẩu này trong response lúc tạo tài khoản để admin copy thủ công).
function generateTempPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

module.exports = generateTempPassword
