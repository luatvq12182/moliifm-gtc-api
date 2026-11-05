const mongoose = require('mongoose')

/**
 * Học viên xem một video bài giảng tới đâu. Mỗi học viên một bản ghi mỗi video.
 *
 *   position   chỗ dừng lần gần nhất (giây) — mở lại thì phát tiếp từ đây
 *   watched    các đoạn ĐÃ THỰC SỰ PHÁT, đã gộp: [[từ, đến], ...] (giây)
 *   watchedSec tổng độ dài các đoạn trên
 *
 * KHÁCH YÊU CẦU: phải xem ĐỦ video mới được làm bài tập, tính theo thời lượng
 * đã xem — tua một phát tới cuối thì không tính. Nên "đã xem bao nhiêu" đo bằng
 * `watched` (trình phát gửi từng đoạn vừa phát), không bằng chỗ xa nhất.
 * Đủ 95% thời lượng là xem xong (xem lib/watchCoverage.js).
 *
 * `furthest` / `completed` là trường của bản đầu (tính theo chỗ xa nhất — tua
 * được). Giữ lại cho dữ liệu cũ, KHÔNG còn dùng để xét xem xong.
 */
const materialVideoProgressSchema = new mongoose.Schema(
    {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        video: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialVideo', required: true, index: true },
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true },
        position: { type: Number, default: 0 },
        duration: { type: Number, default: 0 },
        watched: { type: [[Number]], default: [] },
        watchedSec: { type: Number, default: 0 },
        // Lần báo gần nhất — giới hạn mỗi lần báo chỉ được cộng thêm tối đa
        // (thời gian thực trôi qua × tốc độ phát lớn nhất), chặn gửi khống.
        lastReportAt: { type: Date, default: null },
        furthest: { type: Number, default: 0 },
        completed: { type: Boolean, default: false },
    },
    { timestamps: true }
)

materialVideoProgressSchema.index({ student: 1, video: 1 }, { unique: true })
materialVideoProgressSchema.index({ student: 1, courseId: 1 })

module.exports = mongoose.model('MaterialVideoProgress', materialVideoProgressSchema)
