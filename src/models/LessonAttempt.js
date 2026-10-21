const mongoose = require('mongoose')

/**
 * MỘT CÂU BÀI TẬP đã làm — đúng hay sai đều lưu.
 *
 * Chỉ lưu câu sai thì học viên mở lịch sử ra chỉ thấy những chỗ mình làm
 * hỏng, không thấy mình đã làm những gì; và giáo viên không đối chiếu được
 * con số "4/6" với bài cụ thể.
 */
const answerSchema = new mongoose.Schema(
    {
        correct: { type: Boolean, default: false },
        type: String, // nhãn dạng bài, vd. "Chọn đáp án đúng"
        question: String,
        pinyin: String,
        yourAnswer: String,
        yourPinyin: String,
        correctAnswer: String,
        correctPinyin: String,
        // Chỉ dạng Đúng/Sai: câu sửa lại cho đúng khi nhận định là Sai.
        correction: String,
        correctionPinyin: String,
    },
    { _id: false }
)

/** Một LƯỢT đọc của học viên. */
const readingSchema = new mongoose.Schema(
    {
        attemptId: { type: mongoose.Schema.Types.ObjectId, default: null },
        score: { type: Number, default: null }, // null = bị từ chối / không qua cổng chấm
        at: { type: Date, default: null },
    },
    { _id: false }
)

/**
 * Một CÂU luyện nói. Lấy TỪ MÁY CHỦ, không lấy từ trình duyệt.
 *
 * GIỮ MỌI LƯỢT ĐỌC: học viên đọc một câu năm lần thì cả năm đều nằm trong
 * `attempts`, kèm file ghi âm riêng. Khách muốn thấy học viên thử mấy lần mới
 * đạt, và nghe lại được cả những lần chưa tốt.
 *
 * `score` và `attemptId` ở cấp câu là của LƯỢT CUỐI — đó là con số học viên
 * thấy trên màn hình làm bài, và là con số đi vào điểm trung bình.
 */
const spokenLineSchema = new mongoose.Schema(
    {
        videoIndex: { type: Number, default: -1 },
        lineIndex: Number,
        hanzi: String,
        pinyin: String,
        score: { type: Number, default: null },
        attemptId: { type: mongoose.Schema.Types.ObjectId, default: null },
        attempts: { type: [readingSchema], default: [] },
    },
    { _id: false }
)

const videoResultSchema = new mongoose.Schema(
    {
        index: Number,
        title: String,
        exercise: {
            // null khi video không có bài tập nào. KHÁC HẲN 0/0: hiện "0 điểm"
            // cho bài vốn không có bài tập là báo sai cho học viên.
            correct: { type: Number, default: null },
            total: { type: Number, default: null },
            answers: { type: [answerSchema], default: [] },
        },
        speaking: {
            avgScore: { type: Number, default: null },
            lines: { type: [spokenLineSchema], default: [] },
        },
    },
    { _id: false }
)

/**
 * MỘT LƯỢT HỌC MỘT BÀI — đang học dở hoặc đã hoàn thành.
 *
 * LÀM ĐẾN ĐÂU LƯU ĐẾN ĐÓ (khách đổi yêu cầu, 10/2026). Trước đây bản ghi chỉ
 * được tạo khi học viên đi hết cả bài; nay nó được tạo ngay từ câu trả lời
 * hay lượt đọc đầu tiên, trạng thái `in_progress`, và cập nhật liên tục.
 * Học viên bận việc giữa chừng thì lần sau mở bài ra học tiếp đúng chỗ cũ —
 * trên máy nào cũng được, vì tiến độ nằm ở máy chủ.
 *
 * Mỗi học viên có TỐI ĐA MỘT lượt đang dở cho mỗi bài (chỉ mục duy nhất ở
 * cuối file). Học xong thì lượt đó chuyển `completed`; mở bài ra học lại lần
 * nữa là một lượt mới.
 *
 * QUAN HỆ VỚI PracticeAttempt: model này là MỤC LỤC, PracticeAttempt là kho
 * chi tiết (chấm từng chữ, XML thô của iFLYTEK, file ghi âm). Mỗi câu luyện
 * nói ở đây trỏ về đúng bản ghi chi tiết của nó qua `attemptId`.
 *
 * LÀM LẠI BÀI = MỘT BẢN GHI MỚI, không ghi đè. Học lại lần hai được 90 sau
 * lần đầu 60 là thông tin đáng giá cho cả học viên lẫn trung tâm.
 */
