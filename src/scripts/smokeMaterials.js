/**
 * KIỂM TRA TÍCH HỢP cho "Học liệu khoá học".
 *
 *   npm run smoke:materials
 *   SMOKE_PPTX=/đường/dẫn/file.pptx npm run smoke:materials   (thử cả PowerPoint)
 *   SMOKE_GOOGLE=1 npm run smoke:materials                    (thử cả Google thật, cần mạng)
 *
 * Phần Google mặc định chạy với một máy chủ GIẢ ngay trong script (đóng vai
 * Google Slides và Google Drive), nên không cần mạng.
 *
 * Cần LibreOffice + poppler-utils trên máy (giống Dockerfile). Tự dựng khoá,
 * học viên, file PDF mẫu; tự dọn sạch ở cuối, kể cả khi có bước thất bại.
 * Cần có sẵn một tài khoản admin (npm run seed:admin).
 */
require('dotenv').config()
const fs = require('fs')
const http = require('http')
const path = require('path')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const app = require('../app')
const connectDB = require('../config/db')
const Admin = require('../models/Admin')
const Student = require('../models/Student')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialDeck = require('../models/MaterialDeck')
const { deckDir } = require('../lib/materialConvert')

const SLUG = 'smoke-mat-'
const PHONES = { yes: '0900000061', no: '0900000062' }
const DEVICE = { deviceId: 'smoke-mat-device', deviceType: 'desktop' }

let server
let base
let pass = 0
let fail = 0

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    ok ? pass++ : fail++
    console.log(`  ${ok ? '✓' : '✗ LỆCH'}  ${label}`)
    if (!ok) console.log(`           nhận: ${JSON.stringify(actual)}\n           mong: ${JSON.stringify(expected)}`)
}

/** PDF tối giản N trang, mỗi trang một dòng chữ — đủ để thử đường chuyển đổi PDF. */
function makePdf(n) {
    const objs = []
    const kids = []
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    for (let i = 0; i < n; i++) {
        const pageNo = 4 + i * 2
        const stream = `BT /F1 48 Tf 100 300 Td (Slide ${i + 1}) Tj ET`
        objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R >>`
        objs[pageNo + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
        kids.push(`${pageNo} 0 R`)
    }
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
    let out = '%PDF-1.4\n'
    const offsets = []
    for (let i = 1; i < objs.length; i++) {
        offsets[i] = Buffer.byteLength(out)
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`
    }
    const xref = Buffer.byteLength(out)
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
    for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(out)
}

async function api(method, p, { body, token, form } = {}) {
    const res = await fetch(base + '/api' + p, {
        method,
        headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: form || (body ? JSON.stringify(body) : undefined),
    })
    const type = res.headers.get('content-type') || ''
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
    return { status: res.status, body: data, headers: res.headers }
}

function upload(p, token, { buffer, name, fields = {} }) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append('file', new Blob([buffer]), name)
    return api('POST', p, { token, form })
}

async function waitReady(id, token, timeoutMs = 120000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const r = await api('GET', `/admin/materials/decks/${id}`, { token })
        if (r.body.conversion !== 'processing') return r.body
        await new Promise((ok) => setTimeout(ok, 500))
    }
    throw new Error('Chuyển đổi quá lâu')
}

async function cleanup() {
    const courses = await MaterialCourse.find({ slug: new RegExp('^' + SLUG) }).select('_id')
    const ids = courses.map((c) => c._id)
    const decks = await MaterialDeck.find({ courseId: { $in: ids } }).select('_id')
    for (const d of decks) await fs.promises.rm(deckDir(d._id), { recursive: true, force: true })
    await MaterialDeck.deleteMany({ courseId: { $in: ids } })
    await MaterialCourse.deleteMany({ _id: { $in: ids } })
    await Student.deleteMany({ phone: { $in: Object.values(PHONES) } })
}

