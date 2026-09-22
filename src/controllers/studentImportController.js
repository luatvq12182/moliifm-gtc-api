const asyncHandler = require('../utils/asyncHandler')
const Student = require('../models/Student')
const generateTempPassword = require('../utils/generatePassword')
const { normalizePhone } = require('../lib/phone')
const {
    parseStudentFile,
    validateRows,
    buildResultWorkbook,
    buildTemplateWorkbook,
    MAX_ROWS,
} = require('../lib/studentImport')

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Tạo theo lô rồi nhả event loop giữa các lô.
//
// Băm bcrypt tốn ~50ms mỗi mật khẩu và ĂN CPU. Bản bất đồng bộ có nhả event loop
// giữa các lần băm (đo được: khoảng chết dài nhất 51ms), nhưng chạy liên tục
// mấy trăm lần thì event loop gần như lúc nào cũng bận. Chèn một nhịp nghỉ giữa
// các lô để những việc khác — nhất là WebSocket chấm phát âm chạy CHUNG TIẾN
// TRÌNH — còn kịp xen vào.
const CHUNK_SIZE = 20

function sendWorkbook(res, buffer, filename) {
    res.setHeader('Content-Type', XLSX_MIME)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    // File chứa mật khẩu chưa mã hoá — tuyệt đối không để proxy hay trình duyệt
    // giữ lại bản sao.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.send(Buffer.from(buffer))
}

// Đọc file + soát, KHÔNG tạo gì. Dùng chung cho cả bước xem trước lẫn bước tạo,
// để hai bước không thể nhìn dữ liệu theo hai kiểu khác nhau.
async function readAndValidate(file) {
    if (!file) {
        const err = new Error('Chưa chọn file danh sách học viên.')
        err.status = 400
        throw err
    }

    const { rows, headerRow } = await parseStudentFile(file.buffer, file.originalname)

    if (rows.length === 0) {
        const err = new Error('File không có dòng học viên nào.')
        err.status = 400
        throw err
    }
    if (rows.length > MAX_ROWS) {
        const err = new Error(
            `File có ${rows.length} dòng, vượt giới hạn ${MAX_ROWS} dòng mỗi lần nhập. ` +
            `Hãy chia nhỏ file rồi nhập làm nhiều lần.`
        )
        err.status = 400
        throw err
    }

    // Chỉ hỏi cơ sở dữ liệu đúng những số/email có trong file, thay vì tải
    // toàn bộ học viên về — khách có hàng nghìn tài khoản.
    const phones = rows.map((r) => normalizePhone(r.phone)).filter(Boolean)
    const emails = rows.map((r) => r.email.toLowerCase().trim()).filter(Boolean)
    const found = await Student.find({
        $or: [{ phone: { $in: phones } }, { email: { $in: emails } }],
    })
        .select('phone email')
        .lean()
    const existing = {
        phones: new Set(found.map((s) => s.phone)),
        emails: new Set(found.map((s) => s.email).filter(Boolean)),
    }

    return { ...validateRows(rows, existing), headerRow, fileName: file.originalname }
}

// POST /api/students/import/preview
const previewImport = asyncHandler(async function previewImport(req, res) {
    const result = await readAndValidate(req.file)
    res.json({
        fileName: result.fileName,
        headerRow: result.headerRow,
        summary: result.summary,
        // Xem trước vài dòng đầu để admin biết cột đã ánh xạ đúng chưa.
        sample: result.ready.slice(0, 5),
        problems: result.problems,
    })
})

// POST /api/students/import/commit
const commitImport = asyncHandler(async function commitImport(req, res) {
    // ĐỌC LẠI TỪ FILE, không nhận danh sách dòng do trình duyệt gửi lên.
    //
    // Hai lý do: trình duyệt không thể tự chế thêm dòng, và quan trọng hơn —
    // giữa lúc xem trước và lúc bấm tạo có thể ai đó vừa tạo trùng email. Soát
    // lại với cơ sở dữ liệu ngay trước khi ghi mới bắt được.
    const { ready, problems } = await readAndValidate(req.file)

    if (ready.length === 0) {
        res.status(400)
        throw new Error('Không có dòng nào hợp lệ để tạo tài khoản.')
    }

    const created = []
    const failed = [...problems]

    for (let i = 0; i < ready.length; i += CHUNK_SIZE) {
        const chunk = ready.slice(i, i + CHUNK_SIZE)

        for (const row of chunk) {
            const password = generateTempPassword()
            try {
                await Student.create({
                    name: row.name,
                    phone: row.phone,
                    email: row.email, // '' -> setter trong model đổi thành undefined
                    password,
                })
                created.push({ ...row, password })
            } catch (err) {
                // Một dòng hỏng KHÔNG được làm đổ cả lô. Hay gặp nhất là đụng
                // ràng buộc email duy nhất do có người tạo xen vào giữa chừng.
                console.error('[nhập học viên] Lỗi dòng', row.rowNumber, row.email, err.message)
                failed.push({
                    rowNumber: row.rowNumber,
                    name: row.name,
                    email: row.email,
                    reason:
                        err.code === 11000
                            ? 'Số điện thoại hoặc email vừa được tạo bởi thao tác khác'
                            : 'Lỗi khi tạo tài khoản: ' + err.message,
                })
            }
        }

        await new Promise((resolve) => setImmediate(resolve))
    }

    console.log(
        `[nhập học viên] Tạo ${created.length} tài khoản, bỏ qua ${failed.length} dòng ` +
        `(admin ${req.admin?.email || '?'})`
    )

    const buffer = await buildResultWorkbook(created, failed)
    const stamp = new Date().toISOString().slice(0, 10)
    sendWorkbook(res, buffer, `tai-khoan-hoc-vien-${stamp}.xlsx`)
})

// GET /api/students/import/template
const downloadTemplate = asyncHandler(async function downloadTemplate(req, res) {
    const buffer = await buildTemplateWorkbook()
    sendWorkbook(res, buffer, 'mau-danh-sach-hoc-vien.xlsx')
})

module.exports = { previewImport, commitImport, downloadTemplate }
