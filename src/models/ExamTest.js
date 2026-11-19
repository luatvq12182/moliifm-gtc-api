const mongoose = require('mongoose')

/**
 * Một ĐỀ LUYỆN THI (thi thử HSK 3.0) thuộc một cấp thi.
 *
 *   pdf     đề giấy dạng PDF (thường là bản scan), chuyển thành ảnh từng trang
 *           để hiện bên trái màn hình làm bài. `hidden`: trang bỏ đi (trang
 *           trùng, trang trắng, bìa đề khác…) — học viên không thấy.
 *   audio   file nghe, phát MỘT LẦN trong phần nghe (khách chốt).
 *   groups  cấu trúc phiếu trả lời theo từng nhóm câu liên tiếp, vd. câu 1–5
 *           chọn tranh A–F, câu 61–65 viết chữ Hán, 66–70 đặt câu (AI chấm).
 *   items   đáp án từng câu (theo số câu). KHÔNG BAO GIỜ gửi cho học viên trước
 *           khi nộp bài.
 *
 * Thời gian: phần nghe = độ dài file nghe (hoặc số admin đặt), sau đó 5 phút
 * xem lại đáp án phần nghe (không có tiếng), rồi đọc, rồi viết.
 */
const pageSchema = new mongoose.Schema(
    {
        file: { type: String, required: true },
        thumb: { type: String, default: '' },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        hidden: { type: Boolean, default: false },
    },
    { _id: false }
)

const groupSchema = new mongoose.Schema(
    {
        section: { type: String, enum: ['listening', 'reading', 'writing'], required: true },
        // choice: chọn một chữ cái · text: viết đáp án (so khớp) · sentence: đặt câu, AI chấm
        type: { type: String, enum: ['choice', 'text', 'sentence'], required: true },
        from: { type: Number, required: true },
        to: { type: Number, required: true },
        options: { type: String, default: '' }, // các lựa chọn của nhóm choice, vd. "ABCDEF"
        title: { type: String, default: '' }, // lời dẫn ngắn hiện trên phiếu trả lời
        page: { type: Number, default: 0 }, // trang đề (đếm cả trang ẩn) có nhóm câu này — màn làm bài cuộn tới đó; 0 = không đặt
        points: { type: Number, default: 0 }, // điểm mỗi câu đúng (choice / text)
        verdictPoints: {
            dat: { type: Number, default: 0 },
            gan_dat: { type: Number, default: 0 },
            chua_dat: { type: Number, default: 0 },
        },
    },
    { _id: false }
)

const itemSchema = new mongoose.Schema(
    {
        no: { type: Number, required: true },
        answer: { type: String, default: '' }, // choice: "B" · text: "汽" hoặc nhiều cách "的/得"
        keyword: { type: String, default: '' }, // sentence: từ bắt buộc dùng
        sample: { type: String, default: '' }, // sentence: câu mẫu (hiện ở kết quả, gợi ý cho AI)
        hint: { type: String, default: '' }, // sentence: mô tả tranh (AI không xem được tranh)
        // Hiện ở trang kết quả sau khi nộp (khách yêu cầu: xem được đáp án cụ thể + giải thích):
        script: { type: String, default: '' }, // nội dung hội thoại / đoạn văn (phần nghe) kèm pinyin
        explain: { type: String, default: '' }, // giải thích đáp án (vì sao đúng / sai)
    },
    { _id: false }
)

const examTestSchema = new mongoose.Schema(
    {
        levelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamLevel', required: true, index: true },
        title: { type: String, required: true, trim: true },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },

        pdf: {
            originalName: { type: String, default: '' },
            bytes: { type: Number, default: 0 },
            version: { type: Number, default: 0 }, // 0 = chưa có file
            splitSpreads: { type: Boolean, default: false },
            conversion: { type: String, enum: ['none', 'processing', 'ready', 'failed'], default: 'none' },
            error: { type: String, default: '' },
            pages: { type: [pageSchema], default: [] },
        },
        audio: {
            file: { type: String, default: '' },
            originalName: { type: String, default: '' },
            bytes: { type: Number, default: 0 },
            durationSec: { type: Number, default: 0 },
            version: { type: Number, default: 0 },
        },
        timing: {
            listeningSec: { type: Number, default: 0 }, // 0 = theo độ dài file nghe
            reviewSec: { type: Number, default: 300 },
            readingSec: { type: Number, default: 1800 },
            writingSec: { type: Number, default: 1200 },
        },
        passScore: { type: Number, default: 180 },
        groups: { type: [groupSchema], default: [] },
        items: { type: [itemSchema], default: [] },
    },
    { timestamps: true }
)

examTestSchema.index({ levelId: 1, order: 1 })

module.exports = mongoose.model('ExamTest', examTestSchema)
