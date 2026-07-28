const mongoose = require('mongoose')

const curriculumSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // "Giáo trình HSK tiêu chuẩn 2.0"
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // "gtc-2-0"
    description: { type: String, trim: true, default: '' },
    thumbnail: { type: String, trim: true, default: '' },
    order: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  },
  { timestamps: true }
)

module.exports = mongoose.model('Curriculum', curriculumSchema)