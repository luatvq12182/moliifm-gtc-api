/**
 * Chuyển hệ thống sang ĐĂNG NHẬP BẰNG SỐ ĐIỆN THOẠI.
 *
 *   npm run migrate:phone-login            # chạy thử, in báo cáo, không ghi
 *   npm run migrate:phone-login -- --apply # ghi thật
 *
 * Việc phải làm trên dữ liệu ĐÃ CÓ trước khi model mới có hiệu lực:
 *
 *  1. Chuẩn hoá số điện thoại về "0xxxxxxxxx". Dữ liệu cũ nhập tay nên đủ
 *     kiểu: có dấu cách, dấu chấm, +84...
 *
 *  2. Đổi email "" thành KHÔNG CÓ trường. Chỉ mục sparse chỉ bỏ qua bản ghi
 *     vắng trường, không bỏ qua chuỗi rỗng — để "" thì học viên thứ hai không
 *     email là nổ duplicate key.
 *
 *  3. Thay chỉ mục email: bản cũ unique thường -> unique + sparse.
 *
 *  4. Gỡ trường phone rỗng (cùng lý do với email ở bước 2), rồi tạo chỉ mục
 *     unique + sparse cho phone. sparse để học viên cũ chưa có số không làm
 *     hỏng ràng buộc — họ vẫn tồn tại, chỉ chưa đăng nhập được.
 *
 * HAI THỨ SCRIPT KHÔNG TỰ QUYẾT ĐƯỢC, chỉ liệt kê ra cho người xử:
 *
 *  - Học viên KHÔNG CÓ số: tài khoản vẫn còn nhưng không đăng nhập được cho
 *    tới khi admin điền số. Không thể bịa số cho họ.
 *
 *  - Hai học viên CÙNG số: MongoDB sẽ từ chối tạo chỉ mục unique. Script không
 *    biết giữ ai bỏ ai — phải người quyết. Chừng nào còn trùng, bước 4 bị
 *    bỏ qua và script báo rõ.
 */

require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const Student = require('../models/Student')
const { normalizePhone } = require('../lib/phone')

const APPLY = process.argv.includes('--apply')

/** Phân loại toàn bộ học viên. Thuần, không đụng DB — để thử được. */
function analyze(students) {
    const byPhone = new Map()
    const report = {
        total: students.length,
        noPhone: [],
        invalidPhone: [],
        toNormalize: [], // { _id, from, to }
        emptyEmail: [],
        duplicates: [], // { phone, students: [{_id, name, email}] }
    }

    for (const s of students) {
        const raw = s.phone || ''
        const normalized = normalizePhone(raw)

        if (!raw.trim()) {
            report.noPhone.push({ _id: s._id, name: s.name, email: s.email || '' })
        } else if (!normalized) {
            report.invalidPhone.push({ _id: s._id, name: s.name, phone: raw })
        } else {
            if (normalized !== raw) report.toNormalize.push({ _id: s._id, from: raw, to: normalized })
            if (!byPhone.has(normalized)) byPhone.set(normalized, [])
            byPhone.get(normalized).push({ _id: s._id, name: s.name, email: s.email || '' })
        }

        if (typeof s.email === 'string' && s.email.trim() === '') {
            report.emptyEmail.push({ _id: s._id })
        }
    }

    for (const [phone, list] of byPhone) {
        if (list.length > 1) report.duplicates.push({ phone, students: list })
    }

    return report
}

function printReport(r) {
    const line = '─'.repeat(78)
    console.log('\n' + line)
    console.log(APPLY ? '  GHI THẬT' : '  CHẠY THỬ — chưa ghi gì. Thêm --apply để ghi.')
    console.log(line + '\n')
    console.log(`Tổng ${r.total} học viên.\n`)

    console.log(`Chuẩn hoá số điện thoại: ${r.toNormalize.length}`)
    r.toNormalize.slice(0, 8).forEach((x) => console.log(`   "${x.from}"  ->  ${x.to}`))
    if (r.toNormalize.length > 8) console.log(`   ... và ${r.toNormalize.length - 8} nữa`)

    console.log(`\nEmail rỗng cần gỡ trường: ${r.emptyEmail.length}`)

    console.log(`\nKHÔNG CÓ SỐ ĐIỆN THOẠI: ${r.noPhone.length}` + (r.noPhone.length ? '  <- không đăng nhập được cho tới khi admin điền số' : ''))
    r.noPhone.slice(0, 15).forEach((x) => console.log(`   ${x.name}  ${x.email || '(không email)'}`))
    if (r.noPhone.length > 15) console.log(`   ... và ${r.noPhone.length - 15} nữa`)

    console.log(`\nSỐ KHÔNG HỢP LỆ: ${r.invalidPhone.length}` + (r.invalidPhone.length ? '  <- cần sửa tay' : ''))
    r.invalidPhone.forEach((x) => console.log(`   ${x.name}  "${x.phone}"`))

    console.log(`\nTRÙNG SỐ: ${r.duplicates.length} số` + (r.duplicates.length ? '  <- PHẢI XỬ TRƯỚC, nếu không không tạo được ràng buộc duy nhất' : ''))
    r.duplicates.forEach((d) => {
        console.log(`   ${d.phone}:`)
        d.students.forEach((s) => console.log(`      - ${s.name}  ${s.email || '(không email)'}  id=${s._id}`))
    })
    console.log()
}

