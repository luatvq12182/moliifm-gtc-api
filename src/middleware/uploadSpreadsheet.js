const multer = require('multer')

// GIỮ FILE TRONG BỘ NHỚ, KHÔNG GHI RA ĐĨA.
//
// Khác với upload ảnh/video (ghi vào uploads/ rồi phục vụ công khai), file này
// chứa DỮ LIỆU CÁ NHÂN của hàng trăm người: họ tên, email, số điện thoại. Đọc
// xong là xong, không có lý do gì để nó nằm lại trên đĩa — càng không phải
// trong thư mục được phục vụ công khai.
const storage = multer.memoryStorage()

const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i

function fileFilter(req, file, cb) {
    if (!ALLOWED_EXT.test(file.originalname || '')) {
        return cb(new Error('Chỉ nhận file Excel (.xlsx) hoặc CSV (.csv).'))
    }
    cb(null, true)
}

const uploadSpreadsheet = multer({
    storage,
    fileFilter,
    // 500 dòng học viên chỉ cỡ vài chục KB. 2MB đã rất rộng rãi, và chặn được
    // việc ai đó đẩy file khổng lồ làm nghẽn bộ nhớ tiến trình.
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
})

module.exports = uploadSpreadsheet
