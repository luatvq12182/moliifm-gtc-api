const mongoose = require('mongoose')

const exampleSchema = new mongoose.Schema({ hanzi: String, pinyin: String, vi: String }, { _id: false })

const dialogueLineSchema = new mongoose.Schema(
    {
        speaker: { type: String, default: '' },
        hanzi: { type: String, required: true },
        pinyin: { type: String, default: '' },
        vi: { type: String, default: '' },
        startTime: { type: Number, default: 0 },
        endTime: { type: Number, default: 0 },
    },
    { _id: false }
)

const vocabularyItemSchema = new mongoose.Schema(
    {
        hanzi: { type: String, required: true },
        pinyin: { type: String, default: '' },
        pos: { type: String, default: '' },
        meaning: { type: String, default: '' },
        example: { type: exampleSchema, default: () => ({}) },
    },
    { _id: false }
)

const mcOptionSchema = new mongoose.Schema({ hanzi: String, pinyin: String }, { _id: false })

const multipleChoiceQuestionSchema = new mongoose.Schema(
    {
        question: { type: String, required: true },
        pinyin: { type: String, default: '' },
        options: { type: [mcOptionSchema], default: [] },
        correctIndex: { type: Number, required: true },
    },
    { _id: false }
)

const trueFalseQuestionSchema = new mongoose.Schema(
    {
        statement: { type: String, required: true },
        pinyin: { type: String, default: '' },
        correct: { type: Boolean, required: true },
    },
    { _id: false }
)

const sentenceOrderWordSchema = new mongoose.Schema({ hanzi: String, pinyin: String }, { _id: false })

const sentenceOrderQuestionSchema = new mongoose.Schema(
    {
        words: { type: [sentenceOrderWordSchema], required: true },
        correctSentence: { type: String, required: true },
    },
    { _id: false }
)

const shortAnswerQuestionSchema = new mongoose.Schema(
    {
        question: { type: String, required: true },
        pinyin: { type: String, default: '' },
        acceptedAnswers: { type: [String], required: true },
    },
    { _id: false }
)

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    // "upload" -> dùng videoUrl (đường dẫn file tự host)
    // "youtube" -> dùng youtubeId (chỉ 11 ký tự ID, không lưu URL đầy đủ)
    type: { type: String, enum: ['upload', 'youtube'], default: 'upload' },
    videoUrl: { type: String, trim: true, default: '' },
    youtubeId: { type: String, trim: true, default: '' },
    order: { type: Number, default: 0 },
    dialogue: { type: [dialogueLineSchema], default: [] },
  },
  { _id: false }
)

const lessonSchema = new mongoose.Schema(
    {
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
        title: { type: String, required: true, trim: true },
        slug: { type: String, required: true, lowercase: true, trim: true },
        description: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },

        videos: { type: [videoSchema], default: [] },
        vocabulary: { type: [vocabularyItemSchema], default: [] },

        exercises: {
            multipleChoice: { type: [multipleChoiceQuestionSchema], default: [] },
            trueFalse: { type: [trueFalseQuestionSchema], default: [] },
            sentenceOrder: { type: [sentenceOrderQuestionSchema], default: [] },
            shortAnswer: { type: [shortAnswerQuestionSchema], default: [] },
        },
    },
    { timestamps: true }
)

lessonSchema.index({ courseId: 1, slug: 1 }, { unique: true })

module.exports = mongoose.model('Lesson', lessonSchema)