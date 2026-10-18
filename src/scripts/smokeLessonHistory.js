/**
 * KIỂM TRA TÍCH HỢP cho lịch sử hoàn thành bài học.
 *
 *   npm run smoke:history
 *
 * Tự dựng học viên, bản ghi luyện nói và FILE GHI ÂM THẬT, đi trọn luồng:
 * hoàn thành bài -> giữ lại bản ghi -> nghe lại -> nén -> dọn.
 *
 * Tự dọn sạch ở cuối, kể cả khi có bước thất bại.
 *
 * MỌI LỜI GỌI TÁC VỤ DỌN Ở ĐÂY ĐỀU PHẢI TRUYỀN `student`. Các hàm đó mặc định
 * chạy trên toàn bộ cơ sở dữ liệu — bản đầu của script này gọi thiếu và đã xoá
 * mất 111 bản ghi luyện nói có sẵn trên máy phát triển.
 */
require('dotenv').config()
const fs = require('fs')
const http = require('http')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const app = require('../app')
const connectDB = require('../config/db')
const Admin = require('../models/Admin')
const Student = require('../models/Student')
const LessonAttempt = require('../models/LessonAttempt')
const PracticeAttempt = require('../models/PracticeAttempt')
const { savePracticeAudio, resolveStoragePath, SAMPLE_RATE } = require('../lib/audioStorage')
const { deleteExpiredProvisional, compressKeptAudio, sweepOrphanFiles } = require('../lib/practiceCleanup')

const PHONES = ['0900000071', '0900000072']
const LESSON_ID = new mongoose.Types.ObjectId()

let pass = 0
let fail = 0
let server

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    ok ? pass++ : fail++
    console.log(`  ${ok ? '✓' : '✗ LỆCH'}  ${label}`)
    if (!ok) console.log(`           nhận: ${JSON.stringify(actual)}\n           mong: ${JSON.stringify(expected)}`)
}
function checkTruthy(label, actual) {
    const ok = Boolean(actual)
    ok ? pass++ : fail++
    console.log(`  ${ok ? '✓' : '✗ LỆCH'}  ${label}${ok ? '' : `  (nhận: ${JSON.stringify(actual)})`}`)
}

function request(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
        const req = http.request(
            {
                host: '127.0.0.1', port: server.address().port, method, path: '/api' + path,
                headers: {
                    ...(token ? { Authorization: 'Bearer ' + token } : {}),
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                },
            },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    const raw = Buffer.concat(chunks)
                    let json = null
                    try { json = JSON.parse(raw.toString()) } catch (e) { /* nhị phân */ }
                    resolve({ status: res.statusCode, body: json, bytes: raw.length, type: res.headers['content-type'] })
                })
            }
        )
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

/** Một đoạn PCM im lặng pha chút nhiễu, đủ để ffmpeg nén được thật. */
function fakePcm(seconds = 1) {
    const samples = SAMPLE_RATE * seconds
    const buf = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i * 2)
    }
    return buf
}

async function makeAttempt(studentId, videoIndex, lineIndex, pronScore, createdAt) {
    const audio = await savePracticeAudio(studentId, fakePcm(), SAMPLE_RATE)
    const doc = await PracticeAttempt.create({
        student: studentId,
        lesson: LESSON_ID,
        lessonSlug: 'bai-thu',
        lessonTitle: 'Bài thử',
        videoIndex,
        lineIndex,
        referenceText: `câu v${videoIndex}l${lineIndex}`,
        referencePinyin: 'cau',
        pronScore,
        audioPath: audio.relativePath,
        audioFormat: 'wav',
        audioBytes: audio.bytes,
    })
    // Lùi ngày phải đi QUA DRIVER, không qua Mongoose: schema bật `timestamps`
    // nên Mongoose GỠ BỎ `createdAt` khỏi $set của mọi lệnh cập nhật (nó coi
    // đó là trường chỉ ghi lúc tạo). Lệnh vẫn báo thành công, ngày vẫn y
    // nguyên — đã đo, và nó làm ba kiểm tra ở dưới sai oan.
    if (createdAt) await PracticeAttempt.collection.updateOne({ _id: doc._id }, { $set: { createdAt } })
    return doc
}

