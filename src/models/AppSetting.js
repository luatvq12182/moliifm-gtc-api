const mongoose = require('mongoose')

/**
 * Cấu hình admin sửa được trên web (không cần sửa code / .env), dạng
 * khoá -> giá trị. Hiện dùng cho:
 *   ai_grading_rubric  hướng dẫn chấm cho AI chấm phần đặt câu (lib/aiGrader.js)
 */
const appSettingSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    },
    { timestamps: true }
)

module.exports = mongoose.model('AppSetting', appSettingSchema)