async function main() {
    await connectDB()
    const students = await Student.find({}).select('name phone email').lean()
    const report = analyze(students)
    printReport(report)

    if (!APPLY) {
        await mongoose.connection.close()
        return
    }

    const col = Student.collection

    // 1 + 2: sửa từng bản ghi. Dùng updateOne thẳng vào collection để không
    // kích hoạt validator của model mới (nó sẽ chặn bản ghi chưa có số).
    let n = 0
    for (const x of report.toNormalize) {
        await col.updateOne({ _id: x._id }, { $set: { phone: x.to } })
        n++
    }
    console.log(`Đã chuẩn hoá ${n} số điện thoại.`)

    if (report.emptyEmail.length) {
        const r = await col.updateMany({ email: '' }, { $unset: { email: '' } })
        console.log(`Đã gỡ trường email rỗng ở ${r.modifiedCount} học viên.`)
    }

    // 3: thay chỉ mục email. Mongoose KHÔNG tự xoá chỉ mục cũ khi schema đổi —
    // bản unique-không-sparse cũ còn nằm đó thì sparse mới vô nghĩa.
    const indexes = await col.indexes()
    const oldEmail = indexes.find((i) => i.key && i.key.email === 1 && !i.sparse)
    if (oldEmail) {
        await col.dropIndex(oldEmail.name)
        console.log(`Đã xoá chỉ mục email cũ (${oldEmail.name}).`)
    }
    await col.createIndex({ email: 1 }, { unique: true, sparse: true })
    console.log('Đã tạo chỉ mục email unique + sparse.')

    // 4: chỉ mục phone.
    //
    // Gỡ trường phone rỗng trước — sparse chỉ bỏ qua bản ghi VẮNG trường, còn
    // "" thì nó vẫn đếm, và N bản ghi cùng "" là N bản trùng nhau.
    if (report.noPhone.length) {
        const r = await col.updateMany(
            { $or: [{ phone: '' }, { phone: null }, { phone: /^\s*$/ }] },
            { $unset: { phone: '' } }
        )
        console.log(`Đã gỡ trường phone rỗng ở ${r.modifiedCount} học viên.`)
    }

    // Còn trùng số thật thì không thể — báo rõ thay vì để MongoDB ném lỗi khó hiểu.
    if (report.duplicates.length > 0) {
        console.log(`\nCHƯA TẠO được ràng buộc duy nhất cho số điện thoại: còn ${report.duplicates.length} số trùng.`)
        console.log('Xử xong các trường hợp trùng ở trên rồi chạy lại --apply.\n')
    } else {
        // Mongoose có thể đã tự tạo phone_1 KHÔNG sparse lúc server khởi động
        // (và thất bại nếu có bản ghi không số, nhưng cũng có thể thành công).
        // Xoá bản đó nếu có, để tạo lại đúng dạng.
        const oldPhone = (await col.indexes()).find((i) => i.key && i.key.phone === 1 && !i.sparse)
        if (oldPhone) {
            await col.dropIndex(oldPhone.name)
            console.log(`Đã xoá chỉ mục phone cũ không sparse (${oldPhone.name}).`)
        }
        await col.createIndex({ phone: 1 }, { unique: true, sparse: true })
        console.log('Đã tạo chỉ mục phone unique + sparse.')
    }

    if (report.noPhone.length > 0) {
        console.log(`\nLƯU Ý: ${report.noPhone.length} học viên không có số điện thoại — họ chưa đăng nhập được. Điền số trong trang quản trị.`)
    }
    console.log()
    await mongoose.connection.close()
}

if (require.main === module) {
    main().catch((err) => {
        console.error('\nLỖI:', err.message, '\n')
        process.exit(1)
    })
}

module.exports = { analyze }
