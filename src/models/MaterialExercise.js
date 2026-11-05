const mongoose = require('mongoose')

/**
 * BÀI TẬP của một khoá học liệu (HSK 1, HSK 2…) — MỖI KHOÁ MỘT BỘ, dù khoá
 * có nhiều video. Học viên phải xem ĐỦ TẤT CẢ video đang hiện của khoá (mỗi
 * video 95% thời lượng thực sự phát) mới được làm. Một bộ gồm nhiều phần
 * (Bài 1, 2, …).
 *
 * Ba dạng phần (theo file "Bài tập ứng dụng" của khách):
 *
 *   word_bank  Chọn từ điền vào chỗ trống. `words` là ô từ cho sẵn; mỗi câu
 *              `text` (nhiều dòng được — hội thoại) có chỗ trống viết "___",
 *              `answers` là đáp án theo thứ tự chỗ trống. Chấm tự động.
 *   pinyin     Viết chữ Hán theo pinyin. `pinyin` hiện trên chỗ trống, học
 *              viên tự gõ chữ Hán. Chấm tự động.
 *   sentence   Đặt câu với từ cho sẵn (+ hình). `word`, `image`, `sample` (câu
 *              mẫu). AI chấm (lib/aiGrader.js).
 *
 * Đáp án đúng nhiều cách thì ghi "有的/有些". `explain` / `sample` là lời giải
 * (chữ Hán, pinyin, nghĩa) — chỉ hiện SAU khi nộp bài, máy chủ không gửi trước.
 * `version` tăng mỗi lần admin lưu; lượt làm bài giữ bản chụp đề của lúc nộp.
 */
const itemSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        text: { type: String, default: '' },
        answers: { type: [String], default: [] },
        explain: { type: String, default: '' },
        pinyin: { type: String, default: '' },
        word: { type: String, default: '' },
        image: { type: String, default: '' },
        sample: { type: String, default: '' },
    },
    { _id: false }
)

const sectionSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        type: { type: String, enum: ['word_bank', 'pinyin', 'sentence'], required: true },
        title: { type: String, default: '' },
        words: { type: [String], default: [] },
        items: { type: [itemSchema], default: [] },
    },
    { _id: false }
)

const materialExerciseSchema = new mongoose.Schema(
    {
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true, unique: true },
        sections: { type: [sectionSchema], default: [] },
        version: { type: Number, default: 1 },
    },
    { timestamps: true }
)

module.exports = mongoose.model('MaterialExercise', materialExerciseSchema)
