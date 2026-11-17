const mongoose = require('mongoose')

/**
 * Học viên xem video hướng dẫn kỹ năng tới đâu — để mở lại thì xem tiếp, danh
 * sách hiện "đã xem 40%". Cùng cách đếm đoạn ĐÃ THỰC SỰ PHÁT như video Học liệu
 * (lib/watchCoverage.js), nhưng ở đây không dùng để khoá gì cả.
 */
const examVideoProgressSchema = new mongoose.Schema(
    {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        video: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamVideo', required: true, index: true },
        levelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamLevel', required: true },
        position: { type: Number, default: 0 },
        duration: { type: Number, default: 0 },
        watched: { type: [[Number]], default: [] },
        watchedSec: { type: Number, default: 0 },
        lastReportAt: { type: Date, default: null },
    },
    { timestamps: true }
)

examVideoProgressSchema.index({ student: 1, video: 1 }, { unique: true })
examVideoProgressSchema.index({ student: 1, levelId: 1 })

module.exports = mongoose.model('ExamVideoProgress', examVideoProgressSchema)
