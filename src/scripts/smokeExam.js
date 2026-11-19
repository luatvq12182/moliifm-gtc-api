/**
 * KIỂM TRA TÍCH HỢP cho "Luyện thi HSK 3.0" (giai đoạn 1: cấp thi, video
 * hướng dẫn kỹ năng thi, cấp quyền).
 *
 *   npm run smoke:exam
 *
 * YouTube chạy bằng máy chủ GIẢ ngay trong script, không cần mạng. Tự dựng cấp
 * thi, học viên; tự dọn sạch ở cuối (chỉ dữ liệu của chính script), kể cả khi
 * có bước thất bại. Cần có sẵn một tài khoản admin (npm run seed:admin).
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
const ExamLevel = require('../models/ExamLevel')
const ExamVideo = require('../models/ExamVideo')
const ExamVideoProgress = require('../models/ExamVideoProgress')
const ExamTest = require('../models/ExamTest')
const ExamAttempt = require('../models/ExamAttempt')
const { testDir } = require('../lib/examTest')
const { signAudioToken: signAudioTokenFor } = require('../lib/examAttempt')
const { execFileSync } = require('child_process')
const os = require('os')
const { MATERIALS_DIR } = require('../lib/materialConvert')

const videoThumb = (id) => path.join(MATERIALS_DIR, 'videos', `${id}.jpg`)

const SLUG = 'smoke-exam-'
const PHONES = { yes: '0900000071', no: '0900000072' }
const DEVICE = { deviceId: 'smoke-exam-device', deviceType: 'desktop' }

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

/** PDF tối giản: mỗi phần tử của `sizes` là một trang [rộng, cao] (điểm). */
function makePdf(sizes) {
    const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', '']
    const kids = []
    sizes.forEach(([w, h], i) => {
        const st = `BT /F1 40 Tf 60 ${h / 2} Td (Trang ${i + 1}) Tj ET`
        kids.push(`${objs.length} 0 R`)
        objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${objs.length + 1} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`)
        objs.push(`<< /Length ${st.length} >>\nstream\n${st}\nendstream`)
    })
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${sizes.length} >>`
    let out = '%PDF-1.4\n'
    const off = []
    for (let i = 1; i < objs.length; i++) {
        off[i] = Buffer.byteLength(out)
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`
    }
    const x = Buffer.byteLength(out)
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
    return Buffer.from(out)
}

/** Chờ đề chuyển đổi PDF xong. */
async function waitPdf(id, token) {
    for (let i = 0; i < 240; i++) {
        const r = await api('GET', `/admin/exam/tests/${id}`, { token })
        if (r.body.pdf.conversion !== 'processing') return r.body
        await new Promise((ok) => setTimeout(ok, 250))
    }
    throw new Error('Chuyển đổi đề quá lâu')
}

async function cleanup() {
    const ids = (await ExamLevel.find({ slug: new RegExp('^' + SLUG) }).select('_id')).map((l) => l._id)
    const videos = await ExamVideo.find({ levelId: { $in: ids } }).select('_id')
    for (const v of videos) await fs.promises.rm(videoThumb(v._id), { force: true })
    const tests = await ExamTest.find({ levelId: { $in: ids } }).select('_id')
    for (const t of tests) await fs.promises.rm(testDir(t._id), { recursive: true, force: true })
    await ExamTest.deleteMany({ levelId: { $in: ids } })
    await ExamAttempt.deleteMany({ levelId: { $in: ids } })
    await ExamVideoProgress.deleteMany({ levelId: { $in: ids } })
    await ExamVideo.deleteMany({ levelId: { $in: ids } })
    await ExamLevel.deleteMany({ _id: { $in: ids } })
    await Student.deleteMany({ phone: { $in: Object.values(PHONES) } })
}

/** YouTube giả: oEmbed, trang xem (thời lượng), ảnh bìa, danh sách phát. */
function fakeYouTube() {
    const known = { EXAMVID0001: 'Kỹ năng nghe — phần 1', EXAMVID0002: 'Kỹ năng đọc' }
    return http.createServer((q, s) => {
        const u = new URL(q.url, 'http://x')
        const vid = (u.searchParams.get('url') || '').split('v=')[1] || u.searchParams.get('v')
        if (u.pathname === '/oembed') {
            if (!known[vid]) { s.writeHead(404); return s.end('Not Found') }
            s.writeHead(200, { 'Content-Type': 'application/json' })
            return s.end(JSON.stringify({ title: known[vid], type: 'video' }))
        }
        if (u.pathname === '/watch') {
            s.writeHead(200, { 'Content-Type': 'text/html' })
            return s.end('<html>..."lengthSeconds":"600",...</html>')
        }
        if (u.pathname === '/playlist') {
            if (u.searchParams.get('list') !== 'PLEXAM00001') { s.writeHead(200, { 'Content-Type': 'text/html' }); return s.end('<html>không có</html>') }
            const data = { metadata: { playlistMetadataRenderer: { title: 'Kỹ năng thi HSK3' } }, contents: { list: [
                { playlistVideoRenderer: { videoId: 'EXAMPL00001', title: { runs: [{ text: 'Kỹ năng viết' }] }, lengthSeconds: '300', isPlayable: true } },
                { playlistVideoRenderer: { videoId: 'EXAMVID0001', title: { runs: [{ text: 'Đã có' }] }, lengthSeconds: '600', isPlayable: true } },
                { playlistVideoRenderer: { videoId: 'EXAMPL00002', title: { simpleText: '[Private video]' }, isPlayable: false } },
            ] } }
            s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            return s.end(`<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`)
        }
        if (/\/hqdefault\.jpg$/.test(u.pathname)) {
            s.writeHead(200, { 'Content-Type': 'image/jpeg' })
            return s.end(Buffer.alloc(4000, 0xff))
        }
        s.writeHead(404)
        s.end()
    })
}

async function main() {
    // KHÔNG BAO GIỜ gọi AI thật trong bài kiểm tra (tốn tiền, gửi dữ liệu ra ngoài):
    // bỏ khoá thật trong .env, phần chấm AI chỉ chạy với máy chủ giả bên dưới.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
    await connectDB()
    server = http.createServer(app)
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
    await cleanup()

    const admin = await Admin.findOne()
    if (!admin) throw new Error('Chưa có tài khoản admin nào trong DB — chạy `npm run seed:admin` trước.')
    const A = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' })

    // ---------- CẤP THI ----------
    console.log('\nCẤP THI')
    let r = await api('POST', '/admin/exam/levels', { token: A, body: { name: 'HSK 3', slug: 'Sai Slug!' } })
    check('slug sai định dạng -> 400', r.status, 400)
    r = await api('POST', '/admin/exam/levels', { token: A, body: { name: '', slug: SLUG + 'x' } })
    check('thiếu tên -> 400', r.status, 400)
    r = await api('POST', '/admin/exam/levels', { token: A, body: { name: 'Luyện thi HSK3 3.0', slug: SLUG + 'hsk3' } })
    check('tạo cấp -> 201, mặc định nháp', [r.status, r.body.status], [201, 'draft'])
    const level = r.body
    r = await api('POST', '/admin/exam/levels', { token: A, body: { name: 'Trùng', slug: SLUG + 'hsk3' } })
    check('trùng slug -> 409', r.status, 409)
    r = await api('POST', '/admin/exam/levels', { token: A, body: { name: 'Luyện thi HSK4 3.0', slug: SLUG + 'hsk4', status: 'published', order: 2 } })
    const level4 = r.body
    r = await api('PUT', `/admin/exam/levels/${level4._id}`, { token: A, body: { slug: SLUG + 'hsk3' } })
    check('sửa sang slug đã có -> 409', r.status, 409)
    r = await api('PUT', `/admin/exam/levels/${level._id}`, { token: A, body: { description: 'Nghe 23\', đọc 30\', viết 20\'' } })
    check('sửa một phần (chỉ mô tả) -> giữ tên, slug', [r.status, r.body.name, r.body.slug], [200, 'Luyện thi HSK3 3.0', SLUG + 'hsk3'])

    const yes = await Student.create({ name: 'Smoke Thi Có Quyền', phone: PHONES.yes, password: PHONES.yes })
    const no = await Student.create({ name: 'Smoke Thi Không Quyền', phone: PHONES.no, password: PHONES.no })
    const login = async (phone) => (await api('POST', '/auth/student/login', { body: { phone, password: phone, ...DEVICE } })).body.token
    const tYes = await login(PHONES.yes)
    const tNo = await login(PHONES.no)

    // ---------- CẤP QUYỀN ----------
    console.log('\nCẤP QUYỀN')
    r = await api('PATCH', '/admin/exam/access', { token: A, body: { studentIds: [yes._id], levelId: level._id, action: 'xoá' } })
    check('thao tác lạ -> 400', r.status, 400)
    r = await api('PATCH', '/admin/exam/access', { token: A, body: { studentIds: [yes._id], levelId: level._id, action: 'grant' } })
    check('cấp quyền HSK3 -> đổi 1', [r.status, r.body.changed], [200, 1])
    r = await api('PATCH', '/admin/exam/access', { token: A, body: { studentIds: [yes._id, no._id], levelId: level4._id, action: 'grant' } })
    r = await api('PATCH', '/admin/exam/access', { token: A, body: { studentIds: [yes._id], levelId: level._id, action: 'grant' } })
    check('cấp lại lần hai -> đổi 0', r.body.changed, 0)
    r = await api('GET', `/admin/exam/access?levelId=${level._id}&scope=has&search=Smoke Thi`, { token: A })
    check('lọc "đã có quyền HSK3" -> chỉ học viên có quyền', r.body.data.map((s) => s.phone), [PHONES.yes])
    r = await api('GET', `/admin/exam/access?levelId=${level._id}&scope=missing&search=Smoke Thi`, { token: A })
    check('lọc "chưa có quyền HSK3" -> học viên còn lại', [r.body.data.map((s) => s.phone), r.body.data[0].access.length], [[PHONES.no], 1])
    r = await api('PATCH', '/admin/exam/access', { token: A, body: { studentIds: [no._id], levelId: level4._id, action: 'revoke' } })
    check('thu hồi HSK4 của người không quyền -> đổi 1', r.body.changed, 1)
    check('quyền học liệu không bị đụng', (await Student.findById(yes._id)).materialAccess.length, 0)

    // ---------- HỌC VIÊN ----------
    console.log('\nHỌC VIÊN — CHỌN CẤP')
    r = await api('GET', '/exam/levels', { token: tYes })
    check('cấp nháp không hiện, cấp đã xuất bản có quyền thì hiện', r.body.filter((l) => l.slug.startsWith(SLUG)).map((l) => l.slug), [SLUG + 'hsk4'])
    r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
    check('mở cấp nháp -> 404', r.status, 404)
    await api('PUT', `/admin/exam/levels/${level._id}`, { token: A, body: { status: 'published' } })
    r = await api('GET', '/exam/levels', { token: tYes })
    check('xuất bản -> hiện cả hai, đúng thứ tự', r.body.filter((l) => l.slug.startsWith(SLUG)).map((l) => l.slug), [SLUG + 'hsk3', SLUG + 'hsk4'])
    r = await api('GET', '/exam/levels', { token: tNo })
    check('người không quyền -> không thấy cấp nào', r.body.filter((l) => l.slug.startsWith(SLUG)).length, 0)
    r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tNo })
    check('người không quyền mở thẳng đường dẫn -> 403 EXAM_NO_ACCESS', [r.status, r.body.code], [403, 'EXAM_NO_ACCESS'])
    r = await api('GET', '/exam/levels')
    check('chưa đăng nhập -> 401', r.status, 401)
    r = await api('GET', '/exam/levels', { token: A })
    check('token admin vào API học viên -> 401', r.status, 401)

    // ---------- VIDEO HƯỚNG DẪN ----------
    console.log('\nVIDEO HƯỚNG DẪN KỸ NĂNG THI (YouTube giả)')
    const yt = fakeYouTube()
    await new Promise((ok) => yt.listen(0, '127.0.0.1', ok))
    const ytBase = `http://127.0.0.1:${yt.address().port}`
    process.env.YOUTUBE_OEMBED_BASE = ytBase + '/oembed'
    process.env.YOUTUBE_WATCH_BASE = ytBase + '/watch'
    process.env.YOUTUBE_THUMB_BASE = ytBase + '/vi'
    process.env.YOUTUBE_PLAYLIST_BASE = ytBase + '/playlist'
    let video
    try {
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level._id, url: 'https://example.com/a.mp4' } })
        check('link không phải YouTube -> 400', r.status, 400)
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level._id, url: 'https://youtu.be/PRIVATE0001' } })
        check('video riêng tư / sai -> 400 kèm hướng dẫn', [r.status, /Không công khai/.test(r.body.message)], [400, true])
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level._id, url: 'https://www.youtube.com/watch?v=EXAMVID0001' } })
        video = r.body
        check('thêm video: tên + thời lượng từ YouTube, có ảnh bìa, mặc định nháp',
            [r.status, video.title, video.durationSec, video.hasThumb, video.status], [201, 'Kỹ năng nghe — phần 1', 600, true, 'draft'])
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level._id, url: 'youtu.be/EXAMVID0001' } })
        check('dán trùng trong cùng cấp -> 400', r.status, 400)
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level4._id, url: 'youtu.be/EXAMVID0001', status: 'published' } })
        check('cùng video ở cấp khác -> được', r.status, 201)
        r = await api('POST', '/admin/exam/videos', { token: A, body: { levelId: level._id, url: 'https://youtu.be/EXAMVID0002', title: 'Đọc hiểu', status: 'published' } })
        const v2 = r.body

        r = await api('POST', '/admin/exam/videos/playlist', { token: A, body: { levelId: level._id, url: 'https://www.youtube.com/playlist?list=PLEXAM00001', status: 'published' } })
        check('nhập danh sách phát: 1 mới, bỏ qua video đã có + riêng tư',
            [r.status, r.body.playlistTitle, r.body.created, r.body.skipped.map((x) => x.reason).sort()], [201, 'Kỹ năng thi HSK3', 1, ['riêng tư / đã xoá', 'đã có trong cấp này']])

        r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
        check('học viên: chỉ thấy video đã xuất bản', r.body.videos.map((v) => v.title), ['Đọc hiểu', 'Kỹ năng viết'])
        await api('PUT', `/admin/exam/videos/${video._id}`, { token: A, body: { status: 'published', title: 'Nghe — phần 1' } })
        const pl = (await api('GET', `/admin/exam/videos?levelId=${level._id}`, { token: A })).body.find((v) => v.youtubeId === 'EXAMPL00001')
        await api('PUT', '/admin/exam/videos/reorder', { token: A, body: { levelId: level._id, ids: [video._id, pl._id, v2._id] } })
        r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
        check('xuất bản + đổi tên + sắp xếp lại', r.body.videos.map((v) => v.title), ['Nghe — phần 1', 'Kỹ năng viết', 'Đọc hiểu'])
        check('danh sách KHÔNG lộ mã YouTube', JSON.stringify(r.body).includes('EXAMVID0001'), false)
        r = await api('GET', '/exam/levels', { token: tYes })
        check('thẻ cấp đếm video đã xuất bản', r.body.find((l) => l.slug === SLUG + 'hsk3').videoCount, 3)
        r = await api('GET', `/admin/exam/levels`, { token: A })
        const row = r.body.find((l) => l._id === level._id)
        check('admin: đếm video + học viên của cấp', [row.videoCount, row.studentCount], [3, 1])

        r = await api('GET', `/exam/videos/${video._id}`, { token: tYes })
        check('mở video: có mã YouTube, tên cấp, chưa xem', [r.status, r.body.youtubeId, r.body.level.slug, r.body.progress], [200, 'EXAMVID0001', SLUG + 'hsk3', null])
        r = await api('GET', `/exam/videos/${video._id}`, { token: tNo })
        check('người không quyền mở video -> 403', r.status, 403)
        r = await api('GET', `/exam/videos/${video._id}/thumb`, { token: tYes })
        check('ảnh bìa qua máy chủ, cấm cache', [r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'image/jpeg', 'private, no-store'])
        r = await api('GET', `/exam/videos/${video._id}/thumb`, { token: tNo })
        check('ảnh bìa: người không quyền -> 403', r.status, 403)

        const prog = (body) => api('PUT', `/exam/videos/${video._id}/progress`, { token: tYes, body })
        r = await prog({ position: 10, duration: 600, segments: [[0, 10]] })
        check('báo đoạn vừa phát -> cộng 10 giây', [r.status, r.body.watchedSec, r.body.completed], [200, 10, false])
        r = await prog({ position: 599, duration: 600, segments: [] })
        check('tua tới cuối -> không cộng', [r.body.position, r.body.watchedSec], [599, 10])
        await ExamVideoProgress.updateOne({ student: yes._id, video: video._id }, { $set: { lastReportAt: new Date(Date.now() - 700 * 1000) } })
        r = await prog({ position: 600, duration: 600, segments: [[10, 600]] })
        check('xem đủ -> xong', [r.body.completed, r.body.percent], [true, 100])
        r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
        check('danh sách hiện % đã xem', r.body.videos[0].progress.percent, 100)

        r = await api('PUT', `/admin/exam/videos/${video._id}`, { token: A, body: { url: 'https://youtu.be/EXAMVID0002' } })
        check('đổi sang video khác -> xoá tiến độ cũ', [r.status, r.body.youtubeId, await ExamVideoProgress.countDocuments({ video: video._id })], [200, 'EXAMVID0002', 0])
        r = await api('DELETE', `/admin/exam/videos/${v2._id}`, { token: A })
        check('xoá video -> xoá ảnh bìa', [r.status, fs.existsSync(videoThumb(v2._id))], [200, false])
    } finally {
        yt.close()
        delete process.env.YOUTUBE_OEMBED_BASE
        delete process.env.YOUTUBE_WATCH_BASE
        delete process.env.YOUTUBE_THUMB_BASE
        delete process.env.YOUTUBE_PLAYLIST_BASE
    }

    // ---------- ĐỀ LUYỆN THI ----------
    console.log('\nĐỀ LUYỆN THI (soạn đề)')
    r = await api('GET', '/admin/exam/templates', { token: A })
    check('có mẫu đề HSK3', r.body.map((t) => t.id), ['hsk3', 'blank'])
    r = await api('POST', '/admin/exam/tests', { token: A, body: { levelId: level._id, template: 'hsk3' } })
    let test = r.body
    check('tạo đề theo mẫu HSK3: tên mặc định, 70 câu, 12 nhóm, nháp',
        [r.status, test.title, test.questionCount, test.groups.length, test.status], [201, 'Đề 1', 70, 12, 'draft'])
    check('mẫu HSK3: điểm tối đa nghe 100 · đọc 100 · viết 100 = 300, đỗ 180',
        [test.scores.listening, test.scores.reading, test.scores.writing, test.scores.total, test.passScore], [100, 100, 100, 300, 180])
    check('mẫu HSK3: câu 6–10 chỉ có A–E', test.groups.find((g) => g.from === 6).options, 'ABCDE')
    check('đề mới chưa sẵn sàng: thiếu PDF, file nghe, đáp án', [test.ready, test.missing.length], [false, 4])
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { status: 'published' } })
    check('xuất bản đề chưa đủ -> 400 kèm lý do', [r.status, r.body.code, /file nghe/.test(r.body.message)], [400, 'EXAM_TEST_NOT_READY', true])

    // cấu trúc sai
    const G = test.groups
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { groups: [...G, { section: 'writing', type: 'text', from: 70, to: 71, points: 1 }] } })
    check('nhóm câu chồng nhau -> 400', [r.status, /chồng/.test(r.body.message)], [400, true])
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { groups: [{ section: 'reading', type: 'choice', from: 1, to: 5, options: 'ABC' }, { section: 'listening', type: 'choice', from: 6, to: 8, options: 'ABC' }] } })
    check('nghe đứng sau đọc -> 400', [r.status, /nghe → đọc → viết/.test(r.body.message)], [400, true])
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { groups: [{ section: 'listening', type: 'choice', from: 1, to: 5, options: 'a' }] } })
    check('nhóm chọn chỉ có 1 lựa chọn -> 400', r.status, 400)

    // đáp án
    const items = []
    for (let n = 1; n <= 60; n++) items.push({ no: n, answer: 'ABC'[n % 3], ...(n === 1 ? { script: '男：你好！\nNán: Nǐ hǎo!', explain: 'B 正确：GIAI-THICH-BI-MAT' } : {}) })
    for (let n = 61; n <= 65; n++) items.push({ no: n, answer: ['汽', '图', '空', '方', '礼'][n - 61] })
    for (let n = 66; n <= 70; n++) items.push({ no: n, keyword: ['电话', '聊天儿', '环境', '洗衣机', '放学'][n - 66], hint: 'cô gái đang gọi điện' })
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { items: [...items.slice(0, 5), { no: 7, answer: 'F' }] } })
    check('đáp án ngoài lựa chọn (câu 7 chỉ có A–E) -> 400', [r.status, /Câu 7/.test(r.body.message)], [400, true])
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { items: [...items, { no: 99, answer: 'A' }, { no: 3, answer: ' b ' }] } })
    check('lưu đáp án: bỏ câu ngoài cấu trúc, chuẩn hoá chữ hoa', [r.status, r.body.items.length, r.body.items.find((i) => i.no === 3).answer], [200, 70, 'B'])
    check('...còn thiếu PDF + file nghe', r.body.missing.length, 3)
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { groups: G.filter((g) => g.to <= 65) } })
    check('bỏ nhóm 66–70 -> đáp án các câu đó bị bỏ theo', [r.body.items.length, r.body.questionCount], [65, 65])
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { groups: G, items, timing: { readingSec: 25 * 60, reviewSec: 0 }, passScore: 200 } })
    check('khôi phục cấu trúc + đặt giờ, điểm đỗ', [r.body.questionCount, r.body.timing.readingSec, r.body.timing.reviewSec, r.body.passScore], [70, 1500, 0, 200])

    // PDF: 1 trang dọc + 2 trang ngang (2 trang giấy cạnh nhau)
    r = await upload(`/admin/exam/tests/${test._id}/pdf`, A, { buffer: Buffer.from('không phải pdf'), name: 'de.pdf' })
    check('file đuôi .pdf nhưng không phải PDF -> 400', r.status, 400)
    r = await upload(`/admin/exam/tests/${test._id}/pdf`, A, { buffer: Buffer.from('x'), name: 'de.docx' })
    check('file không phải .pdf -> 400', r.status, 400)
    const pdf = makePdf([[595, 842], [1190, 842], [1190, 842]])
    r = await upload(`/admin/exam/tests/${test._id}/pdf`, A, { buffer: pdf, name: 'ĐỀ 1 HSK3.pdf', fields: { splitSpreads: '1' } })
    check('tải PDF (cắt đôi trang ngang) -> đang chuyển', [r.status, r.body.pdf.conversion, r.body.pdf.originalName], [201, 'processing', 'ĐỀ 1 HSK3.pdf'])
    test = await waitPdf(test._id, A)
    check('cắt đôi: 1 trang dọc + 2 trang ngang -> 5 trang dọc', [test.pdf.conversion, test.pdf.pages.length, test.pdf.pages.every((p) => p.height > p.width)], ['ready', 5, true])
    r = await api('POST', `/admin/exam/tests/${test._id}/pdf/convert`, { token: A, body: { splitSpreads: false } })
    test = await waitPdf(test._id, A)
    check('chuyển lại KHÔNG cắt -> 3 trang, file cũ được dọn', [test.pdf.pages.length, test.pdf.version, fs.readdirSync(testDir(test._id)).sort()], [3, 2, ['source-v2.pdf', 'v2']])
    r = await api('PUT', `/admin/exam/tests/${test._id}/pages`, { token: A, body: { hidden: [3] } })
    check('ẩn trang 3 -> còn 2 trang hiện', [r.body.pdf.pages.map((p) => p.hidden), r.body.pageCount], [[false, false, true], 2])
    r = await api('GET', `/admin/exam/tests/${test._id}/pages/3?thumb=1`, { token: A })
    check('admin vẫn xem được trang đã ẩn (ảnh JPEG, cấm cache)', [r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'image/jpeg', 'private, no-store'])
    r = await api('GET', `/admin/exam/tests/${test._id}/pages/9`, { token: A })
    check('trang không có -> 404', r.status, 404)

    // File nghe
    const mp3 = path.join(os.tmpdir(), `smoke-exam-${process.pid}.mp3`)
    let haveFfmpeg = true
    try {
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-q:a', '9', mp3])
    } catch {
        haveFfmpeg = false
    }
    r = await upload(`/admin/exam/tests/${test._id}/audio`, A, { buffer: Buffer.from('x'), name: 'nghe.txt' })
    check('file nghe sai đuôi -> 400', r.status, 400)
    if (haveFfmpeg) {
        r = await upload(`/admin/exam/tests/${test._id}/audio`, A, { buffer: Buffer.from('rác rác rác'), name: 'hong.mp3', fields: { durationSec: '1380' } })
        check('file .mp3 hỏng -> 400 (không tin số trình duyệt gửi khi máy chủ đọc được file)', r.status, 400)
        r = await upload(`/admin/exam/tests/${test._id}/audio`, A, { buffer: fs.readFileSync(mp3), name: 'Nghe đề 1.mp3', fields: { durationSec: '999' } })
        check('tải file nghe -> máy chủ tự đo thời lượng (7 giây)', [r.status, r.body.audio.has, r.body.audio.durationSec, r.body.listeningSec], [201, true, 7, 7])
        r = await api('GET', `/admin/exam/tests/${test._id}/audio`, { token: A })
        check('nghe thử: trả file âm thanh, cấm cache', [r.status, /audio/.test(r.headers.get('content-type')), r.headers.get('cache-control')], [200, true, 'private, no-store'])
        const ranged = await fetch(`${base}/api/admin/exam/tests/${test._id}/audio`, { headers: { Authorization: 'Bearer ' + A, Range: 'bytes=0-99' } })
        check('...hỗ trợ tua (Range -> 206)', [ranged.status, Number(ranged.headers.get('content-length'))], [206, 100])
        fs.rmSync(mp3, { force: true })
    } else {
        console.log('  (bỏ qua phần file nghe thật — máy không có ffmpeg)')
        await ExamTest.updateOne({ _id: test._id }, { $set: { audio: { file: 'audio-v1.mp3', originalName: 'x.mp3', bytes: 1, durationSec: 7, version: 1 } } })
    }

    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { status: 'published' } })
    check('đủ PDF + file nghe + đáp án -> xuất bản được', [r.status, r.body.status, r.body.ready], [200, 'published', true])
    r = await upload(`/admin/exam/tests/${test._id}/pdf`, A, { buffer: pdf, name: 'moi.pdf' })
    check('đề đang hiện: không cho thay PDF (409)', r.status, 409)
    r = await api('DELETE', `/admin/exam/tests/${test._id}/audio`, { token: A })
    check('đề đang hiện: không cho xoá file nghe (409)', r.status, 409)
    r = await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { items: items.slice(0, 50) } })
    check('đề đang hiện: xoá bớt đáp án -> 400 (phải ẩn đề trước)', r.status, 400)
    r = await api('PUT', `/admin/exam/tests/${test._id}/pages`, { token: A, body: { hidden: [1, 2, 3] } })
    check('đề đang hiện: ẩn hết trang -> 400', r.status, 400)

    // ---------- LÀM ĐỀ ----------
    console.log('\nLÀM ĐỀ (học viên)')
    await api('PUT', `/admin/exam/tests/${test._id}`, {
        token: A,
        body: { timing: { reviewSec: 300, readingSec: 1800, writingSec: 1200 }, groups: G.map((g) => ({ ...g, page: g.from === 31 ? 2 : g.from === 61 ? 3 : g.from === 66 ? 1 : 0 })) },
    })
    // Lùi giờ bắt đầu phần hiện tại `sec` giây — giả như thời gian đã trôi.
    const back = async (id, sec) => {
        const a = await ExamAttempt.findById(id)
        a.sectionStartedAt = new Date(a.sectionStartedAt.getTime() - sec * 1000)
        await a.save()
    }
    r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
    check('trang cấp: chỉ đề đang hiện, kèm tổng thời gian', r.body.tests.map((t) => [t.title, t.questionCount, t.durationSec, t.inProgressId, t.submittedCount]),
        [['Đề 1', 70, 7 + 300 + 1800 + 1200, null, 0]])
    r = await api('GET', `/exam/tests/${test._id}`, { token: tYes })
    check('giới thiệu đề: 4 phần, điền sẵn tên + SĐT', [r.body.sections.map((x) => [x.id, x.durationSec, x.questionCount]), r.body.candidate.phone],
        [[['listening', 7, 30], ['review', 300, 0], ['reading', 1800, 30], ['writing', 1200, 10]], PHONES.yes])
    r = await api('GET', `/exam/tests/${test._id}`, { token: tNo })
    check('người không quyền xem đề -> 403', r.status, 403)
    r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: 'Thí sinh A', phone: '123' } })
    check('vào thi: SĐT sai -> 400', r.status, 400)
    r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: '', phone: PHONES.yes } })
    check('vào thi: thiếu tên -> 400', r.status, 400)
    r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: 'Thí sinh A', phone: '+84 900 000 071', classCode: 'SMOKE-K99' } })
    const att = r.body._id
    check('vào thi -> tạo lượt làm, chuẩn hoá SĐT', [r.status, r.body.resumed, (await ExamAttempt.findById(att)).candidate.phone], [201, false, PHONES.yes])
    r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: 'Khác', phone: PHONES.yes } })
    check('vào lại khi đang làm dở -> trả đúng lượt cũ', [r.body._id, r.body.resumed], [att, true])

    r = await api('GET', `/exam/attempts/${att}`, { token: tYes })
    let st = r.body
    check('bài làm: đang ở phần nghe, có vé nghe, còn ~7 giây', [st.section, Boolean(st.audio?.path), new Date(st.sectionEndsAt) - new Date(st.serverNow) <= 7000, st.canFinishEarly], ['listening', true, true, false])
    check('bài làm KHÔNG lộ đáp án / giải thích (chỉ có từ bắt buộc in sẵn trên đề)', [JSON.stringify(st).includes('汽'), JSON.stringify(st).includes('GIAI-THICH-BI-MAT'), st.explanations, st.keywords['66']], [false, false, null, '电话'])
    check('trang đề: chỉ trang đang hiện', st.pages.map((p) => p.n), [1, 2])
    check('trang của nhóm câu: đổi sang số trang đang hiện (trang 3 bị ẩn -> 0)', st.groups.filter((g) => g.from <= 61 && g.from >= 31).map((g) => g.page), [2, 0, 0, 0, 0, 0])
    r = await api('GET', `/exam/attempts/${att}/pages/1`, { token: tYes })
    check('ảnh trang đề qua máy chủ, cấm cache', [r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'image/jpeg', 'private, no-store'])
    r = await api('GET', `/exam/attempts/${att}/pages/3`, { token: tYes })
    check('trang đã ẩn không xem được', r.status, 404)
    r = await api('GET', `/exam/attempts/${att}`, { token: tNo })
    check('học viên khác mở bài làm -> 403/404', [403, 404].includes(r.status), true)
    if (haveFfmpeg) {
        const au = await fetch(base + '/api' + st.audio.path, { headers: { Range: 'bytes=0-49' } })
        check('file nghe phát bằng vé (không cần token), tua được (206)', [au.status, au.headers.get('cache-control')], [206, 'private, no-store'])
    }
    r = await api('GET', '/exam/audio/vé-giả')
    check('vé nghe giả -> 403', r.status, 403)

    const save = (answers) => api('PUT', `/exam/attempts/${att}/answers`, { token: tYes, body: { answers } })
    r = await save({ 1: 'b', 2: 'Z', 31: 'A', 61: '汽', 999: 'A' })
    check('phần nghe: chỉ lưu câu nghe hợp lệ', [r.body.saved, r.body.rejected.sort((a, b) => a - b)], [1, [2, 31, 61, 999]])
    r = await api('POST', `/exam/attempts/${att}/finish`, { token: tYes, body: { section: 'listening' } })
    check('phần nghe KHÔNG cho nộp sớm', r.body.section, 'listening')

    await back(att, 8)
    r = await api('GET', `/exam/attempts/${att}`, { token: tYes })
    st = r.body
    check('hết file nghe -> tự sang 5 phút xem lại, hết vé nghe', [st.section, st.audio, st.canFinishEarly], ['review', null, false])
    if (haveFfmpeg) {
        const au = await fetch(base + '/api' + `/exam/audio/${signAudioTokenFor(await ExamAttempt.findById(att).lean())}`)
        check('...vé nghe (dù còn hạn) không phát được nữa -> 403', au.status, 403)
    }
    r = await save({ 2: 'c', 3: 'A' })
    check('lúc xem lại vẫn sửa được câu nghe', [r.body.saved, (await ExamAttempt.findById(att)).answers['2']], [2, 'C'])

    await back(att, 301)
    r = await save({ 4: 'B', 31: 'D' })
    check('vừa sang phần đọc: câu nghe gửi trễ vài giây vẫn nhận, câu đọc nhận', [r.body.section, r.body.saved], ['reading', 2])
    await back(att, 20)
    r = await save({ 5: 'B', 32: 'E', 61: '汽' })
    check('20 giây sau: câu nghe bị từ chối, câu viết chưa được làm', [r.body.saved, r.body.rejected.sort((a, b) => a - b)], [1, [5, 61]])
    r = await api('POST', `/exam/attempts/${att}/finish`, { token: tYes, body: { section: 'reading' } })
    check('nộp sớm phần đọc -> sang phần viết, đủ 20 phút', [r.body.section, Math.round((new Date(r.body.sectionEndsAt) - new Date(r.body.serverNow)) / 60000)], ['writing', 20])
    r = await api('POST', `/exam/attempts/${att}/finish`, { token: tYes, body: { section: 'reading' } })
    check('bấm nộp phần đọc lần nữa (trễ) -> không nhảy cóc phần viết', r.body.section, 'writing')
    r = await save({ 61: ' 汽 ', 66: '我给妈妈打电话。'.repeat(50), 31: 'A' })
    check('phần viết: lưu chữ Hán + câu (cắt bớt nếu quá dài), câu đọc bị từ chối',
        [r.body.saved, r.body.rejected, (await ExamAttempt.findById(att)).answers['66'].length], [2, [31], 300])

    await back(att, 1201)
    r = await api('GET', `/exam/attempts/${att}`, { token: tYes })
    check('hết giờ phần viết -> tự nộp', [r.body.status, r.body.submitReason, r.body.section], ['submitted', 'time', null])
    r = await save({ 62: '图' })
    check('đã nộp -> không sửa được nữa', [r.body.saved, r.body.status], [0, 'submitted'])
    r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
    check('trang cấp: đã làm 1 lần, không còn bài dở', [r.body.tests[0].submittedCount, r.body.tests[0].inProgressId], [1, null])

    r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: 'Thí sinh A', phone: PHONES.yes } })
    const att2 = r.body._id
    check('làm lại -> lượt mới', [r.status, att2 !== att], [201, true])
    // Bỏ trang cả buổi: quay lại sau 2 tiếng -> mọi phần đã hết, bài tự nộp.
    await back(att2, 2 * 3600)
    r = await api('GET', `/exam/attempts/${att2}`, { token: tYes })
    check('đóng trang 2 tiếng rồi mở lại -> bài đã tự nộp đúng lúc hết giờ', [r.body.status, r.body.submitReason], ['submitted', 'time'])
    const a2 = await ExamAttempt.findById(att2)
    check('...giờ nộp = đúng lúc hết phần viết (không phải lúc mở lại)', Math.round((Date.now() - a2.submittedAt) / 1000 / 60), 120 - Math.round((7 + 300 + 1800 + 1200) / 60))

    // ---------- CHẤM BÀI ----------
    console.log('\nCHẤM BÀI')
    const graded = async (id) => {
        for (let i = 0; i < 100; i++) {
            const a = await ExamAttempt.findById(id).lean()
            if (a?.result && a.result.ai?.status !== 'pending') return a
            await new Promise((ok) => setTimeout(ok, 100))
        }
        throw new Error('Chấm quá lâu')
    }
    let ga = await graded(att)
    // Đáp án đề: câu n = "ABC"[n % 3]; 61–65 = 汽… Bài làm: 1 B✓ 2 C✓ 3 A✓ 4 B✓ · 31 D✗ 32 E✗ · 61 " 汽 "✓ · 66 có viết
    check('nộp xong tự chấm: nghe 4 câu đúng = 13 điểm, đọc 0, viết 10 (chữ Hán 10đ/câu, bỏ khoảng trắng)',
        [ga.result.sections.listening.correct, ga.result.sections.listening.score, ga.result.sections.reading.score, ga.result.items['61'].ok, ga.result.sections.writing.score],
        [4, 13, 0, true, 10])
    check('tổng 23/300, chưa đỗ', [ga.result.total, ga.result.max, ga.result.passed, ga.result.passScore], [23, 300, false, 200])
    check('chưa cài khoá AI -> đặt câu chưa chấm ("unavailable"), câu bỏ trống 0 điểm',
        [ga.result.ai.status, ga.result.items['66'].score, ga.result.items['66'].max, ga.result.items['67'].blank, ga.result.items['67'].points], ['unavailable', null, 10, true, 0])
    r = await api('GET', `/exam/attempts/${att}`, { token: tYes })
    check('học viên xem kết quả: đáp án đúng từng câu', [r.body.result.items['31'].correct, r.body.result.items['31'].ok, r.body.result.items['31'].given, r.body.canRegrade], ['B', false, 'D', false])
    check('...và nội dung + giải thích từng câu (sau khi nộp)', [r.body.explanations['1'].script, r.body.explanations['1'].explain, r.body.explanations['2']], ['男：你好！\nNán: Nǐ hǎo!', 'B 正确：GIAI-THICH-BI-MAT', undefined])

    // AI giả
    let aiMode = 'ok'
    let aiReq = null
    let aiCalls = 0
    const fakeAi = http.createServer((q, s2) => {
        let raw = ''
        q.on('data', (c) => (raw += c))
        q.on('end', () => {
            aiCalls++
            aiReq = JSON.parse(raw || '{}')
            if (aiMode === 'down') {
                s2.writeHead(529, { 'Content-Type': 'application/json' })
                return s2.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
            }
            const ids = [...raw.matchAll(/\(id: ([0-9]+)\)/g)].map((m) => m[1])
            s2.writeHead(200, { 'Content-Type': 'application/json' })
            // AI "cho" 9 điểm; thử luôn trường hợp AI trả quá thang (15) -> phải bị chặn về 10 ở câu thứ hai trở đi
            s2.end(JSON.stringify({ model: 'claude-test', content: [{ type: 'tool_use', name: 'cham_diem_cau', input: { items: ids.map((id, i) => ({ id, score: i === 0 ? 9 : 15, comment: 'Câu hay.', corrected: '她在打电话。' })) } }] }))
        })
    })
    await new Promise((ok) => fakeAi.listen(0, '127.0.0.1', ok))
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}`
    try {
        r = await api('POST', `/admin/exam/attempts/${att}/regrade`, { token: A })
        const sent = JSON.stringify(aiReq)
        check('admin chấm lại -> AI cho câu 66: 9/10 điểm, viết 19, tổng 32',
            [r.status, r.body.result.ai.status, r.body.result.items['66'].score, r.body.result.items['66'].points, r.body.result.items['66'].ok, r.body.result.sections.writing.score, r.body.result.total],
            [200, 'done', 9, 9, true, 19, 32])
        check('...yêu cầu AI chấm thang 0–10 bằng công cụ cho điểm', [aiReq.tool_choice?.name, /từ 0 đến 10/.test(aiReq.system), /0 ĐẾN 10/.test(aiReq.system)], ['cham_diem_cau', true, true])
        check('...gửi AI: ảnh trang đề có tranh, số câu đề, từ bắt buộc, mô tả tranh',
            [aiReq.messages[0].content.some((c) => c.type === 'image'), sent.includes('Câu đề số 66'), sent.includes('电话'), sent.includes('cô gái đang gọi điện')], [true, true, true, true])
        check('...KHÔNG gửi tên / SĐT / mã lớp thí sinh sang AI', [sent.includes('Thí sinh A'), sent.includes(PHONES.yes), sent.includes('SMOKE-K99'), sent.includes('Smoke')], [false, false, false, false])
        check('...câu bỏ trống không gửi AI', (sent.match(/\(id: /g) || []).length, 1)

        aiMode = 'down'
        r = await api('POST', `/admin/exam/attempts/${att}/regrade`, { token: A })
        check('AI lỗi -> ghi lỗi, điểm đặt câu chưa tính, học viên được bấm chấm lại',
            [r.body.result.ai.status, r.body.result.items['66'].points, (await api('GET', `/exam/attempts/${att}`, { token: tYes })).body.canRegrade], ['error', 0, true])
        aiMode = 'ok'
        r = await api('POST', `/exam/attempts/${att}/regrade`, { token: tYes })
        check('học viên bấm chấm lại -> đang chấm', r.body.result.ai.status, 'pending')
        ga = await graded(att)
        check('...xong: 9 điểm, tổng 32', [ga.result.ai.status, ga.result.total], ['done', 32])
        r = await api('POST', `/exam/attempts/${att}/regrade`, { token: tYes })
        check('đã chấm xong thì học viên không chấm lại được nữa', [r.body.result.ai.status, r.body.canRegrade], ['done', false])

        // Hạn mức AI / ngày
        process.env.EXAM_AI_DAILY_LIMIT = '1'
        r = await api('POST', `/exam/tests/${test._id}/attempts`, { token: tYes, body: { name: 'Thí sinh A', phone: PHONES.yes } })
        const att3 = r.body._id
        await back(att3, 7 + 300 + 1800 + 5)
        await api('GET', `/exam/attempts/${att3}`, { token: tYes })
        r = await api('PUT', `/exam/attempts/${att3}/answers`, { token: tYes, body: { answers: { 66: '我给朋友打电话。' } } })
        check('lượt 3 vào thẳng phần viết (nhảy giờ), lưu câu 66', [r.body.section, r.body.saved], ['writing', 1])
        const callsBefore = aiCalls
        await api('POST', `/exam/attempts/${att3}/finish`, { token: tYes, body: { section: 'writing' } })
        ga = await graded(att3)
        check('vượt hạn mức AI trong ngày -> "limited", không gọi AI', [ga.result.ai.status, aiCalls - callsBefore], ['limited', 0])
        delete process.env.EXAM_AI_DAILY_LIMIT

        // Admin: danh sách + sửa đáp án rồi chấm lại cả đề
        r = await api('GET', `/admin/exam/attempts?testId=${test._id}`, { token: A })
        check('admin: danh sách bài làm của đề (3 bài), có điểm', [r.body.pagination.total, r.body.data.every((x) => x.status === 'submitted'), r.body.data.find((x) => x._id === att).result.total], [3, true, 32])
        check('...không kèm câu trả lời chi tiết (nhẹ)', JSON.stringify(r.body).includes('我给朋友打电话'), false)
        r = await api('GET', `/admin/exam/attempts?search=SMOKE-K99`, { token: A })
        check('tìm theo mã lớp', r.body.data.map((x) => x._id), [att])
        r = await api('GET', `/admin/exam/attempts?search=${PHONES.yes}&status=submitted&levelId=${level._id}`, { token: A })
        check('tìm theo SĐT tài khoản + lọc cấp, trạng thái', r.body.pagination.total, 3)
        r = await api('GET', `/admin/exam/tests/${test._id}`, { token: A })
        check('trang soạn đề biết số bài đã nộp', r.body.submittedCount, 3)
        const fixed = r.body.items.map((it) => (it.no === 31 ? { ...it, answer: 'D' } : it))
        await api('PUT', `/admin/exam/tests/${test._id}`, { token: A, body: { items: fixed } })
        const callsBefore2 = aiCalls
        r = await api('POST', `/admin/exam/tests/${test._id}/regrade`, { token: A })
        ga = await ExamAttempt.findById(att).lean()
        check('sửa đáp án câu 31 -> chấm lại cả đề: câu 31 đúng, giữ điểm AI, không gọi lại AI',
            [r.body.regraded, ga.result.items['31'].ok, ga.result.sections.reading.score, ga.result.items['66'].score, ga.result.total, aiCalls - callsBefore2],
            [3, true, 3, 9, 35, 0])
        r = await api('GET', `/admin/exam/attempts/${att}`, { token: A })
        check('admin xem chi tiết: thí sinh, tài khoản, từng câu', [r.body.candidate.classCode, r.body.student.phone, r.body.result.items['66'].comment], ['SMOKE-K99', PHONES.yes, 'Câu hay.'])
        r = await api('GET', `/exam/levels/${SLUG}hsk3`, { token: tYes })
        check('trang cấp của học viên: điểm lần gần nhất', [r.body.tests[0].submittedCount, r.body.tests[0].last.total !== null], [3, true])
        r = await api('GET', `/exam/tests/${test._id}`, { token: tYes })
        check('trang giới thiệu đề: lịch sử 3 lần làm kèm điểm', [r.body.history.length, r.body.history.some((h) => h.total === 35)], [3, true])
        r = await api('DELETE', `/admin/exam/attempts/${att3}`, { token: A })
        check('admin xoá một bài làm', [r.status, await ExamAttempt.countDocuments({ _id: att3 })], [200, 0])
        r = await api('GET', `/admin/exam/attempts`, { token: tYes })
        check('token học viên vào API kết quả admin -> 401', r.status, 401)
    } finally {
        fakeAi.close()
        delete process.env.ANTHROPIC_API_KEY
        delete process.env.ANTHROPIC_BASE_URL
        delete process.env.EXAM_AI_DAILY_LIMIT
    }

    r = await api('POST', '/admin/exam/tests', { token: A, body: { levelId: level._id, template: 'blank', title: 'Đề trống' } })
    const blank = r.body
    check('tạo đề trống', [r.body.title, r.body.questionCount, r.body.missing.includes('Chưa khai cấu trúc câu hỏi.')], ['Đề trống', 0, true])
    await api('PUT', '/admin/exam/tests/reorder', { token: A, body: { levelId: level._id, ids: [blank._id, test._id] } })
    r = await api('GET', `/admin/exam/tests?levelId=${level._id}`, { token: A })
    check('danh sách đề theo thứ tự mới, kèm trạng thái sẵn sàng', r.body.map((t) => [t.title, t.ready]), [['Đề trống', false], ['Đề 1', true]])
    check('danh sách KHÔNG kèm đáp án', JSON.stringify(r.body).includes('汽'), false)
    r = await api('GET', '/admin/exam/levels', { token: A })
    check('thẻ cấp đếm số đề', r.body.find((l) => l._id === level._id).testCount, 2)
    r = await api('DELETE', `/admin/exam/tests/${blank._id}`, { token: A })
    check('xoá đề -> xoá cả lượt làm của đề đó', await ExamAttempt.countDocuments({ testId: blank._id }), 0)
    check('xoá đề', [r.status, await ExamTest.countDocuments({ _id: blank._id })], [200, 0])
    r = await api('GET', `/admin/exam/tests/${test._id}`, { token: tYes })
    check('token học viên vào API soạn đề -> 401', r.status, 401)

    // ---------- XOÁ CẤP ----------
    console.log('\nXOÁ CẤP')
    r = await api('DELETE', `/admin/exam/levels/${level._id}`, { token: A })
    check('xoá cấp còn video / học viên -> 409 hỏi lại', [r.status, r.body.code], [409, 'EXAM_LEVEL_IN_USE'])
    r = await api('DELETE', `/admin/exam/levels/${level._id}?force=1`, { token: A })
    check('xoá hẳn -> gỡ quyền học viên, xoá video + ảnh bìa',
        [r.status, (await Student.findById(yes._id)).examAccess.map(String), await ExamVideo.countDocuments({ levelId: level._id }), fs.existsSync(videoThumb(video._id))],
        [200, [String(level4._id)], 0, false])
    check('...và đề + file đề + lượt làm', [await ExamTest.countDocuments({ levelId: level._id }), fs.existsSync(testDir(test._id)), await ExamAttempt.countDocuments({ levelId: level._id })], [0, false, 0])

    console.log('\nQUYỀN')
    r = await api('GET', '/admin/exam/levels', { token: tYes })
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
