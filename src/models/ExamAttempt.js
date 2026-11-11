const mongoose = require('mongoose')

/**
 * Một LƯỢT LÀM ĐỀ luyện thi của học viên.
 *
 * Giờ do MÁY CHỦ giữ: bài chia thành các phần nối tiếp nhau (nghe -> xem lại
 * đáp án nghe -> đọc -> viết), mỗi phần có độ dài cố định. `sectionIndex` +
 * `sectionStartedAt` cho biết đang ở phần nào, bắt đầu lúc nào; hết giờ phần
 * nào thì phần sau bắt đầu NGAY lúc đó (kể cả khi học viên đóng trang), hết
 * phần cuối là tự nộp. Phần đọc / viết cho nộp sớm (khách chốt).
 *
 * `snapshot`: cấu trúc phiếu trả lời + thời gian của đề lúc bắt đầu làm — admin
 * sửa đề giữa chừng không làm lệch bài đang làm. Đáp án đúng KHÔNG chép vào đây.
 */
const examAttemptSchema = new mongoose.Schema(
    {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        testId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamTest', required: true, index: true },
        levelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamLevel', required: true, index: true },
        status: { type: String, enum: ['in_progress', 'submitted'], default: 'in_progress' },
        // Thông tin thí sinh điền trước khi vào thi (khách chốt: tên, SĐT, mã lớp).
        candidate: {
            name: { type: String, default: '' },
            phone: { type: String, default: '' },
            classCode: { type: String, default: '' },
        },
        snapshot: {
            title: { type: String, default: '' },
            groups: { type: Array, default: [] },
            keywords: { type: Object, default: {} }, // câu đặt câu -> từ bắt buộc (in sẵn trên đề)
            audioVersion: { type: Number, default: 0 },
        },
        // [{ id: 'listening'|'review'|'reading'|'writing', durationSec }]
        sections: { type: Array, default: [] },
        sectionIndex: { type: Number, default: 0 },
        sectionStartedAt: { type: Date, required: true },
        // Phần hiện tại bắt đầu vì phần trước HẾT GIỜ ('time') hay học viên nộp
        // sớm ('early'). Chỉ khi hết giờ mới nhận câu trả lời gửi trễ của phần trước.
        sectionStartReason: { type: String, enum: ['', 'time', 'early'], default: '' },
        startedAt: { type: Date, required: true },
        submittedAt: { type: Date, default: null },
        submitReason: { type: String, enum: ['', 'time', 'early'], default: '' },
        // Câu trả lời theo số câu: { "1": "B", "61": "汽", "66": "..." }
        answers: { type: Object, default: {} },
        // Kết quả chấm (lib/examGrading.js): từng câu, điểm từng phần, tổng,
        // trạng thái AI chấm phần đặt câu. null = chưa chấm.
        result: { type: Object, default: null },
    },
    { timestamps: true, minimize: false }
)

examAttemptSchema.index({ student: 1, testId: 1, status: 1 })

module.exports = mongoose.model('ExamAttempt', examAttemptSchema)
