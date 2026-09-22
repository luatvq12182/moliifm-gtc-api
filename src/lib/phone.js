/**
 * Chuẩn hoá số điện thoại Việt Nam về MỘT dạng duy nhất: "0xxxxxxxxx".
 *
 * VÌ SAO BẮT BUỘC: số điện thoại là định danh đăng nhập của học viên. Cùng một
 * số có năm cách gõ —
 *     0901234567 · 090 123 4567 · 090.123.4567 · +84 901 234 567 · 84901234567
 * — không quy về một dạng thì admin nhập kiểu này, học viên gõ kiểu kia, đăng
 * nhập trượt mà không ai hiểu vì sao. Tệ hơn: cùng một người, hai tài khoản.
 *
 * Phải gọi ở MỌI cửa vào: model (lúc lưu), đăng nhập, tạo/sửa học viên, nhập
 * từ file. Chỉ cần sót một chỗ là dữ liệu lệch dạng và ràng buộc duy nhất
 * không còn bảo vệ được gì.
 *
 * BẢN SAO Ở FRONTEND: gtc-fe/src/lib/phone.js — form cần báo lỗi ngay lúc gõ.
 * `npm run verify` mục 8 đối chiếu hai bản.
 */

/**
 * Trả về dạng chuẩn "0xxxxxxxxx", hoặc '' nếu không phải số điện thoại VN.
 *
 * Nhận 10 hoặc 11 chữ số sau khi bỏ mã quốc gia: di động VN là 10 số từ 2018,
 * cố định có thể 11. Chặt hơn thì loại oan; lỏng hơn thì nhận cả rác.
 */
function normalizePhone(input) {
    if (input === null || input === undefined) return ''
    let s = String(input).trim()
    if (!s) return ''

    // Bỏ mọi thứ không phải chữ số, trừ dấu + ở đầu (để nhận ra mã quốc gia).
    const plus = s.startsWith('+')
    s = s.replace(/\D/g, '')
    if (!s) return ''

    // +84 / 84 ở đầu -> 0. Chỉ coi "84" là mã quốc gia khi phần còn lại đủ dài,
    // kẻo số cố định bắt đầu bằng 084 bị hiểu nhầm.
    if (plus && s.startsWith('84')) {
        s = '0' + s.slice(2)
    } else if (!plus && s.startsWith('84') && s.length >= 11) {
        s = '0' + s.slice(2)
    }

    if (!/^0\d{9,10}$/.test(s)) return ''
    return s
}

function isValidPhone(input) {
    return normalizePhone(input) !== ''
}

module.exports = { normalizePhone, isValidPhone }
