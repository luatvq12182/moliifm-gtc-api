const mongoose = require('mongoose')

/**
 * VIDEO "HƯỚNG DẪN KỸ NĂNG THI" của một cấp thi. Để trên YouTube ("Không công
 * khai"), admin dán link (hoặc cả danh sách phát) về. Chỉ để xem — không bắt
 * xem đủ, không có bài tập. Cách bảo vệ link giống video bài giảng của Học
 * liệu (xem MaterialVideo): danh sách không trả mã YouTube, ảnh bìa qua máy chủ.
 */
const examVideoSchema = new mongoose.Schema(
    {
        levelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamLevel', required: true, index: true },
        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },
        youtubeId: { type: String, required: true },
        youtubeUrl: { type: String, default: '' },
        durationSec: { type: Number, default: 0 },
        thumbFile: { type: String, default: '' },
    },
    { timestamps: true }
)

examVideoSchema.index({ levelId: 1, order: 1 })

module.exports = mongoose.model('ExamVideo', examVideoSchema)
