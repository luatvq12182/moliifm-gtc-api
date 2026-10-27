const mongoose = require('mongoose')

/**
 * MỘT BỘ SLIDE trong một khoá học liệu (vd. "Bài 3 — Bạn tên là gì?").
 *
 * Hai nguồn: giảng viên TẢI FILE lên (PowerPoint .pptx/.ppt/.odp hoặc PDF), hoặc
 * DÁN LINK Google Slides — máy chủ tự lấy bản PDF Google xuất ra. Cả hai đều
 * được chuyển thành ẢNH TỪNG TRANG (lib/materialConvert.js) và học viên chỉ
 * xem ảnh:
 *
 *  - Khách yêu cầu học viên XEM được nhưng KHÔNG tải được. File gốc không bao
 *    giờ rời máy chủ; ảnh từng trang chỉ phát qua route có kiểm quyền, kèm
 *    watermark tên học viên ở giao diện (xem trang xem slide).
 *  - Hiển thị giống nhau trên mọi máy, không phụ thuộc máy học viên có cài
 *    PowerPoint hay font chữ Hán nào.
 *
 * File nằm ở storage/materials/<deckId>/ (KHÔNG ở uploads/ — thư mục đó đang
 * được phục vụ công khai).
 */
const materialPageSchema = new mongoose.Schema(
    {
        file: { type: String, required: true }, // tên file trong thư mục của bộ slide
        // Ảnh thu nhỏ cho cột xem trước bên trái trình xem. Rỗng ở bộ slide
        // chuyển trước khi có tính năng này -> phục vụ ảnh lớn thay thế.
        thumb: { type: String, default: '' },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
    },
    { _id: false }
)

const materialDeckSchema = new mongoose.Schema(
    {
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCourse', required: true, index: true },
        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true, default: '' },
        order: { type: Number, default: 0 },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },

        // Nguồn của bộ slide — chỉ để chuyển đổi lại khi cần, KHÔNG phục vụ ra
        // ngoài (học viên không bao giờ thấy tên file hay link Google).
        source: {
            kind: { type: String, enum: ['upload', 'google'], default: 'upload' },
            originalName: { type: String, default: '' },
            ext: { type: String, default: '' }, // 'pdf' | 'pptx' | 'ppt' | 'odp'
            bytes: { type: Number, default: 0 },
            // Chỉ nguồn Google: loại link, mã file, link admin đã dán.
            //   slides -> bài trình bày Google Slides (lấy bản PDF Google xuất)
            //   drive  -> file PDF / PowerPoint để trên Google Drive
            googleType: { type: String, enum: ['slides', 'drive'], default: 'slides' },
            googleId: { type: String, default: '' },
            googleUrl: { type: String, default: '' },
        },

        // Trạng thái chuyển đổi sang ảnh.
        //   processing -> đang chuyển (vài giây tới vài phút tuỳ số trang)
        //   ready      -> xem được
        //   failed     -> lỗi, xem `conversionError`; giảng viên tải lại file
        conversion: {
            type: String,
            enum: ['processing', 'ready', 'failed'],
            default: 'processing',
        },
        conversionError: { type: String, default: '' },
        // Admin không đặt tên khi thêm bằng link -> lấy theo tên file Google
        // ngay khi tải về được (rồi tắt cờ).
        titleFromSource: { type: Boolean, default: false },
        // Đổi mỗi lần tải file mới — ảnh cũ và mới không bao giờ lẫn nhau, và
        // trình duyệt không hiện nhầm ảnh cũ còn trong bộ nhớ.
        version: { type: Number, default: 1 },

        pages: { type: [materialPageSchema], default: [] },
    },
    { timestamps: true }
)

materialDeckSchema.index({ courseId: 1, order: 1 })

module.exports = mongoose.model('MaterialDeck', materialDeckSchema)