const lessonAttemptSchema = new mongoose.Schema(
    {
        student: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Student',
            required: true,
            index: true,
        },

        // BỐI CẢNH CHỤP LẠI TẠI THỜI ĐIỂM HOÀN THÀNH.
        //
        // Lưu cả ObjectId lẫn slug/tiêu đề dạng chuỗi, cùng lý do như
        // PracticeAttempt: bài học có thể bị đổi tên hoặc xoá về sau, nhưng
        // lịch sử phải đọc được nguyên vẹn mà không cần join tới bản ghi có
        // thể đã biến mất.
        lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
        curriculumSlug: { type: String, default: '' },
        courseSlug: { type: String, default: '' },
        lessonSlug: { type: String, default: '' },
        lessonTitle: { type: String, default: '' },
        lessonOrder: { type: Number, default: 0 },
        // TÊN hiển thị, không phải slug. "Bài 1" một mình thì vô nghĩa — mỗi
        // khóa HSK đều có Bài 1, và màn lịch sử trộn chung mọi khóa. Máy chủ
        // tự tra ngược từ lessonId chứ không nhận từ client: trang học chỉ có
        // slug trên URL, không biết tên khóa.
        courseName: { type: String, default: '' },
        curriculumName: { type: String, default: '' },
        // Ảnh bìa khoá, chụp lại cùng lúc với tên. Màn lịch sử trộn chung mọi
        // khoá nên một dãy dòng chữ giống hệt nhau rất khó lướt; ảnh bìa là
        // thứ phân biệt nhanh nhất.
        courseThumbnail: { type: String, default: '' },

        status: {
            type: String,
            enum: ['in_progress', 'completed'],
            default: 'completed',
        },
        // null khi còn đang học. Mặc định Date.now là để giữ nguyên hành vi cho
        // nơi tạo bản ghi theo kiểu cũ (hoàn thành ngay lúc tạo).
        completedAt: { type: Date, default: Date.now },
        // Lần cuối học viên làm gì đó với lượt này (trả lời, đọc, sang bước).
        // Màn lịch sử sắp xếp và lọc thời gian theo mốc này: bài đang dở học
        // hôm qua phải đứng trên bài đã xong tuần trước.
        activityAt: { type: Date, default: Date.now },
        // 0..100, tính theo số bước đã xong (có tính phần dở của bước bài tập
        // và luyện nói). Bài hoàn thành luôn là 100.
        progressPercent: { type: Number, default: 100 },

        // ẢNH CHỤP TIẾN ĐỘ để trang học dựng lại đúng chỗ cũ: video đang mở,
        // bước đã xong, từng câu bài tập đã trả lời. Do trình duyệt tạo ra và
        // chỉ trình duyệt hiểu — máy chủ không đọc nội dung, chỉ cất giữ (có
        // giới hạn kích thước, xem controller). Xoá đi khi bài hoàn thành.
        //
        // Ghi âm luyện nói KHÔNG nằm ở đây: chúng là PracticeAttempt trỏ về
        // lượt này, máy chủ tự ghi lúc chấm.
        progress: { type: mongoose.Schema.Types.Mixed, default: null },

        // --- Tổng hợp cả bài ---
        exercise: {
            // Cộng dồn số câu đúng và tổng số câu của MỌI video rồi mới quy ra
            // thang 100 — không lấy trung bình các tỉ lệ phần trăm, vì video 2
            // câu và video 20 câu mà cân bằng nhau thì con số vô nghĩa.
            correct: { type: Number, default: null },
            total: { type: Number, default: null },
            score100: { type: Number, default: null },
        },
        speaking: {
            avgScore: { type: Number, default: null },
            lineCount: { type: Number, default: 0 },
            // Số câu THỰC SỰ chấm được. Câu bị iFLYTEK từ chối không tính vào
            // điểm trung bình (gộp vào như số 0 sẽ kéo tụt điểm oan), nhưng
            // vẫn phải đếm riêng để biết trung bình dựa trên bao nhiêu câu.
            scoredCount: { type: Number, default: 0 },
            // Tổng số LƯỢT đọc, kể cả đọc lại. Khác lineCount — nó nói lên
            // học viên phải thử bao nhiêu lần mới xong bài.
            totalReadings: { type: Number, default: 0 },
        },

        videos: { type: [videoResultSchema], default: [] },

        // Điểm bài tập do TRÌNH DUYỆT gửi lên.
        //
        // Bài tập của tính năng này được chấm ở phía trình duyệt (khác với
        // module Luyện thi HSK 3.0 chấm ở máy chủ), nên máy chủ không xác minh
        // được con số. Điểm luyện nói thì ngược lại — nó được dựng lại từ
        // PracticeAttempt, là dữ liệu máy chủ tự ghi.
        //
        // Ghi cờ này để sau có ai dùng số liệu đi đối chất thì biết rõ phần
        // nào kiểm chứng được, phần nào không.
        exerciseScoreTrusted: { type: Boolean, default: false },
    },
    { timestamps: true }
)

// Truy vấn chính của màn lịch sử: của một học viên, mới hoạt động nhất trước.
lessonAttemptSchema.index({ student: 1, activityAt: -1 })
lessonAttemptSchema.index({ student: 1, completedAt: -1 })
// MỘT lượt đang dở cho mỗi (học viên, bài). Chặn ở tầng cơ sở dữ liệu chứ
// không chỉ ở code: lượt đọc đầu tiên (qua WebSocket) và lần lưu tiến độ đầu
// tiên (qua HTTP) có thể tới cùng lúc, và cả hai đều "tìm không thấy thì tạo".
lessonAttemptSchema.index(
    { student: 1, lesson: 1 },
    { unique: true, partialFilterExpression: { status: 'in_progress' }, name: 'one_in_progress_per_lesson' }
)
// Màn đối chiếu của admin: ai đã học bài này.
lessonAttemptSchema.index({ lesson: 1, completedAt: -1 })

module.exports = mongoose.model('LessonAttempt', lessonAttemptSchema)
