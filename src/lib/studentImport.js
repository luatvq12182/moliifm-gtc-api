/**
 * Đọc và soát file danh sách học viên (Excel/CSV) trước khi tạo tài khoản.
 *
 * File này KHÔNG tạo tài khoản — nó chỉ đọc, chuẩn hoá và chỉ ra chỗ hỏng. Tách
 * bạch như vậy để có thể cho admin XEM TRƯỚC toàn bộ kết quả rồi mới ghi.
 *
 * VÌ SAO PHẢI XEM TRƯỚC: nhập một nghìn dòng mà làm một lượt thì đến dòng 601
 * gặp email hỏng là đã lỡ tạo 600 tài khoản, không lùi lại được. Soát sạch
 * trước, admin gật xong mới tạo.
 */

const { Readable } = require('stream')
const ExcelJS = require('exceljs')
const { normalizePhone } = require('./phone')

// Trần số dòng mỗi lần nhập.
//
// Mỗi mật khẩu tốn ~50ms để băm bằng bcrypt, nên 500 dòng là ~25 giây. Đây là
// giới hạn của PROXY chứ không phải của máy chủ: request treo quá lâu sẽ bị
// nginx/Caddy cắt ngang giữa chừng (mặc định thường 60 giây) và admin không
// biết đã tạo được tới đâu. 500 dòng nằm gọn trong ngưỡng đó.
//
// Băm mật khẩu chạy bản BẤT ĐỒNG BỘ nên có nhả event loop — đo được khoảng chết
// dài nhất chỉ 51ms, đủ để WebSocket chấm phát âm không bị rớt.
const MAX_ROWS = 500

// Tên cột chấp nhận được. Khoá là dạng đã bỏ dấu, bỏ khoảng trắng, viết thường
// — người soạn file gõ "Họ tên", "HO TEN" hay "họ và tên" đều nhận ra.
const COLUMN_ALIASES = {
    name: ['hoten', 'hovaten', 'ten', 'hocvien', 'tenhocvien', 'name', 'fullname'],
    email: ['email', 'diachiemail', 'mail'],
    phone: ['sodienthoai', 'sdt', 'dienthoai', 'phone', 'mobile'],
}

// CỐ Ý KHÔNG CÓ CỘT "KHÓA HỌC".
//
// Popup "Thêm học viên" không hề có ô nhập khóa học — trường `course` trong
// model mới chỉ là chỗ để dành, chưa nối với module Khóa học. Cho cột đó vào
// file mẫu thì nhập hàng loạt lại đặt được thứ mà tạo lẻ không đặt được, người
// dùng nhìn vào không hiểu vì sao hai đường lại khác nhau.
//
// Khi trường này thành thật thì thêm vào cả hai chỗ cùng lúc.

// Bỏ dấu tiếng Việt + khoảng trắng để so tên cột.
function normalizeHeader(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/gi, 'd')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase()
}

// Đủ chặt để bắt lỗi gõ thật, đủ lỏng để không loại oan email hợp lệ hiếm gặp.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

function cellText(cell) {
    if (cell === null || cell === undefined) return ''
    // ExcelJS trả về object cho ô là công thức, hyperlink hoặc rich text.
    if (typeof cell === 'object') {
        if (cell.text !== undefined) return String(cell.text).trim()
        if (cell.result !== undefined) return String(cell.result).trim()
        if (cell.hyperlink !== undefined) return String(cell.hyperlink).trim()
        if (Array.isArray(cell.richText)) return cell.richText.map((r) => r.text).join('').trim()
        return ''
    }
    return String(cell).trim()
}

/**
 * Đọc file thành danh sách dòng thô.
 * Trả về { rows, headerRow } — rows là [{ rowNumber, name, phone, email }]
 */
async function parseStudentFile(buffer, filename) {
    const workbook = new ExcelJS.Workbook()
    const isCsv = /\.csv$/i.test(filename || '')

    if (isCsv) {
        await workbook.csv.read(Readable.from(buffer))
    } else {
        await workbook.xlsx.load(buffer)
    }

    const sheet = workbook.worksheets[0]
    if (!sheet || sheet.rowCount === 0) {
        throw new Error('File không có dữ liệu nào.')
    }

    // Tìm dòng tiêu đề: dòng đầu tiên nhận ra được cột Email. KHÔNG mặc định là
    // dòng 1 — file thật hay có dòng tiêu đề lớn, dòng ghi chú ở trên.
    let headerRow = 0
    let colIndex = {}
    const maxScan = Math.min(sheet.rowCount, 20)

    for (let r = 1; r <= maxScan; r++) {
        const map = {}
        sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
            const key = normalizeHeader(cellText(cell.value))
            for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
                if (aliases.includes(key) && map[field] === undefined) map[field] = col
            }
        })
        // Hàng tiêu đề = hàng đầu tiên nhận ra được cột Số điện thoại — đó là
        // định danh đăng nhập nên bắt buộc phải có.
        if (map.phone !== undefined) {
            headerRow = r
            colIndex = map
            break
        }
    }

    if (!headerRow) {
        throw new Error(
            'Không tìm thấy cột Số điện thoại trong file. Hãy tải file mẫu và điền theo đúng tên cột.'
        )
    }
    if (colIndex.name === undefined) {
        throw new Error('Không tìm thấy cột Họ tên trong file.')
    }

    const rows = []
    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r)
        const get = (field) =>
            colIndex[field] === undefined ? '' : cellText(row.getCell(colIndex[field]).value)

        const name = get('name')
        const email = get('email')
        const phone = get('phone')

        // Bỏ qua dòng trống hoàn toàn — file thật hay có vài dòng trống cuối bảng.
        if (!name && !email && !phone) continue

        rows.push({ rowNumber: r, name, email, phone })
    }

    return { rows, headerRow }
}