async function main() {
    await connectDB()
    server = http.createServer(app)
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
    await cleanup()

    const admin = await Admin.findOne()
    if (!admin) throw new Error('Chưa có tài khoản admin nào trong DB — chạy `npm run seed:admin` trước.')
    const A = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' })

    // ---------- KHOÁ ----------
    console.log('\nKHOÁ HỌC LIỆU')
    let r = await api('POST', '/admin/materials/courses', { token: A, body: { name: 'Smoke HSK 3', slug: 'Sai Slug!' } })
    check('slug sai định dạng -> 400', r.status, 400)
    r = await api('POST', '/admin/materials/courses', { token: A, body: { name: 'Smoke HSK 3', slug: SLUG + 'hsk3', status: 'published' } })
    check('tạo khoá -> 201', r.status, 201)
    const course = r.body
    r = await api('POST', '/admin/materials/courses', { token: A, body: { name: 'Trùng', slug: SLUG + 'hsk3' } })
    check('trùng slug -> 409', r.status, 409)

    const yes = await Student.create({ name: 'Smoke Có Quyền', phone: PHONES.yes, password: PHONES.yes })
    await Student.create({ name: 'Smoke Không Quyền', phone: PHONES.no, password: PHONES.no })

    // ---------- TẢI SLIDE ----------
    console.log('\nTẢI SLIDE (PDF)')
    r = await upload('/admin/materials/decks', A, { buffer: Buffer.from('xin chao'), name: 'ghi-chu.txt', fields: { courseId: course._id } })
    check('file .txt -> 400', r.status, 400)
    r = await upload('/admin/materials/decks', A, { buffer: makePdf(3), name: 'Bài 1 - Chào hỏi.pdf', fields: { courseId: course._id } })
    check('tải PDF -> 201, đang chuyển', [r.status, r.body.conversion], [201, 'processing'])
    check('tên mặc định lấy theo tên file', r.body.title, 'Bài 1 - Chào hỏi')
    let deck = await waitReady(r.body._id, A)
    check('chuyển xong, đủ 3 trang', [deck.conversion, deck.pageCount], ['ready', 3])
    check('có kích thước trang (16:9)', deck.pages[0].width > 0 && Math.abs(deck.pages[0].width / deck.pages[0].height - 16 / 9) < 0.02, true)
    const originalOnDisk = fs.readdirSync(deckDir(deck._id))
    check('file gốc + thư mục ảnh nằm trong storage/', originalOnDisk.sort(), ['source-v1.pdf', 'v1'])

    r = await api('GET', `/admin/materials/decks/${deck._id}/pages/1`, { token: A })
    check('admin xem trước trang 1 -> ảnh JPEG', [r.status, r.headers.get('content-type')], [200, 'image/jpeg'])

    // ---------- HỌC VIÊN ----------
    console.log('\nHỌC VIÊN')
    const login = async (phone) => (await api('POST', '/auth/student/login', { body: { phone, password: phone, ...DEVICE } })).body.token
    const tYes = await login(PHONES.yes)
    const tNo = await login(PHONES.no)

    r = await api('GET', '/materials/courses', { token: tYes })
    check('chưa cấp quyền: KHÔNG thấy khoá (ẩn hẳn)', r.body.filter((c) => c.slug === SLUG + 'hsk3').length, 0)

    r = await api('PATCH', '/admin/materials/access', { token: A, body: { studentIds: [String(yes._id)], courseId: course._id, action: 'grant' } })
    check('cấp quyền -> đổi 1 người', r.body.changed, 1)
    r = await api('PATCH', '/admin/materials/access', { token: A, body: { studentIds: [String(yes._id)], courseId: course._id, action: 'grant' } })
    check('cấp lại lần nữa -> đổi 0 người (không đếm khống)', r.body.changed, 0)
    r = await api('GET', `/admin/materials/access?courseId=${course._id}&scope=has&search=Smoke`, { token: A })
    check('lọc "đã có quyền" ra đúng người', r.body.data.map((s) => s.phone), [PHONES.yes])
    check('mỗi người kèm danh sách khoá được xem', r.body.data[0].access.includes(String(course._id)), true)
    r = await api('GET', `/admin/materials/access?courseId=${course._id}&scope=missing&search=Smoke`, { token: A })
    check('lọc "chưa được xem" không ra người đã có quyền', r.body.data.some((s) => s.phone === PHONES.yes), false)
    r = await api('GET', '/admin/materials/access?search=Smoke', { token: A })
    check('không chọn khoá -> ra mọi học viên khớp tìm kiếm', [r.status, r.body.data.some((s) => s.phone === PHONES.yes)], [200, true])

    r = await api('GET', '/materials/courses', { token: tYes })
    const mine = r.body.find((c) => c.slug === SLUG + 'hsk3')
    check('có quyền: thấy khoá', Boolean(mine), true)
    check('bộ slide còn NHÁP thì chưa được đếm', mine && mine.deckCount, 0)
    r = await api('GET', `/materials/decks/${deck._id}`, { token: tYes })
    check('bộ slide nháp -> học viên không mở được (404)', r.status, 404)

    await api('PUT', `/admin/materials/decks/${deck._id}`, { token: A, body: { status: 'published' } })
    r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
    check('xuất bản xong: thấy 1 bộ slide, 3 trang', r.body.decks && r.body.decks.map((d) => d.pageCount), [3])
    r = await api('GET', `/materials/decks/${deck._id}`, { token: tYes })
    check('thông tin bộ slide: 3 trang, không lộ tên file gốc', [r.body.pages.length, r.body.source], [3, undefined])
    r = await api('GET', `/materials/decks/${deck._id}/pages/2`, { token: tYes })
    check('xem trang 2 -> ảnh', [r.status, r.headers.get('content-type')], [200, 'image/jpeg'])
    check('cấm lưu bộ nhớ đệm', r.headers.get('cache-control'), 'private, no-store')
    const full = r.body.length
    r = await api('GET', `/materials/decks/${deck._id}/pages/2?thumb=1`, { token: tYes })
    check('ảnh thu nhỏ: JPEG, nhỏ hơn hẳn ảnh lớn', [r.status, r.headers.get('content-type'), r.body.length * 2 < full], [200, 'image/jpeg', true])
    // Bộ slide chuyển trước khi có ảnh thu nhỏ -> vẫn trả ảnh (lớn) thay thế.
    await MaterialDeck.updateOne({ _id: deck._id }, { $set: { 'pages.1.thumb': '' } })
    r = await api('GET', `/materials/decks/${deck._id}/pages/2?thumb=1`, { token: tYes })
    check('chưa có ảnh thu nhỏ -> dùng ảnh lớn thay', [r.status, r.body.length], [200, full])
    r = await api('GET', `/materials/decks/${deck._id}/pages/9`, { token: tYes })
    check('trang không tồn tại -> 404', r.status, 404)
    r = await api('GET', `/materials/decks/${deck._id}/pages/..%2F..%2Fsource-v1.pdf`, { token: tYes })
    check('đường dẫn lạ -> không lộ file gốc', r.status, 404)

    console.log('\nCHẶN NGƯỜI KHÔNG CÓ QUYỀN')
    r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tNo })
    check('vào khoá -> 403, mã riêng', [r.status, r.body.code], [403, 'MATERIAL_NO_ACCESS'])
    r = await api('GET', `/materials/decks/${deck._id}/pages/1`, { token: tNo })
    check('lấy thẳng ảnh trang -> 403', r.status, 403)
    r = await api('GET', `/materials/decks/${deck._id}/pages/1`)
    check('không đăng nhập -> 401', r.status, 401)

    // ---------- POWERPOINT (tuỳ chọn) ----------
    if (process.env.SMOKE_PPTX) {
        console.log('\nTẢI SLIDE (POWERPOINT)')
        r = await upload('/admin/materials/decks', A, {
            buffer: fs.readFileSync(process.env.SMOKE_PPTX),
            name: path.basename(process.env.SMOKE_PPTX),
            fields: { courseId: course._id, status: 'published' },
        })
        const pp = await waitReady(r.body._id, A)
        check('PowerPoint chuyển xong', [pp.conversion, pp.conversionError], ['ready', ''])
        console.log(`           (${pp.pageCount} trang)`)
    }

    // ---------- GOOGLE SLIDES / DRIVE ----------
    console.log('\nTHÊM BẰNG LINK GOOGLE (máy chủ Google giả)')
    let fakePages = 3
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    const fake = http.createServer((q, s) => {
        const u = new URL(q.url, 'http://x')
        const disp = (name) => `attachment; filename="x"; filename*=UTF-8''${encodeURIComponent(name)}`
        if (u.pathname === '/SLIDESOKSLIDESOKSLIDESOK/export/pdf') {
            s.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': disp('Bài trình bày mẫu.pdf') })
            return s.end(makePdf(fakePages))
        }
        const id = u.searchParams.get('id')
        if (u.pathname === '/folder' && id === 'FOLDEROKFOLDEROKFOLDEROK') {
            // Trang xem thư mục dạng nhúng của Drive: xếp theo chữ cái (Bài 10 trước Bài 2).
            const entry = (fid, href, name) =>
                `<div class="flip-entry" id="entry-${fid}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank"><div class="flip-entry-title">${name}</div></a></div></div>`
            s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            return s.end(
                '<html><div class="flip-entries">' +
                entry('FOLDPDF10', 'https://drive.google.com/file/d/FOLDPDF10/view?usp=drive_web', 'Bài 10 ok.pdf') +
                entry('FOLDPDF02', 'https://drive.google.com/file/d/FOLDPDF02/view?usp=drive_web', 'Bài 2 ok.pdf') +
                entry('FOLDDOCX', 'https://drive.google.com/file/d/FOLDDOCX/view?usp=drive_web', 'Ghi chú.docx') +
                entry('FOLDSUB', 'https://drive.google.com/drive/folders/FOLDSUB', 'Bản cũ') +
                entry('SLIDESOKSLIDESOKSLIDESOK', 'https://docs.google.com/presentation/d/SLIDESOKSLIDESOKSLIDESOK/edit?usp=drive_web', 'Bài 1 &amp; mở đầu') +
                '</div></html>'
            )
        }
        if (u.pathname === '/folder' && id === 'FOLDEREMPTYFOLDEREMPTY') {
            s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            return s.end('<html><div class="flip-entries"></div></html>')
        }
        if (u.pathname === '/download' && /^FOLDPDF/.test(id)) {
            s.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disp(`${id}.pdf`) })
            return s.end(makePdf(2))
        }
        if (u.pathname === '/download' && id === 'DRIVEPDFDRIVEPDFDRIVEPDF') {
            // Drive trả kiểu chung, không nói là PDF.
            s.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disp('Bài 14 ok.pdf') })
            return s.end(makePdf(fakePages))
        }
        if (u.pathname === '/download' && id === 'DRIVEDOCXDRIVEDOCXDRIVEDOCX') {
            s.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disp('Ghi chú.docx') })
            return s.end(zip)
        }
        if (u.pathname === '/download' && id === 'DRIVEBIGDRIVEBIGDRIVEBIG') {
            s.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(200 * 1024 * 1024) })
            return s.end()
        }
        // File riêng tư: Google trả trang HTML (đăng nhập), không trả file.
        s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        s.end('<html>Đăng nhập</html>')
    })
    await new Promise((ok) => fake.listen(0, '127.0.0.1', ok))
    const fakeBase = `http://127.0.0.1:${fake.address().port}`
    process.env.GOOGLE_SLIDES_EXPORT_BASE = fakeBase
    process.env.GOOGLE_DRIVE_DOWNLOAD_BASE = fakeBase + '/download'
    process.env.GOOGLE_DRIVE_FOLDER_BASE = fakeBase + '/folder'
    const SLIDES = 'https://docs.google.com/presentation/d/SLIDESOKSLIDESOKSLIDESOK/edit?usp=sharing'
    const DRIVE_PDF = 'https://drive.google.com/file/d/DRIVEPDFDRIVEPDFDRIVEPDF/view?usp=sharing'
    const DRIVE_DOCX = 'https://drive.google.com/file/d/DRIVEDOCXDRIVEDOCXDRIVEDOCX/view'
    const added = []
    try {
        const countDecks = () => MaterialDeck.countDocuments({ courseId: course._id })
        const before = await countDecks()
        r = await api('POST', '/admin/materials/decks/google', {
            token: A,
            body: { courseId: course._id, urls: `${DRIVE_PDF}\nhttps://example.com/bai-2.pdf` },
        })
        check('có link lạ -> 400, chỉ đúng dòng', [r.status, /dòng 2/.test(r.body.message)], [400, true])
        check('...và KHÔNG thêm bộ nào (kể cả dòng đúng)', await countDecks(), before)

        r = await api('POST', '/admin/materials/decks/google', {
            token: A,
            body: { courseId: course._id, urls: `${DRIVE_PDF}\nhttps://drive.google.com/drive/folders/PRIVATEFOLDERPRIVATEFOLDER?usp=sharing` },
        })
        check('thư mục chưa chia sẻ -> 400 kèm hướng dẫn, đúng dòng', [r.status, /Dòng 2/.test(r.body.message), /Bất kỳ ai có đường liên kết/.test(r.body.message)], [400, true, true])
        check('...và KHÔNG thêm bộ nào', await countDecks(), before)
        r = await api('POST', '/admin/materials/decks/google', { token: A, body: { courseId: course._id, url: 'https://drive.google.com/drive/folders/FOLDEREMPTYFOLDEREMPTY' } })
        check('thư mục không có slide -> 400', [r.status, /không có file/.test(r.body.message)], [400, true])

        r = await api('POST', '/admin/materials/decks/google', {
            token: A,
            body: { courseId: course._id, url: 'https://drive.google.com/drive/u/1/folders/FOLDEROKFOLDEROKFOLDEROK?usp=sharing', title: 'Bỏ qua tên này' },
        })
        check('dán link THƯ MỤC -> mỗi file slide một bộ, sắp theo số bài, tên có ngay',
            [r.status, r.body.decks && r.body.decks.map((d) => d.title)],
            [201, ['Bài 1 & mở đầu', 'Bài 2 ok', 'Bài 10 ok']])
        check('...báo file bị bỏ qua (docx, thư mục con)', r.body.skipped, ['Ghi chú.docx', 'Bản cũ (thư mục con)'])
        const fromFolder = await Promise.all(r.body.decks.map((d) => waitReady(d._id, A)))
        added.push(...fromFolder)
        check('...lấy xong cả 3, giữ tên theo thư mục',
            fromFolder.map((d) => [d.conversion, d.title, d.source.googleType]),
            [['ready', 'Bài 1 & mở đầu', 'slides'], ['ready', 'Bài 2 ok', 'drive'], ['ready', 'Bài 10 ok', 'drive']])

        r = await api('POST', '/admin/materials/decks/google', {
            token: A,
            body: { courseId: course._id, urls: `${SLIDES}\n\n${DRIVE_PDF}\n${DRIVE_DOCX}`, status: 'published' },
        })
        check('dán 3 link (bỏ dòng trống) -> thêm 3 bộ, đúng thứ tự', [r.status, r.body.decks.map((d) => d.source.googleType)], [201, ['slides', 'drive', 'drive']])
        const [d1, d2, d3] = await Promise.all(r.body.decks.map((d) => waitReady(d._id, A)))
        added.push(d1, d2, d3)
        check('Google Slides: lấy xong, tên theo tên bài', [d1.conversion, d1.pageCount, d1.title], ['ready', 3, 'Bài trình bày mẫu'])
        check('PDF trên Drive: nhận ra PDF dù Drive không nói, tên tiếng Việt đúng', [d2.conversion, d2.pageCount, d2.title, d2.source.ext], ['ready', 3, 'Bài 14 ok', 'pdf'])
        check('file .docx trên Drive -> lỗi rõ ràng', [d3.conversion, /không phải PDF hay PowerPoint/.test(d3.conversionError)], ['failed', true])
        check('admin thấy lại link đã dán', d2.source.googleUrl, DRIVE_PDF)
        r = await api('GET', `/materials/decks/${d2._id}`, { token: tYes })
        check('học viên KHÔNG thấy link Google', JSON.stringify(r.body).includes('DRIVEPDF'), false)
        r = await api('GET', `/materials/decks/${d2._id}/pages/3`, { token: tYes })
        check('học viên xem được trang 3', [r.status, r.headers.get('content-type')], [200, 'image/jpeg'])

        r = await api('POST', '/admin/materials/decks/google', { token: A, body: { courseId: course._id, url: SLIDES, title: 'Tên tôi đặt' } })
        const named = await waitReady(r.body.decks[0]._id, A)
        added.push(named)
        check('một link + tự đặt tên -> giữ tên đã đặt', named.title, 'Tên tôi đặt')

        fakePages = 2 // giảng viên vừa thay file trên Drive
        r = await api('POST', `/admin/materials/decks/${d2._id}/sync`, { token: A, body: {} })
        check('cập nhật từ Drive -> version 2', [r.status, r.body.version], [200, 2])
        const d2b = await waitReady(d2._id, A)
        check('bản mới: 2 trang, vẫn là nguồn Drive', [d2b.conversion, d2b.pageCount, d2b.source.googleType], ['ready', 2, 'drive'])

        r = await api('POST', '/admin/materials/decks/google', { token: A, body: { courseId: course._id, url: 'https://drive.google.com/file/d/DRIVEBIGDRIVEBIGDRIVEBIG/view' } })
        const big = await waitReady(r.body.decks[0]._id, A)
        added.push(big)
        check('file trên 150MB -> dừng ngay, báo quá lớn', [big.conversion, /quá lớn/.test(big.conversionError)], ['failed', true])

        r = await api('POST', '/admin/materials/decks/google', { token: A, body: { courseId: course._id, url: 'https://docs.google.com/presentation/d/PRIVATEPRIVATEPRIVATE1/edit' } })
        const p = await waitReady(r.body.decks[0]._id, A)
        added.push(p)
        check('file chưa chia sẻ -> lỗi kèm hướng dẫn mở quyền', [p.conversion, /Bất kỳ ai có đường liên kết/.test(p.conversionError)], ['failed', true])
    } finally {
        delete process.env.GOOGLE_SLIDES_EXPORT_BASE
        delete process.env.GOOGLE_DRIVE_DOWNLOAD_BASE
        fake.close()
        for (const d of added) await api('DELETE', `/admin/materials/decks/${d._id}`, { token: A })
    }

    if (process.env.SMOKE_GOOGLE) {
        console.log('\nGOOGLE THẬT (cần mạng)')
        r = await api('POST', '/admin/materials/decks/google', {
            token: A,
            body: {
                courseId: course._id,
                urls: [
                    // Bài mẫu công khai của Google.
                    'https://docs.google.com/presentation/d/1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc/edit',
                    // File công khai trên Drive (ví dụ trong tài liệu gdown) — là file chữ, không phải slide.
                    'https://drive.google.com/file/d/0B9P1L--7Wd2vU3VUVlFnbTgtS2c/view?usp=sharing',
                ],
            },
        })
        const [real, realDrive] = await Promise.all(r.body.decks.map((d) => waitReady(d._id, A)))
        check('Google Slides thật: lấy được', [real.conversion, real.conversionError], ['ready', ''])
        console.log(`           (${real.pageCount} trang, tên "${real.title}")`)
        check('file chữ thật trên Drive -> lỗi "không phải PDF hay PowerPoint"', [realDrive.conversion, /không phải PDF hay PowerPoint/.test(realDrive.conversionError)], ['failed', true])
        await api('DELETE', `/admin/materials/decks/${real._id}`, { token: A })
        await api('DELETE', `/admin/materials/decks/${realDrive._id}`, { token: A })
    }

    // ---------- THAY FILE ----------
    console.log('\nTHAY FILE')
    r = await upload(`/admin/materials/decks/${deck._id}/file`, A, { buffer: makePdf(2), name: 'Bài 1 (sửa).pdf' })
    check('thay file -> version 2, gỡ ảnh cũ ngay', [r.body.version, r.body.pageCount], [2, 0])
    r = await api('GET', `/materials/decks/${deck._id}/pages/1`, { token: tYes })
    check('đang chuyển: học viên chưa xem được (không lẫn trang cũ)', r.status, 404)
    deck = await waitReady(deck._id, A)
    check('bản mới: 2 trang', [deck.conversion, deck.pageCount], ['ready', 2])
    check('file của version cũ đã dọn', fs.readdirSync(deckDir(deck._id)).sort(), ['source-v2.pdf', 'v2'])

    // ---------- LỖI CHUYỂN ĐỔI ----------
    console.log('\nFILE HỎNG')
    r = await upload('/admin/materials/decks', A, { buffer: Buffer.from('không phải pdf'), name: 'hong.pdf', fields: { courseId: course._id } })
    const bad = await waitReady(r.body._id, A)
    check('file hỏng -> failed kèm lý do', [bad.conversion, Boolean(bad.conversionError)], ['failed', true])

    // ---------- XOÁ ----------
    console.log('\nXOÁ')
    r = await api('DELETE', `/admin/materials/decks/${bad._id}`, { token: A })
    check('xoá bộ slide -> xoá cả thư mục', [r.status, fs.existsSync(deckDir(bad._id))], [200, false])
    r = await api('DELETE', `/admin/materials/courses/${course._id}`, { token: A })
    check('xoá khoá còn nội dung -> 409 hỏi lại', [r.status, r.body.code], [409, 'MATERIAL_COURSE_IN_USE'])
    r = await api('DELETE', `/admin/materials/courses/${course._id}?force=1`, { token: A })
    check('xoá hẳn -> gỡ luôn quyền của học viên', [r.status, (await Student.findById(yes._id)).materialAccess.length], [200, 0])
    check('...và file của mọi bộ slide', fs.existsSync(deckDir(deck._id)), false)

    console.log('\nQUYỀN')
    r = await api('GET', '/admin/materials/courses', { token: tYes })
    check('token học viên vào API admin -> 401', r.status, 401)
}

main()
    .then(async () => {
        await cleanup()
        console.log(`\n${pass} đúng, ${fail} lệch\n`)
    })
    .catch(async (err) => {
        fail++
        console.error('\nLỖI:', err.stack || err.message)
        try { await cleanup() } catch (e) { console.error('Dọn không xong:', e.message) }
    })
    .finally(async () => {
        if (server) server.close()
        await mongoose.disconnect()
        process.exit(fail > 0 ? 1 : 0)
    })
