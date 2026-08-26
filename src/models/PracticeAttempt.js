const mongoose = require('mongoose')

// Chi tiết chấm của TỪNG CHỮ, giữ nguyên hình dạng mà iFLYTEK trả về sau khi
// đã được lib/iflytek.js diễn giải sang tiếng Việt.
const charResultSchema = new mongoose.Schema(
    {
        content: String,
        pinyin: String,
        issue: String, // '' nếu đọc đúng; ngược lại: 'sai thanh mẫu', 'đọc thiếu'...
        ok: Boolean,
        // 'good' | 'fair' | 'weak' — ba mức, suy từ perr_level_msg của iFLYTEK.
        // Chữ được coi là đúng thì cao nhất chỉ tới 'fair', không bao giờ 'weak'.
        level: String,
        // Vị trí chữ này trong file ghi âm (ms), để cắt ra nghe lại đúng chữ đó.
        begMs: Number,
        endMs: Number,
    },
    { _id: false }
)

/**
 * Một lượt học viên luyện đọc MỘT câu.
 *
 * CHỈ được ghi khi PRACTICE_HISTORY_ENABLED bật (xem src/config/features.js).
 * Toàn bộ collection này là dữ liệu của giai đoạn phát triển/nghiệm thu; khi
 * sản phẩm ra thị trường thì tắt cờ và có thể xoá sạch collection.
 */
const practiceAttemptSchema = new mongoose.Schema(
    {
        student: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Student',
            required: true,
            index: true,
        },

        // --- Câu đã đọc thuộc bài nào ---
        // Lưu cả ObjectId (để join) LẪN slug/tiêu đề dạng chuỗi (để hiển thị).
        // Lý do lưu trùng: bài học có thể bị sửa tên hoặc xoá về sau, nhưng lịch
        // sử phải giữ nguyên bối cảnh tại thời điểm học viên đọc.
        lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
        curriculumSlug: { type: String, default: '' },
        courseSlug: { type: String, default: '' },
        lessonSlug: { type: String, default: '' },
        lessonTitle: { type: String, default: '' },

        // --- Câu cụ thể trong bài ---
        lineIndex: { type: Number, default: -1 }, // vị trí trong danh sách hội thoại đã gộp
        referenceText: { type: String, required: true }, // câu mẫu (chữ Hán)
        referencePinyin: { type: String, default: '' },
        referenceVi: { type: String, default: '' },

        // --- Kết quả chấm ---
        // Điểm gốc iFLYTEK (thang 100). Lưu nguyên bản để sau này đổi cách quy
        // đổi sang thang hiển thị mà không mất dữ liệu.
        rawScores: {
            total_score: Number,
            phone_score: Number,
            tone_score: Number,
            fluency_score: Number,
            integrity_score: Number,
        },
        // Điểm hiển thị (thang 100) theo công thức trong lib/pronunciationScore.js.
        // null khi bị từ chối hoặc không qua cổng "đọc đủ".
        // Vì rawScores ở trên vẫn giữ nguyên điểm gốc iFLYTEK, có thể chấm lại
        // toàn bộ lịch sử bằng công thức khác mà không cần ghi âm lại.
        pronScore: { type: Number, default: null },

        // Đối chiếu câu mà IAT nghe được với câu mẫu — nhân chứng ĐỘC LẬP với
        // ISE. ISE ép khớp audio vào câu mẫu nên đọc ra chữ gì nó cũng cố khớp;
        // IAT thì không biết câu mẫu. Tỉ lệ khớp được dùng làm TRẦN cho điểm.
        // Xem lib/spokenTextMatch.js.
        spokenMatch: {
            applicable: { type: Boolean, default: false },
            ratio: { type: Number, default: null }, // 0..1
            matched: { type: Number, default: 0 },
            total: { type: Number, default: 0 },
            missedText: { type: String, default: '' }, // chữ trong câu mẫu không được nghe ra
            cap: { type: Number, default: null }, // null = không siết
            cappedFrom: { type: Number, default: null }, // điểm gốc trước khi siết
        },

        // Nhận xét theo TỪ (gom từ chars). Không ảnh hưởng tới pronScore.
        words: {
            type: [
                new mongoose.Schema(
                    {
                        content: String,
                        pinyin: String,
                        score: Number,
                        status: String, // good | fair | weak
                        issue: String,
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
        // 'pinyin' = phân từ theo phiên âm bài học (tin cậy nhất)
        // 'neutral-tone' = dự phòng, dồn thanh nhẹ vào chữ trước
        // 'per-char' = không gom được, giữ nguyên từng chữ
        wordGroupingMethod: { type: String, default: '' },
        feedback: { type: String, default: '' },

        // XML THÔ mà iFLYTEK trả về, giữ nguyên không xử lý.
        //
        // Đây là nguồn sự thật duy nhất để đối chứng khi có tranh cãi kiểu "vì
        // sao chữ 哦 bị báo sai thanh mẫu trong khi âm tiết này không có thanh
        // mẫu". Không có XML thô thì mọi kết luận về nhãn lỗi đều là suy đoán.
        //
        // Chỉ lưu khi PRACTICE_HISTORY_ENABLED bật (giai đoạn phát triển).
        rawXml: { type: String, default: '' },
        isRejected: { type: Boolean, default: false },
        exceptInfo: { type: String, default: null },
        spokenText: { type: String, default: '' }, // "Nội dung bạn nói" từ IAT
        chars: { type: [charResultSchema], default: [] },

        // --- File ghi âm ---
        // audioPath là đường dẫn TƯƠNG ĐỐI tính từ thư mục storage/, KHÔNG nằm
        // trong uploads/ vì uploads/ đang được express.static phục vụ công khai.
        // Giọng nói học viên là dữ liệu cá nhân, chỉ được đọc qua route có
        // kiểm tra quyền admin.
        audioPath: { type: String, default: '' },
        audioBytes: { type: Number, default: 0 },
        durationMs: { type: Number, default: 0 },
        sampleRate: { type: Number, default: 16000 },

        // --- Bối cảnh kỹ thuật, phục vụ chẩn đoán ---
        // Chính là thứ giúp trả lời "vì sao máy này chấm khác máy kia".
        client: {
            userAgent: { type: String, default: '' },
            micLabel: { type: String, default: '' },
            micSampleRate: { type: Number, default: null }, // tần số của MICRO
            // Tần số thật của AudioContext — quyết định nhánh hạ tần số nào đã
            // chạy. 16000 = trình duyệt tự resample (tốt nhất); 44100/48000 =
            // đang chạy nhánh dự phòng biquad của client.
            contextSampleRate: { type: Number, default: null },
            resampleMode: { type: String, default: '' }, // 'browser' | 'fallback-biquad'
            echoCancellation: { type: Boolean, default: null },
            noiseSuppression: { type: Boolean, default: null },
            autoGainControl: { type: Boolean, default: null },
            captureMode: { type: String, default: '' }, // 'worklet' | 'scriptprocessor'
        },
    },
    { timestamps: true }
)

// Truy vấn chính của trang admin: lấy lịch sử của 1 học viên, mới nhất trước.
practiceAttemptSchema.index({ student: 1, createdAt: -1 })

module.exports = mongoose.model('PracticeAttempt', practiceAttemptSchema)
