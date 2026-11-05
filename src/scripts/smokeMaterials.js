/**
 * KIỂM TRA TÍCH HỢP cho "Học liệu khoá học".
 *
 *   npm run smoke:materials
 *   SMOKE_PPTX=/đường/dẫn/file.pptx npm run smoke:materials   (thử cả PowerPoint)
 *   SMOKE_GOOGLE=1 npm run smoke:materials                    (thử cả Google thật, cần mạng)
 *
 * Phần Google và YouTube mặc định chạy với máy chủ GIẢ ngay trong script (đóng
 * vai Google Slides, Google Drive, YouTube), nên không cần mạng.
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
const MaterialVideo = require('../models/MaterialVideo')
const MaterialVideoProgress = require('../models/MaterialVideoProgress')
const MaterialExercise = require('../models/MaterialExercise')
const MaterialExerciseAttempt = require('../models/MaterialExerciseAttempt')
const AppSetting = require('../models/AppSetting')
const { deckDir, MATERIALS_DIR } = require('../lib/materialConvert')

const videoThumb = (id) => path.join(MATERIALS_DIR, 'videos', `${id}.jpg`)

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
    const videos = await MaterialVideo.find({ courseId: { $in: ids } }).select('_id')
    for (const v of videos) await fs.promises.rm(videoThumb(v._id), { force: true })
    await MaterialVideoProgress.deleteMany({ courseId: { $in: ids } })
    await MaterialExercise.deleteMany({ courseId: { $in: ids } })
    await MaterialExerciseAttempt.deleteMany({ courseId: { $in: ids } })
    await MaterialVideo.deleteMany({ courseId: { $in: ids } })
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

    // ---------- VIDEO BÀI GIẢNG ----------
    console.log('\nVIDEO BÀI GIẢNG (YouTube giả)')
    const yt = http.createServer((q, s) => {
        const u = new URL(q.url, 'http://x')
        const vid = (u.searchParams.get('url') || '').split('v=')[1] || u.searchParams.get('v')
        const known = { VIDEOOK0001: 'Bài 1 — Chào hỏi (video)', VIDEONODUR1: 'Bài 2 — Số đếm', VIDEONEW001: 'Bài 1 — bản sửa' }
        if (u.pathname === '/oembed') {
            if (!known[vid]) { s.writeHead(404); return s.end('Not Found') }
            s.writeHead(200, { 'Content-Type': 'application/json' })
            return s.end(JSON.stringify({ title: known[vid], type: 'video' }))
        }
        if (u.pathname === '/watch') {
            s.writeHead(200, { 'Content-Type': 'text/html' })
            return s.end(vid === 'VIDEONODUR1' ? '<html>đổi giao diện</html>' : '<html>..."lengthSeconds":"3600",...</html>')
        }
        // Ảnh bìa: chỉ có cỡ hqdefault (giống nhiều video thật không có maxres).
        if (/\/hqdefault\.jpg$/.test(u.pathname)) {
            s.writeHead(200, { 'Content-Type': 'image/jpeg' })
            return s.end(Buffer.alloc(4000, 0xff))
        }
        s.writeHead(404); s.end()
    })
    await new Promise((ok) => yt.listen(0, '127.0.0.1', ok))
    const ytBase = `http://127.0.0.1:${yt.address().port}`
    process.env.YOUTUBE_OEMBED_BASE = ytBase + '/oembed'
    process.env.YOUTUBE_WATCH_BASE = ytBase + '/watch'
    process.env.YOUTUBE_THUMB_BASE = ytBase + '/vi'
    let video
    try {
        r = await api('POST', '/admin/materials/videos', { token: A, body: { courseId: course._id, url: 'https://example.com/v.mp4' } })
        check('link không phải YouTube -> 400', [r.status, /không phải video YouTube/.test(r.body.message)], [400, true])
        r = await api('POST', '/admin/materials/videos', { token: A, body: { courseId: course._id, url: 'https://youtu.be/PRIVATE0001' } })
        check('video riêng tư / sai -> 400 kèm hướng dẫn "Không công khai"', [r.status, /Không công khai/.test(r.body.message)], [400, true])

        r = await api('POST', '/admin/materials/videos', { token: A, body: { courseId: course._id, url: 'https://www.youtube.com/watch?v=VIDEOOK0001&t=5s' } })
        video = r.body
        check('thêm video: tên + thời lượng lấy từ YouTube, có ảnh bìa, mặc định nháp',
            [r.status, video.title, video.durationSec, video.hasThumb, video.status], [201, 'Bài 1 — Chào hỏi (video)', 3600, true, 'draft'])
        r = await api('POST', '/admin/materials/videos', { token: A, body: { courseId: course._id, url: 'youtu.be/VIDEOOK0001' } })
        check('dán trùng video trong khoá -> 400', r.status, 400)
        r = await api('POST', '/admin/materials/videos', { token: A, body: { courseId: course._id, url: 'https://youtu.be/VIDEONODUR1', title: 'Số đếm', status: 'published' } })
        const v2 = r.body
        check('tự đặt tên; YouTube không cho đọc thời lượng -> 0', [v2.title, v2.durationSec], ['Số đếm', 0])

        r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
        check('học viên: chỉ thấy video đã xuất bản', r.body.videos.map((v) => v.title), ['Số đếm'])
        await api('PUT', `/admin/materials/videos/${video._id}`, { token: A, body: { status: 'published' } })
        await api('PUT', '/admin/materials/videos/reorder', { token: A, body: { courseId: course._id, ids: [v2._id, video._id] } })
        r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
        check('xuất bản + sắp xếp lại -> đúng thứ tự', r.body.videos.map((v) => v.title), ['Số đếm', 'Bài 1 — Chào hỏi (video)'])
        check('danh sách KHÔNG lộ mã YouTube', JSON.stringify(r.body).includes('VIDEOOK0001'), false)
        r = await api('GET', '/materials/courses', { token: tYes })
        check('thẻ khoá đếm 2 video', r.body.find((c) => c.slug === SLUG + 'hsk3').videoCount, 2)

        r = await api('GET', `/materials/videos/${video._id}`, { token: tYes })
        check('mở video: có mã YouTube, chưa xem', [r.status, r.body.youtubeId, r.body.progress], [200, 'VIDEOOK0001', null])
        r = await api('GET', `/materials/videos/${video._id}/thumb`, { token: tYes })
        check('ảnh bìa qua máy chủ, cấm cache', [r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'image/jpeg', 'private, no-store'])

        // Thời lượng ĐÃ THỰC SỰ PHÁT: trình phát gửi các đoạn vừa phát.
        const prog = (body, token = tYes, id = video._id) => api('PUT', `/materials/videos/${id}/progress`, { token, body })
        // Giả như thời gian thực đã trôi qua `sec` giây từ lần báo trước.
        const ago = (sec, id = video._id) =>
            MaterialVideoProgress.updateOne({ student: yes._id, video: id }, { $set: { lastReportAt: new Date(Date.now() - sec * 1000) } })
        r = await prog({ position: 10, duration: 3600, segments: [[0, 10]] })
        check('báo đoạn vừa phát -> cộng 10 giây đã xem', [r.status, r.body.position, r.body.watchedSec, r.body.completed], [200, 10, 10, false])
        r = await prog({ position: 3599, duration: 3600, segments: [] })
        check('TUA một phát tới cuối -> chỗ dừng đổi, KHÔNG cộng giây nào, chưa xong', [r.body.position, r.body.watchedSec, r.body.completed], [3599, 10, false])
        r = await prog({ position: 3600, duration: 3600, segments: [[10, 3600]] })
        check('gửi khống "đã xem cả video" ngay -> chỉ được cộng vài chục giây', [r.body.watchedSec <= 10 + 15 + 1, r.body.completed], [true, false])
        await ago(600)
        r = await prog({ position: 1200, duration: 3600, segments: [[600, 1200]] })
        const afterTen = r.body.watchedSec
        check('10 phút thực trôi qua -> cộng được đoạn 10 phút', afterTen >= 600 + 10, true)
        await ago(600)
        r = await prog({ position: 900, duration: 3600, segments: [[600, 900]] })
        check('xem lại đoạn đã xem -> không cộng lần hai', r.body.watchedSec, afterTen)
        await ago(3600)
        r = await prog({ position: 3300, duration: 3600, segments: [[0, 3300]] })
        check('đã xem 3300/3600 giây (91%) -> chưa đủ 95%', [r.body.completed, r.body.percent], [false, 91])
        await ago(600)
        r = await prog({ position: 3600, duration: 3600, segments: [[3300, 3480]] })
        check('xem tới 3480/3600 (96,7%) -> xem xong', [r.body.completed, r.body.percent], [true, 100])
        check('...trả các đoạn đã xem để tô lên thanh tua', Array.isArray(r.body.watched) && r.body.watched.length >= 1, true)
        r = await api('GET', `/materials/videos/${video._id}`, { token: tYes })
        check('mở lại -> có chỗ đang xem + các đoạn đã xem', [r.body.progress.position, r.body.progress.completed, Array.isArray(r.body.progress.watched)], [3600, true, true])
        r = await api('PUT', `/materials/videos/${v2._id}/progress`, { token: tYes, body: { position: 60, duration: 1805.4 } })
        r = await api('GET', `/admin/materials/videos?courseId=${course._id}`, { token: A })
        check('thời lượng còn thiếu -> lấy theo trình phát báo về', r.body.find((v) => v._id === v2._id).durationSec, 1805)

        r = await api('GET', `/materials/videos/${video._id}`, { token: tNo })
        check('học viên chưa có quyền -> 403', [r.status, r.body.code], [403, 'MATERIAL_NO_ACCESS'])
        r = await api('PUT', `/materials/videos/${video._id}/progress`, { token: tNo, body: { position: 10 } })
        check('...lưu tiến độ cũng 403', r.status, 403)

        // ---------- BÀI TẬP SAU VIDEO ----------
        console.log('\nBÀI TẬP CỦA KHOÁ (xem hết mọi video mới làm)')
        const exAdmin = `/admin/materials/courses/${course._id}/exercise`
        const exStudent = `/materials/courses/${SLUG}hsk3/exercise`
        r = await api('GET', exAdmin, { token: A })
        check('khoá chưa có bài tập -> đề rỗng, khoá có 2 video', [r.status, r.body.sections, r.body.videoCount], [200, [], 2])
        r = await api('GET', exStudent, { token: tYes })
        check('học viên mở bài tập khi khoá chưa có đề -> 404 NO_EXERCISE', [r.status, r.body.code], [404, 'NO_EXERCISE'])
        r = await api('PUT', exAdmin, {
            token: A,
            body: { sections: [{ type: 'word_bank', words: '家人 小学生', items: [{ text: '我想和___一起去吃饭。', answers: [] }] }] },
        })
        check('đề thiếu đáp án -> 400 chỉ rõ phần, câu', [r.status, /Phần 1, câu 1/.test(r.body.message)], [400, true])
        const sections = [
            {
                type: 'word_bank',
                words: '家人  小学生、有的 有些',
                items: [
                    { text: '今天是星期日，我想和_____一起去吃饭。', answers: ['家人'], explain: '今天是星期日，我想和家人一起去吃饭。\nHôm nay là Chủ nhật…' },
                    { text: '男：___ 学生喜欢看书，___ 喜欢玩儿。\n女：你呢？', answers: ['有的/有些', '有的/有些'], explain: '有些学生喜欢看书，有些喜欢玩儿。' },
                ],
            },
            { type: 'pinyin', items: [{ pinyin: 'bāozi', text: '我们早上吃____，好吗？', answers: ['包子'], explain: '我们早上吃包子，好吗？' }] },
            {
                type: 'sentence',
                items: [
                    { word: '饺子', sample: '我妈妈做的饺子很好吃。' },
                    { word: '好听', sample: '这个名字很好听。' },
                ],
            },
        ]
        r = await api('PUT', exAdmin, { token: A, body: { sections } })
        check('lưu đề 3 phần -> 5 câu, tiêu đề mặc định theo dạng',
            [r.status, r.body.exerciseCount, r.body.sections[1].title.startsWith('根据所给的拼音写汉字'), r.body.sections[0].words],
            [200, 5, true, ['家人', '小学生', '有的', '有些']])
        r = await api('GET', '/admin/materials/courses', { token: A })
        check('danh sách khoá admin: số câu bài tập', r.body.find((c) => c._id === course._id).exerciseCount, 5)

        // Mới xem đủ 1/2 video -> bài tập của khoá vẫn khoá
        r = await api('GET', exStudent, { token: tYes })
        check('mới xem đủ 1/2 video -> 403 VIDEO_NOT_WATCHED, nói rõ 1/2', [r.status, r.body.code, /1\/2 video/.test(r.body.message)], [403, 'VIDEO_NOT_WATCHED', true])
        r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers: {} } })
        check('...nộp thẳng qua API cũng bị chặn', [r.status, r.body.code], [403, 'VIDEO_NOT_WATCHED'])
        r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
        check('trang khoá: bài tập 5 câu, đã xem đủ 1/2 video, chưa mở',
            r.body.exercise, { itemCount: 5, totalVideos: 2, watchedVideos: 1, unlocked: false, last: null })
        r = await api('GET', `/materials/videos/${video._id}`, { token: tYes })
        check('trang video cũng báo tình trạng bài tập CỦA KHOÁ', [r.body.exercise.watchedVideos, r.body.exercise.unlocked], [1, false])

        // Xem nốt video thứ hai -> mở
        await ago(3600, v2._id)
        r = await prog({ position: 1805, duration: 1805, segments: [[0, 1805]] }, tYes, v2._id)
        check('xem hết video 2 -> xem xong', r.body.completed, true)

        r = await api('GET', exStudent, { token: tYes })
        const ex = r.body
        check('đã xem đủ -> mở được đề, chưa có lượt làm', [r.status, ex.sections.length, ex.lastAttempt], [200, 3, null])
        check('đề gửi học viên KHÔNG có đáp án, lời giải, câu mẫu',
            ['家人一起', '包子', '妈妈做的', 'answers', 'explain', 'sample'].some((x) => JSON.stringify(ex.sections).includes(x)), false)
        check('...nhưng có ô từ, pinyin, số chỗ trống', [ex.sections[0].words.length, ex.sections[1].items[0].pinyin, ex.sections[0].items[1].blanks], [4, 'bāozi', 2])
        r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
        check('trang khoá: đã xem đủ 2/2 -> mở bài tập', [r.body.exercise.watchedVideos, r.body.exercise.unlocked], [2, true])

        const [s1, s2, s3] = ex.sections
        const answers = {
            [s1.items[0].id]: ['  家人 '], // thừa khoảng trắng vẫn đúng
            [s1.items[1].id]: ['有些', '有的'], // đáp án ghi "有的/有些" -> nhận cả hai
            [s2.items[0].id]: ['包 子'],
            [s3.items[0].id]: '我喜欢吃饺子。',
            [s3.items[1].id]: '',
            hack: 'bỏ qua',
        }
        delete process.env.ANTHROPIC_API_KEY
        r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
        check('nộp bài: chấm tự động 4/4 chỗ trống (bỏ khoảng trắng, nhận đáp án thay thế)', [r.status, r.body.autoCorrect, r.body.autoTotal], [201, 4, 4])
        check('chưa cài khoá AI -> phần đặt câu "unavailable", vẫn có câu mẫu để tự so',
            [r.body.ai.status, r.body.sections[2].items[0].sample], ['unavailable', '我妈妈做的饺子很好吃。'])
        check('kết quả kèm đáp án + lời giải', [r.body.sections[0].items[0].answers, Boolean(r.body.sections[0].items[0].explain)], [['家人'], true])
        check('không lưu dữ liệu lạ trình duyệt gửi', 'hack' in r.body.answers, false)
        r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
        check('nộp liên tục -> 429', r.status, 429)

        // ---- AI chấm (máy chủ Anthropic giả) ----
        let aiMode = 'ok'
        let aiReq = null
        const ai = http.createServer((q, s) => {
            let raw = ''
            q.on('data', (c) => (raw += c))
            q.on('end', () => {
                aiReq = { headers: q.headers, body: JSON.parse(raw || '{}'), path: q.url }
                // Model kiểu Opus 5.5: không nhận tool_choice ép, trả lời bằng chữ có JSON.
                if (aiReq.body.model === 'claude-test-noforce') {
                    if (aiReq.body.tool_choice?.type === 'tool') {
                        s.writeHead(400, { 'Content-Type': 'application/json' })
                        return s.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } }))
                    }
                    const ids = [...JSON.stringify(aiReq.body).matchAll(/\(id: ([a-z0-9]+)\)/g)].map((m) => m[1])
                    s.writeHead(200, { 'Content-Type': 'application/json' })
                    return s.end(JSON.stringify({
                        model: 'claude-test-noforce',
                        content: [{ type: 'text', text: 'Kết quả: ' + JSON.stringify({ items: ids.map((id) => ({ id, verdict: 'gan_dat', comment: 'ok', corrected: '我喜欢吃饺子。' })) }) }],
                    }))
                }
                if (aiMode === 'down') {
                    s.writeHead(529, { 'Content-Type': 'application/json' })
                    return s.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
                }
                const ids = [...JSON.stringify(aiReq.body).matchAll(/\(id: ([a-z0-9]+)\)/g)].map((m) => m[1])
                s.writeHead(200, { 'Content-Type': 'application/json' })
                s.end(JSON.stringify({
                    model: 'claude-test',
                    content: [{ type: 'tool_use', name: 'ket_qua_cham', input: { items: ids.map((id) => ({ id, verdict: 'dat', comment: 'Câu đúng, tự nhiên.', corrected: '我喜欢吃饺子。' })) } }],
                }))
            })
        })
        await new Promise((ok) => ai.listen(0, '127.0.0.1', ok))
        process.env.ANTHROPIC_API_KEY = 'test-key'
        process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`
        // Ghi thẳng collection: Mongoose không cho sửa createdAt qua model.
        const backdate = () => MaterialExerciseAttempt.collection.updateMany({ student: yes._id }, { $set: { createdAt: new Date(Date.now() - 60000) } })
        try {
            await backdate()
            r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
            const sent = JSON.stringify(aiReq.body)
            check('AI chấm: gọi đúng API (khoá, phiên bản, ép trả qua công cụ)',
                [aiReq.path, aiReq.headers['x-api-key'], aiReq.headers['anthropic-version'], aiReq.body.tool_choice?.name], ['/v1/messages', 'test-key', '2023-06-01', 'ket_qua_cham'])
            check('...câu bỏ trống không gửi AI, tự chấm "chưa đạt"',
                [(sent.match(/\(id: /g) || []).length, r.body.results[s3.items[1].id].verdict], [1, 'chua_dat'])
            check('...KHÔNG gửi tên / SĐT học viên sang AI', [sent.includes('Smoke'), sent.includes(PHONES.yes)], [false, false])
            check('...kết quả: đạt 1/2, có nhận xét + câu sửa',
                [r.body.ai.status, r.body.ai.passed, r.body.ai.total, r.body.results[s3.items[0].id].comment], ['done', 1, 2, 'Câu đúng, tự nhiên.'])

            aiMode = 'down'
            await backdate()
            r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
            check('AI lỗi -> vẫn lưu bài, phần tự động vẫn chấm, báo lỗi AI', [r.status, r.body.autoCorrect, r.body.ai.status, /529/.test(r.body.ai.error)], [201, 4, 'error', true])
            aiMode = 'ok'
            r = await api('POST', `/materials/exercise-attempts/${r.body._id}/regrade`, { token: tYes })
            check('bấm chấm lại -> AI chấm xong', [r.status, r.body.ai.status, r.body.ai.passed], [200, 'done', 1])
            r = await api('POST', `/materials/exercise-attempts/${r.body._id}/regrade`, { token: tNo })
            check('chấm lại bài của người khác -> 404', r.status, 404)

            // ---- Cấu hình AI chấm (admin sửa hướng dẫn trên web) ----
            // Giữ nguyên cấu hình thật trong DB: chụp lại, cuối phần trả về như cũ.
            const AI_KEYS = ['ai_grading_rubric', 'ai_grading_model']
            const savedSettings = await AppSetting.find({ key: { $in: AI_KEYS } }).lean()
            try {
                await AppSetting.deleteMany({ key: { $in: AI_KEYS } })
                r = await api('GET', '/admin/materials/ai-grading', { token: A })
                check('cấu hình AI: mặc định, có model, báo đã cài khoá',
                    [r.status, r.body.isDefault, r.body.rubric === r.body.defaultRubric, Boolean(r.body.model), r.body.configured], [200, true, true, true, true])
                check('...hướng dẫn mặc định có các quyết định đã chốt (xưng "bạn", 早上好 = gần đạt, pinyin = chưa đạt)',
                    [/xưng "bạn"/.test(r.body.rubric), /早上好/.test(r.body.rubric), /pinyin/.test(r.body.rubric)], [true, true, true])
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { rubric: 'HƯỚNG DẪN THỬ: chấm thật khắt khe.' } })
                check('admin lưu hướng dẫn mới -> không còn là bản mặc định', [r.status, r.body.isDefault], [200, false])
                await backdate()
                r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
                check('bài nộp sau đó chấm theo hướng dẫn mới + phần quy tắc cố định, không gửi temperature',
                    [aiReq.body.system.startsWith('HƯỚNG DẪN THỬ'), /ket_qua_cham/.test(aiReq.body.system), /<<< và >>>/.test(aiReq.body.system), 'temperature' in aiReq.body],
                    [true, true, true, false])
                r = await api('POST', '/admin/materials/ai-grading/test', {
                    token: A,
                    body: { rubric: 'BẢN NHÁP CHƯA LƯU', items: [{ word: '饺子', answer: '我喜欢吃饺子。' }, { word: '', answer: 'bỏ qua' }] },
                })
                check('chấm thử: dùng bản nháp chưa lưu, bỏ dòng chưa có từ',
                    [r.status, aiReq.body.system.startsWith('BẢN NHÁP CHƯA LƯU'), r.body.items.length, r.body.items[0].verdict], [200, true, 1, 'dat'])
                r = await api('POST', '/admin/materials/ai-grading/test', { token: tYes, body: { items: [{ word: '饺子', answer: 'x' }] } })
                check('học viên gọi chấm thử -> 401', r.status, 401)
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { rubric: 'x'.repeat(9000) } })
                check('hướng dẫn quá dài -> 400', r.status, 400)
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { rubric: '' } })
                check('xoá trắng -> quay về bản mặc định', r.body.isDefault, true)

                // ---- Chọn model ----
                r = await api('GET', '/admin/materials/ai-grading', { token: A })
                const defaultModel = r.body.defaultModel
                check('model: chưa chọn -> dùng model mặc định, có danh sách gợi ý',
                    [r.body.model === defaultModel, r.body.modelSource !== 'admin', r.body.modelOptions.some((o) => o.id === 'claude-haiku-4-5-20251001')], [true, true, true])
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { model: 'claude-haiku-4-5-20251001' } })
                check('admin chọn Haiku -> lưu, nguồn "admin", hướng dẫn chấm không đổi', [r.status, r.body.model, r.body.modelSource, r.body.isDefault], [200, 'claude-haiku-4-5-20251001', 'admin', true])
                await backdate()
                r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
                check('bài nộp sau đó chấm bằng model đã chọn', aiReq.body.model, 'claude-haiku-4-5-20251001')
                r = await api('POST', '/admin/materials/ai-grading/test', { token: A, body: { model: 'claude-opus-5-5', items: [{ word: '饺子', answer: '我喜欢吃饺子。' }] } })
                check('chấm thử với model khác (chưa lưu)', [r.status, aiReq.body.model], [200, 'claude-opus-5-5'])
                r = await api('POST', '/admin/materials/ai-grading/test', { token: A, body: { model: 'claude-test-noforce', items: [{ word: '饺子', answer: '我喜欢吃饺子。' }] } })
                check('model không nhận tool_choice ép -> tự gọi lại kiểu "auto", đọc JSON trong câu trả lời',
                    [r.status, r.body.items[0]?.verdict, aiReq.body.tool_choice?.type], [200, 'gan_dat', 'auto'])
                r = await api('POST', '/admin/materials/ai-grading/test', { token: A, body: { model: 'claude-test-noforce', items: [{ word: '饺子', answer: '我喜欢吃饺子。' }] } })
                check('...lần sau nhớ luôn, gọi thẳng kiểu "auto"', [r.status, aiReq.body.tool_choice?.type], [200, 'auto'])
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { model: 'gpt-4o; rm -rf' } })
                check('mã model lạ -> 400', r.status, 400)
                r = await api('POST', '/admin/materials/ai-grading/test', { token: A, body: { model: 'bad model', items: [{ word: '饺子', answer: 'x' }] } })
                check('chấm thử với mã model lạ -> 400', r.status, 400)
                r = await api('PUT', '/admin/materials/ai-grading', { token: A, body: { model: '' } })
                check('bỏ chọn -> quay về model mặc định', [r.body.model, r.body.modelSource !== 'admin'], [defaultModel, true])
            } finally {
                await AppSetting.deleteMany({ key: { $in: AI_KEYS } })
                for (const x of savedSettings) await AppSetting.create({ key: x.key, value: x.value, updatedBy: x.updatedBy })
            }

            process.env.AI_GRADE_DAILY_LIMIT = '2'
            await backdate()
            r = await api('POST', `${exStudent}/attempts`, { token: tYes, body: { answers } })
            check('hết lượt AI trong ngày -> "limited", phần tự động vẫn chấm', [r.body.ai.status, r.body.autoCorrect], ['limited', 4])
            delete process.env.AI_GRADE_DAILY_LIMIT
        } finally {
            ai.close()
            delete process.env.ANTHROPIC_API_KEY
            delete process.env.ANTHROPIC_BASE_URL
        }

        r = await api('GET', exStudent, { token: tYes })
        check('mở lại bài tập -> có kết quả lượt gần nhất + số lượt', [Boolean(r.body.lastAttempt), r.body.attemptCount], [true, 6])
        r = await api('GET', `/materials/courses/${SLUG}hsk3`, { token: tYes })
        check('trang khoá: tóm tắt điểm lượt gần nhất', r.body.exercise.last.autoCorrect, 4)
        r = await api('GET', exStudent, { token: tNo })
        check('học viên không có quyền khoá -> 403', [r.status, r.body.code], [403, 'MATERIAL_NO_ACCESS'])
        r = await api('GET', `/materials/videos/${video._id}/thumb`)
        check('không đăng nhập -> 401', r.status, 401)
        await api('PUT', `/admin/materials/videos/${v2._id}`, { token: A, body: { status: 'draft' } })
        r = await api('GET', `/materials/videos/${v2._id}`, { token: tYes })
        check('ẩn video -> học viên không mở được (404)', r.status, 404)

        r = await api('PUT', `/admin/materials/videos/${video._id}`, { token: A, body: { url: 'https://youtu.be/VIDEONEW001' } })
        check('thay link video -> giữ tên, đổi mã, xoá tiến độ cũ',
            [r.status, r.body.title, r.body.youtubeId, await MaterialVideoProgress.countDocuments({ video: video._id })],
            [200, 'Bài 1 — Chào hỏi (video)', 'VIDEONEW001', 0])
        r = await api('DELETE', `/admin/materials/videos/${v2._id}`, { token: A })
        check('xoá video -> xoá ảnh bìa + tiến độ, bài tập CỦA KHOÁ vẫn còn',
            [r.status, fs.existsSync(videoThumb(v2._id)), await MaterialVideoProgress.countDocuments({ video: v2._id }), await MaterialExercise.countDocuments({ courseId: course._id })],
            [200, false, 0, 1])
    } finally {
        yt.close()
    }

    // ---------- XOÁ ----------
    console.log('\nXOÁ')
    r = await api('DELETE', `/admin/materials/decks/${bad._id}`, { token: A })
    check('xoá bộ slide -> xoá cả thư mục', [r.status, fs.existsSync(deckDir(bad._id))], [200, false])
    r = await api('DELETE', `/admin/materials/courses/${course._id}`, { token: A })
    check('xoá khoá còn nội dung -> 409 hỏi lại', [r.status, r.body.code], [409, 'MATERIAL_COURSE_IN_USE'])
    r = await api('DELETE', `/admin/materials/courses/${course._id}?force=1`, { token: A })
    check('xoá hẳn -> gỡ luôn quyền của học viên', [r.status, (await Student.findById(yes._id)).materialAccess.length], [200, 0])
    check('...và file của mọi bộ slide', fs.existsSync(deckDir(deck._id)), false)
    check('...và video + ảnh bìa + bài tập + bài làm',
        [await MaterialVideo.countDocuments({ courseId: course._id }), fs.existsSync(videoThumb(video._id)), await MaterialExercise.countDocuments({ courseId: course._id }), await MaterialExerciseAttempt.countDocuments({ courseId: course._id })],
        [0, false, 0, 0])

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
