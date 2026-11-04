const mongoose = require('mongoose')

/**
 * MỘT VIDEO BÀI GIẢNG trong một khoá học liệu (thường dài cỡ 1 tiếng).
 *
 * Video để trên YouTube ở chế độ "Không công khai"; admin dán link về đây.
 * Khách đã chấp nhận rủi ro video YouTube có thể bị chia sẻ / tải về; phía
 * site cố hết mức để học viên KHÔNG thấy link:
 *
 *  - Danh sách video không trả mã YouTube; ảnh bìa phát qua máy chủ mình.
 *  - Mã YouTube chỉ trả ở trang xem từng video, sau khi kiểm quyền khoá.
 *  - Trình phát dùng nút điều khiển riêng, phủ lớp chặn bấm lên khung YouTube
 *    (không bấm được logo / tiêu đề để mở youtube.com).
 */
const materialVideoSchema = new mongoose.Schema(
    {
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true, index: true },
        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },

        youtubeId: { type: String, required: true },
        youtubeUrl: { type: String, default: '' }, // link admin đã dán (admin xem lại)
        // Lấy từ trang YouTube khi thêm; lấy không được thì trình phát của học
        // viên báo về ở lần xem đầu tiên.
        durationSec: { type: Number, default: 0 },
        // Ảnh bìa đã lưu về storage/materials/videos/ — rỗng nếu lấy không được.
        thumbFile: { type: String, default: '' },
    },
    { timestamps: true }
)

materialVideoSchema.index({ courseId: 1, order: 1 })

module.exports = mongoose.model('MaterialVideo', materialVideoSchema)
