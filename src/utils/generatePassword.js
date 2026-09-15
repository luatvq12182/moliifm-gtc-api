const crypto = require('crypto')

// Bộ ký tự đã loại các cặp dễ nhìn nhầm khi chép tay hoặc đọc qua điện thoại:
// O/0, I/l/1. Học viên nhận mật khẩu qua giấy hoặc tin nhắn nên điều này quan
// trọng hơn việc có thêm vài ký tự.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/**
 * Sinh mật khẩu tạm cho học viên mới tạo.
 *
 * DÙNG crypto.randomInt, KHÔNG dùng Math.random.
 *
 * Math.random của V8 chạy xorshift128+ — một PRNG nhanh nhưng KHÔNG phải nguồn
 * ngẫu nhiên mật mã học: biết đủ đầu ra là suy ngược được trạng thái rồi đoán
 * các số tiếp theo. Tạo lẻ từng tài khoản đã không nên; tạo hàng loạt thì tệ hơn
 * hẳn, vì cả nghìn mật khẩu sinh liên tiếp từ cùng một trạng thái — lộ vài cái
 * là có cơ sở suy ra phần còn lại của cùng lô.
 *
 * crypto.randomInt lấy entropy từ hệ điều hành và không có tính chất đó. Nó
 * cũng tránh được lệch phân phối do phép chia dư mà cách nhân với Math.random
 * hay mắc.
 */
function generateTempPassword(length = 10) {
    let result = ''
    for (let i = 0; i < length; i++) {
        result += CHARS[crypto.randomInt(CHARS.length)]
    }
    return result
}

module.exports = generateTempPassword