async function cleanup() {
    const students = await Student.find({ phone: { $in: PHONES } }).select('_id')
    const ids = students.map((s) => s._id)
    if (ids.length) {
        const attempts = await PracticeAttempt.find({ student: { $in: ids } }).select('audioPath').lean()
        for (const a of attempts) {
            const abs = a.audioPath && resolveStoragePath(a.audioPath)
            if (abs) await fs.promises.unlink(abs).catch(() => { })
        }
        await PracticeAttempt.deleteMany({ student: { $in: ids } })
        await LessonAttempt.deleteMany({ student: { $in: ids } })
        await Student.deleteMany({ _id: { $in: ids } })
    }
}

async function main() {
    await connectDB()
    server = http.createServer(app)
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    await cleanup()

    const admin = await Admin.findOne()
    if (!admin) throw new Error('Chưa có admin — chạy `npm run seed:admin`.')
    const adminToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '10m' })

    const me = await Student.create({ name: 'Học viên thử', phone: PHONES[0], password: PHONES[0] })
    const other = await Student.create({ name: 'Người khác', phone: PHONES[1], password: PHONES[1] })

    const login = async (phone) =>
        (await request('POST', '/auth/student/login', { phone, password: phone, deviceId: 'hist-' + phone, deviceType: 'desktop' })).body.token
    const token = await login(PHONES[0])
    const otherToken = await login(PHONES[1])

    // ---------- DỰNG BẢN GHI LUYỆN NÓI ----------
    console.log('\nDỰNG BẢN GHI LUYỆN NÓI (có file ghi âm thật)')
    // Video 0: câu 0 đọc 3 lần, câu 1 đọc 1 lần. Video 1: câu 0 đọc 1 lần.
    await makeAttempt(me._id, 0, 0, 40)
    await makeAttempt(me._id, 0, 0, 55)
    const last00 = await makeAttempt(me._id, 0, 0, 82) // lần cuối, phải được giữ
    await makeAttempt(me._id, 0, 1, 90)
    await makeAttempt(me._id, 1, 0, null) // iFLYTEK từ chối
    check('5 bản ghi tạm', await PracticeAttempt.countDocuments({ student: me._id, lessonAttempt: null }), 5)

    // ---------- HOÀN THÀNH BÀI ----------
    console.log('\nHOÀN THÀNH BÀI')
    let r = await request('POST', '/lesson-attempts', {
        lessonId: String(LESSON_ID),
        lessonTitle: 'Bài thử', lessonSlug: 'bai-thu', courseSlug: 'hsk1', curriculumSlug: 'gtc',
        videos: [
            { index: 0, title: 'Video 1', exercise: { correct: 1, total: 2, answers: [
                { correct: true, type: 'Chọn đáp án đúng', question: 'X?', yourAnswer: 'A', correctAnswer: 'A' },
                { correct: false, type: 'Chọn đáp án đúng', question: 'A?', yourAnswer: 'B', correctAnswer: 'C' },
            ] } },
            { index: 1, title: 'Video 2', exercise: { correct: 18, total: 20, answers: [] } },
        ],
    }, token)
    check('-> 201', r.status, 201)
    const at = r.body.attempt
    check('GIỮ CẢ 5 lượt đọc, kể cả đọc lại', r.body.keptRecordings, 5)

    check('điểm bài tập cộng dồn rồi mới quy thang 100', [at.exercise.correct, at.exercise.total, at.exercise.score100], [19, 22, 86])
    // Câu 0 đọc 3 lần (40 -> 55 -> 82). Điểm lấy LƯỢT CUỐI = 82, không phải
    // trung bình 59 — phải khớp con số học viên thấy lúc làm bài.
    check('điểm tính trên LƯỢT CUỐI mỗi câu', at.speaking.avgScore, 86) // (82+90)/2
    check('đếm theo CÂU, không theo lượt đọc', at.speaking.lineCount, 3)
    check('nói rõ trung bình dựa trên mấy câu', at.speaking.scoredCount, 2)
    check('đếm đủ tổng số lượt đọc', at.speaking.totalReadings, 5)
    check('đánh dấu điểm bài tập KHÔNG kiểm chứng được', at.exerciseScoreTrusted, false)

    check('câu của video 0 gắn đúng video 0', at.videos[0].speaking.lines.map((l) => l.lineIndex), [0, 1])
    check('câu của video 1 KHÔNG bị gộp nhầm sang video 0', at.videos[1].speaking.lines.length, 1)

    const line0 = at.videos[0].speaking.lines[0]
    check('câu đọc 3 lần giữ đủ 3 lượt', line0.attempts.length, 3)
    check('các lượt xếp cũ trước, thấy được tiến bộ', line0.attempts.map((x) => x.score), [40, 55, 82])
    check('điểm của câu là lượt cuối', line0.score, 82)
    check('mỗi lượt có bản ghi riêng để nghe lại', line0.attempts.every((x) => x.attemptId), true)
    check('lưu CẢ câu đúng lẫn câu sai', at.videos[0].exercise.answers.length, 2)
    check('câu đúng mang cờ correct', at.videos[0].exercise.answers[0].correct, true)
    check('câu sai giữ đủ đáp án để xem lại', at.videos[0].exercise.answers[1].correctAnswer, 'C')

    check('không còn bản ghi tạm nào', await PracticeAttempt.countDocuments({ student: me._id, lessonAttempt: null }), 0)
    check('cả 5 bản ghi thuộc lượt này', await PracticeAttempt.countDocuments({ lessonAttempt: at._id }), 5)
    check('lượt đọc cuối cũng được giữ', await PracticeAttempt.countDocuments({ _id: last00._id, lessonAttempt: at._id }), 1)
    const files = await PracticeAttempt.find({ lessonAttempt: at._id }).select('audioPath').lean()
    check('MỌI lượt đọc còn file ghi âm', files.every((f) => fs.existsSync(resolveStoragePath(f.audioPath))), true)

    // ---------- NỘP TRÙNG ----------
    console.log('\nNỘP TRÙNG')
    r = await request('POST', '/lesson-attempts', { lessonId: String(LESSON_ID), videos: [] }, token)
    check('nộp lại ngay -> không tạo bản ghi thứ hai', r.body.duplicate, true)
    check('chỉ có 1 lượt trong DB', await LessonAttempt.countDocuments({ student: me._id }), 1)

    // ---------- HỌC VIÊN XEM LỊCH SỬ ----------
    console.log('\nHỌC VIÊN XEM LỊCH SỬ CỦA MÌNH')
    r = await request('GET', '/lesson-attempts', undefined, token)
    check('thấy 1 lượt', r.body.pagination.total, 1)
    r = await request('GET', `/lesson-attempts/${at._id}`, undefined, token)
    check('xem chi tiết -> 200', r.status, 200)

    r = await request('GET', `/lesson-attempts/${at._id}`, undefined, otherToken)
    check('NGƯỜI KHÁC xem -> 404, không lộ gì', r.status, 404)
    r = await request('GET', '/lesson-attempts', undefined, otherToken)
    check('người khác không thấy lượt nào', r.body.pagination.total, 0)
    r = await request('GET', `/lesson-attempts/${at._id}`, undefined, null)
    check('không đăng nhập -> 401', r.status, 401)

    // ---------- NGHE LẠI ----------
    console.log('\nNGHE LẠI GHI ÂM')
    const recId = at.videos[0].speaking.lines[0].attemptId
    r = await request('GET', `/lesson-attempts/recordings/${recId}`, undefined, token)
    check('nghe giọng MÌNH -> 200', r.status, 200)
    check('đúng kiểu nội dung wav', r.type, 'audio/wav')
    checkTruthy('có dữ liệu thật', r.bytes > 1000)
    r = await request('GET', `/lesson-attempts/recordings/${recId}`, undefined, otherToken)
    check('NGƯỜI KHÁC nghe -> 404', r.status, 404)

    // ---------- ADMIN ----------
    console.log('\nPHÍA QUẢN TRỊ')
    r = await request('GET', `/students/${me._id}/lesson-attempts`, undefined, adminToken)
    check('admin xem lịch sử học viên -> 200', r.status, 200)
    check('thấy đúng 1 lượt', r.body.pagination.total, 1)
    check('kèm thông tin học viên', r.body.student.phone, PHONES[0])
    r = await request('GET', `/students/${me._id}/recordings/${recId}`, undefined, adminToken)
    check('admin nghe được ghi âm', r.status, 200)
    r = await request('GET', `/students/${other._id}/recordings/${recId}`, undefined, adminToken)
    check('ghi âm không thuộc học viên đó -> 404', r.status, 404)
    r = await request('GET', `/students/${me._id}/lesson-attempts`, undefined, token)
    check('token học viên không vào được route admin -> 401', r.status, 401)

    // ---------- NÉN ----------
    console.log('\nNÉN WAV -> AAC')
    const before = await PracticeAttempt.find({ lessonAttempt: at._id }).select('audioBytes').lean()
    const beforeBytes = before.reduce((s, a) => s + a.audioBytes, 0)
    // GIỚI HẠN trong học viên của bài test. Gọi không giới hạn là chạy tác vụ
    // dọn trên TOÀN BỘ dữ liệu của máy — chính sai lầm đó đã xoá mất 111 bản
    // ghi có sẵn khi chạy bản đầu tiên của script này.
    const comp = await compressKeptAudio({ student: me._id })
    if (comp.stopped) {
        console.log('  (bỏ qua — máy này không chạy được ffmpeg)')
    } else {
        check('nén đủ 5 file', comp.converted, 5)
        const after = await PracticeAttempt.find({ lessonAttempt: at._id }).select('audioBytes audioFormat audioPath').lean()
        check('mọi bản ghi chuyển sang m4a', after.every((a) => a.audioFormat === 'm4a'), true)
        const afterBytes = after.reduce((s, a) => s + a.audioBytes, 0)
        checkTruthy(`nhỏ hơn hẳn (${(beforeBytes / 1024).toFixed(0)} KB -> ${(afterBytes / 1024).toFixed(0)} KB)`, afterBytes < beforeBytes / 2)
        check('file WAV cũ đã bị xoá', after.every((a) => !fs.existsSync(resolveStoragePath(a.audioPath).replace(/\.m4a$/, '.wav'))), true)

        r = await request('GET', `/lesson-attempts/recordings/${recId}`, undefined, token)
        check('nén xong vẫn nghe lại được', r.status, 200)
        check('kiểu nội dung đổi theo', r.type, 'audio/mp4')
    }

    // ---------- DỌN ----------
    console.log('\nDỌN BẢN GHI CỦA BÀI BỎ DỞ')
    const abandoned = await makeAttempt(me._id, 0, 5, 70, new Date(Date.now() - 48 * 3600 * 1000))
    const fresh = await makeAttempt(me._id, 0, 6, 70) // mới đọc, đang học dở
    const abandonedFile = resolveStoragePath(abandoned.audioPath)

    const res2 = await deleteExpiredProvisional({ student: me._id })
    checkTruthy('có xoá bản ghi quá hạn', res2.deleted >= 1)
    check('bản ghi quá 24 giờ đã bị xoá', await PracticeAttempt.countDocuments({ _id: abandoned._id }), 0)
    check('file ghi âm của nó cũng mất theo', fs.existsSync(abandonedFile), false)
    check('bản ghi MỚI của bài đang học dở vẫn còn', await PracticeAttempt.countDocuments({ _id: fresh._id }), 1)
    check('bản ghi ĐÃ GIỮ không bị đụng tới', await PracticeAttempt.countDocuments({ lessonAttempt: at._id }), 5)

    console.log('\nQUÉT FILE MỒ CÔI')
    const orphanPath = (await savePracticeAudio(me._id, fakePcm(), SAMPLE_RATE)).relativePath
    const orphanAbs = resolveStoragePath(orphanPath)
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await fs.promises.utimes(orphanAbs, old, old)
    const sweep = await sweepOrphanFiles({ student: me._id })
    checkTruthy('tìm và xoá được file không ai trỏ tới', sweep.deleted >= 1)
    check('file mồ côi đã mất', fs.existsSync(orphanAbs), false)
    check('file của bản ghi còn sống vẫn nguyên', fs.existsSync(resolveStoragePath((await PracticeAttempt.findById(fresh._id)).audioPath)), true)
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
