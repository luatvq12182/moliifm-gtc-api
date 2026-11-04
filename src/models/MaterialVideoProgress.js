const mongoose = require('mongoose')

/**
 * Học viên xem một video bài giảng tới đâu — để lần sau mở lại xem tiếp, và
 * danh sách video hiện "đã xem 40%". Mỗi học viên một bản ghi mỗi video.
 *
 *   position  chỗ dừng lần gần nhất (giây) — mở lại thì phát tiếp từ đây
 *   furthest  chỗ xa nhất từng xem tới — tính % đã xem (tua lại không làm tụt %)
 */
const materialVideoProgressSchema = new mongoose.Schema(
    {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        video: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialVideo', required: true, index: true },
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true },
        position: { type: Number, default: 0 },
        furthest: { type: Number, default: 0 },
        duration: { type: Number, default: 0 },
        completed: { type: Boolean, default: false },
    },
    { timestamps: true }
)

materialVideoProgressSchema.index({ student: 1, video: 1 }, { unique: true })
materialVideoProgressSchema.index({ student: 1, courseId: 1 })

module.exports = mongoose.model('MaterialVideoProgress', materialVideoProgressSchema)
