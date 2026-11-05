const mongoose = require('mongoose')

/**
 * Một lần học viên NỘP bài tập của khoá. Làm lại bao nhiêu lần cũng được;
 * mỗi lần một bản ghi.
 *
 *   snapshot  bản chụp đề lúc nộp (kèm đáp án, lời giải) — admin sửa đề sau
 *             thì kết quả cũ vẫn hiện đúng như lúc chấm
 *   answers   { [itemId]: [chỗ trống 1, ...] } hoặc { [itemId]: "câu tự đặt" }
 *   results   { [itemId]: { correct: [bool theo chỗ trống] } }           (tự động)
 *             { [itemId]: { verdict, comment, corrected } }              (AI)
 *   ai.status none        bài không có phần đặt câu
 *             done        AI chấm xong
 *             error       gọi AI lỗi (học viên bấm chấm lại được)
 *             unavailable máy chủ chưa cài khoá AI
 *             limited     hết lượt chấm AI trong ngày
 */
const materialExerciseAttemptSchema = new mongoose.Schema(
    {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true },
        version: { type: Number, default: 1 },
        snapshot: { type: mongoose.Schema.Types.Mixed, default: [] },
        answers: { type: mongoose.Schema.Types.Mixed, default: {} },
        results: { type: mongoose.Schema.Types.Mixed, default: {} },
        autoCorrect: { type: Number, default: 0 },
        autoTotal: { type: Number, default: 0 },
        ai: {
            status: { type: String, enum: ['none', 'done', 'error', 'unavailable', 'limited'], default: 'none' },
            passed: { type: Number, default: 0 },
            total: { type: Number, default: 0 },
            model: { type: String, default: '' },
            error: { type: String, default: '' },
        },
    },
    { timestamps: true }
)

materialExerciseAttemptSchema.index({ student: 1, courseId: 1, createdAt: -1 })
materialExerciseAttemptSchema.index({ courseId: 1, createdAt: -1 })

module.exports = mongoose.model('MaterialExerciseAttempt', materialExerciseAttemptSchema)
