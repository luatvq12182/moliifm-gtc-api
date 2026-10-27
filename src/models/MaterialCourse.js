const mongoose = require('mongoose')

/**
 * KHOÁ HỌC LIỆU — chức năng "Học liệu khoá học" (slide bài giảng cho học viên).
 *
 * Danh sách khoá RIÊNG, không dùng chung Course của "Luyện nghe nói qua video
 * AI": khách chốt vậy để tự đặt khoá học liệu theo lớp thật (HSK2, HSK3, HSK4…)
 * mà không bị trói vào cây Giáo trình → Khoá → Bài của chức năng kia.
 *
 * Quyền xem theo từng học viên: Student.materialAccess.
 */
const materialCourseSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true }, // "HSK 3"
        slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // "hsk3"
        description: { type: String, trim: true, default: '' },
        thumbnail: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    },
    { timestamps: true }
)

module.exports = mongoose.model('MaterialCourse', materialCourseSchema)
