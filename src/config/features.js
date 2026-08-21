/**
 * Cờ bật/tắt tính năng, đọc từ biến môi trường.
 *
 * PRACTICE_HISTORY_ENABLED — Lưu lịch sử luyện nói (bản ghi âm + kết quả chấm)
 * của học viên để admin nghe lại và đối chứng.
 *
 *   BẬT  (true)  -> dùng trong GIAI ĐOẠN PHÁT TRIỂN/NGHIỆM THU. Mỗi lượt luyện
 *                   nói được ghi vào MongoDB kèm file WAV trên đĩa. Phục vụ
 *                   việc đối chứng khi có tranh cãi "tôi đọc đúng mà bị chấm
 *                   sai".
 *   TẮT  (false) -> dùng khi ĐÃ TUNG RA THỊ TRƯỜNG. Không ghi gì xuống đĩa,
 *                   không tạo bản ghi nào trong DB. Học viên vẫn nghe lại được
 *                   giọng mình, nhưng chỉ trong bộ nhớ trình duyệt — tải lại
 *                   trang là mất.
 *
 * MẶC ĐỊNH LÀ TẮT. Đây là lựa chọn có chủ đích: quên khai biến môi trường thì
 * hệ thống rơi vào trạng thái KHÔNG thu thập dữ liệu cá nhân, chứ không phải
 * ngược lại. Muốn bật thì phải khai tường minh.
 */
function readBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

const features = {
    practiceHistoryEnabled: readBool(process.env.PRACTICE_HISTORY_ENABLED, false),
}

module.exports = { features, readBool }
