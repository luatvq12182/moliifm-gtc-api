const mongoose = require('mongoose')

const courseSchema = new mongoose.Schema(
    {
        curriculumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Curriculum', required: true },
        name: { type: String, required: true, trim: true }, // "HSK1"
        slug: { type: String, required: true, lowercase: true, trim: true }, // "hsk1"
        description: { type: String, trim: true, default: '' },
        thumbnail: { type: String, trim: true, default: '' },
        level: { type: String, trim: true, default: '' }, // "Sơ cấp"
        certificate: { type: String, trim: true, default: '' }, // "HSK 1"
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    },
    { timestamps: true }
)

// slug chỉ cần duy nhất TRONG PHẠM VI 1 giáo trình, không cần duy nhất toàn hệ
// thống — "hsk1" có thể tồn tại ở cả GTC 2.0 lẫn GTC 3.0 cùng lúc
courseSchema.index({ curriculumId: 1, slug: 1 }, { unique: true })

module.exports = mongoose.model('Course', courseSchema)