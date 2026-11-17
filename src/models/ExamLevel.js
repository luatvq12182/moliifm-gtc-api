const mongoose = require('mongoose')

/**
 * CẤP THI của chức năng "Luyện thi HSK 3.0 cùng Molii FM" (HSK3, HSK4…).
 *
 * Mỗi cấp có hai mục: "Hướng dẫn kỹ năng thi" (ExamVideo) và "Luyện đề" (đề
 * thi thử tính giờ — giai đoạn sau). Quyền vào theo từng học viên:
 * Student.examAccess. Tách riêng khỏi Học liệu (MaterialCourse) vì hai chức
 * năng bán / cấp quyền độc lập với nhau.
 */
const examLevelSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true }, // "HSK3 3.0"
        slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // "hsk3"
        description: { type: String, trim: true, default: '' },
        thumbnail: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    },
    { timestamps: true }
)

module.exports = mongoose.model('ExamLevel', examLevelSchema)