/**
 * Soát danh sách dòng.
 *
 * existing: { phones: Set, emails: Set } — đã có tài khoản (đã chuẩn hoá).
 *
 * Trả về { ready, problems, summary }
 *   ready    — các dòng tạo được, đã chuẩn hoá
 *   problems — [{ rowNumber, name, phone, email, reason }]
 *
 * SỐ ĐIỆN THOẠI LÀ ĐỊNH DANH: bắt buộc, phải hợp lệ, không trùng trong file,
 * không trùng tài khoản đã có. Email chỉ là thông tin thêm — có thì kiểm định
 * dạng và chống trùng, không có thì thôi.
 */
function validateRows(rows, existing) {
    const ready = []
    const problems = []
    const seenPhones = new Map() // phone chuẩn -> rowNumber đầu tiên
    const seenEmails = new Map()

    for (const row of rows) {
        const name = row.name.replace(/\s+/g, ' ').trim()
        const phone = normalizePhone(row.phone)
        const email = row.email.toLowerCase().trim()

        const fail = (reason) =>
            problems.push({ rowNumber: row.rowNumber, name, phone: phone || row.phone.trim(), email, reason })

        if (!name) {
            fail('Thiếu họ tên')
            continue
        }
        if (!row.phone.trim()) {
            fail('Thiếu số điện thoại')
            continue
        }
        if (!phone) {
            fail('Số điện thoại không hợp lệ')
            continue
        }
        if (seenPhones.has(phone)) {
            fail(`Số điện thoại trùng với dòng ${seenPhones.get(phone)} trong cùng file`)
            continue
        }
        if (existing.phones.has(phone)) {
            fail('Số điện thoại đã có tài khoản — bỏ qua, không ghi đè')
            continue
        }
        if (email) {
            if (!EMAIL_RE.test(email)) {
                fail('Email không hợp lệ')
                continue
            }
            if (seenEmails.has(email)) {
                fail(`Email trùng với dòng ${seenEmails.get(email)} trong cùng file`)
                continue
            }
            if (existing.emails.has(email)) {
                fail('Email đã được dùng bởi học viên khác')
                continue
            }
            seenEmails.set(email, row.rowNumber)
        }

        seenPhones.set(phone, row.rowNumber)
        ready.push({ rowNumber: row.rowNumber, name, phone, email })
    }

    return {
        ready,
        problems,
        summary: {
            total: rows.length,
            ready: ready.length,
            problems: problems.length,
        },
    }
}

// Số điện thoại đứng trước Email: nó là thứ học viên dùng để đăng nhập, còn
// email chỉ là thông tin thêm và có thể trống.
const RESULT_COLUMNS = [
    { header: 'Họ tên', key: 'name', width: 26 },
    { header: 'Số điện thoại', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Mật khẩu', key: 'password', width: 16 },
]

function styleHeader(sheet) {
    const header = sheet.getRow(1)
    header.font = { bold: true }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
    header.commit()
}

/**
 * File kết quả: danh sách đã tạo + cột mật khẩu, và một sheet riêng liệt kê các
 * dòng bị bỏ qua.
 *
 * Gộp cả hai vào MỘT file thay vì trả riêng: admin chỉ cần giữ một thứ, và lúc
 * đối chiếu "sao lớp có 120 em mà chỉ tạo được 118" thì lời giải nằm ngay cạnh.
 */
async function buildResultWorkbook(created, problems = []) {
    const workbook = new ExcelJS.Workbook()

    const sheet = workbook.addWorksheet('Tài khoản đã tạo')
    sheet.columns = RESULT_COLUMNS
    created.forEach((s) => sheet.addRow(s))
    styleHeader(sheet)
    // Ép cột mật khẩu và số điện thoại về dạng chữ: chuỗi toàn số như
    // "28461739" hay "0901234567" sẽ bị Excel hiểu thành số và cắt số 0 đầu.
    sheet.getColumn('password').numFmt = '@'
    sheet.getColumn('phone').numFmt = '@'

    if (problems.length > 0) {
        const skipped = workbook.addWorksheet('Dòng bị bỏ qua')
        skipped.columns = [
            { header: 'Dòng trong file', key: 'rowNumber', width: 16 },
            { header: 'Họ tên', key: 'name', width: 26 },
            { header: 'Số điện thoại', key: 'phone', width: 18 },
            { header: 'Email', key: 'email', width: 32 },
            { header: 'Lý do', key: 'reason', width: 44 },
        ]
        skipped.getColumn('phone').numFmt = '@'
        problems.forEach((p) => skipped.addRow(p))
        styleHeader(skipped)
    }

    return workbook.xlsx.writeBuffer()
}

/** File mẫu để khách điền. */
async function buildTemplateWorkbook() {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Danh sách học viên')
    sheet.columns = RESULT_COLUMNS.filter((c) => c.key !== 'password')
    // Dòng mẫu thứ hai cố ý KHÔNG có email, để người điền thấy rõ cột đó bỏ
    // trống được.
    sheet.addRow({ name: 'Nguyễn Văn An', phone: '0901234567', email: 'an.nguyen@example.com' })
    sheet.addRow({ name: 'Trần Thị Bình', phone: '0909876543', email: '' })
    styleHeader(sheet)
    sheet.getColumn('phone').numFmt = '@'
    return workbook.xlsx.writeBuffer()
}

module.exports = {
    parseStudentFile,
    validateRows,
    buildResultWorkbook,
    buildTemplateWorkbook,
    MAX_ROWS,
}
