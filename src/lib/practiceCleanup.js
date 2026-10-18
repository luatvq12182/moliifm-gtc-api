const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const PracticeAttempt = require('../models/PracticeAttempt')
const { STORAGE_ROOT, resolveStoragePath, deletePracticeAudio } = require('./audioStorage')

/**
 * DỌN DẸP ĐỊNH KỲ KHO GHI ÂM LUYỆN NÓI.
 *
 * Hai yêu cầu của khách chỉ đi chung được nếu có tác vụ này:
 *   "chỉ lưu khi học viên hoàn thành cả bài"  +  "có giữ file ghi âm"
 *
 * File ghi âm phải ghi xuống đĩa NGAY lúc học viên đọc — giữ trong bộ nhớ
 * trình duyệt rồi tải 25 file một lúc lúc kết thúc là quá dễ hỏng trên mạng di
 * động, và mất tab là mất sạch. Nên hệ thống ghi trước, rồi dọn sau.
 *
 * Tác vụ này làm ba việc:
 *   1. Xoá bản ghi TẠM quá hạn (bài học viên bỏ dở)
 *   2. Nén bản ghi ĐÃ GIỮ từ WAV sang AAC — nhỏ hơn ~7 lần, đo trên dữ liệu thật
 *   3. Quét file mồ côi trên đĩa (không còn bản ghi nào trỏ tới)
 *
 * Nó cũng là LƯỚI AN TOÀN cho mọi lỗi nửa chừng ở chỗ khác: thứ gì chưa được
 * đánh dấu giữ thì vẫn là tạm, và sẽ được dọn ở đây.
 */

// Bản ghi tạm sống bao lâu trước khi bị xoá.
//
// 24 giờ chứ không phải vài phút: học viên hoàn toàn có thể để tab mở, đi ăn
// trưa, rồi về học tiếp. Xoá sớm là xoá mất ghi âm của người đang học dở.
const PROVISIONAL_TTL_MS = Number(process.env.PRACTICE_PROVISIONAL_TTL_MS) || 24 * 60 * 60 * 1000

// Mỗi vòng nén tối đa bao nhiêu file. Nén là việc tốn CPU; giới hạn lại để
// không giành hết máy chủ với việc chấm điểm đang chạy.
const COMPRESS_BATCH = Number(process.env.PRACTICE_COMPRESS_BATCH) || 50

// AAC 32 kbps. Chọn AAC chứ không chọn Opus (nhỏ hơn nữa) vì Safari trên iOS
// hỗ trợ Opus thất thường, mà một trong hai mục đích của việc giữ ghi âm là
// để chính học viên nghe lại — phần lớn bằng iPhone.
const AUDIO_BITRATE = process.env.PRACTICE_AUDIO_BITRATE || '32k'

let ffmpegMissingLogged = false

/** Chuyển một file WAV sang m4a. Trả null nếu không nén được. */
function convertToM4a(absoluteWav) {
    return new Promise((resolve) => {
        const absoluteOut = absoluteWav.replace(/\.wav$/i, '.m4a')
        const proc = spawn('ffmpeg', [
            '-v', 'error',
            '-y',
            '-i', absoluteWav,
            '-c:a', 'aac',
            '-b:a', AUDIO_BITRATE,
            absoluteOut,
        ])

        let stderrTail = ''
        proc.stderr.on('data', (c) => {
            stderrTail = (stderrTail + c.toString()).slice(-500)
        })

        proc.on('error', (err) => {
            // Máy chủ chưa cài ffmpeg — giữ nguyên WAV, KHÔNG được coi là lỗi
            // chặn. Cùng cách xử lý như videoProcessor.js.
            if (!ffmpegMissingLogged) {
                console.warn('[practiceCleanup] Không chạy được ffmpeg, giữ nguyên WAV:', err.message)
                ffmpegMissingLogged = true
            }
            resolve(null)
        })

        proc.on('close', (code) => {
            if (code !== 0) {
                console.error('[practiceCleanup] ffmpeg lỗi, code:', code, '|', stderrTail)
                fs.promises.unlink(absoluteOut).catch(() => { })
                resolve(null)
                return
            }
            resolve(absoluteOut)
        })
    })
}

/**
 * 1. Xoá bản ghi tạm quá hạn, kèm file ghi âm.
 *
 * @param {boolean} dryRun  chỉ đếm, không xoá gì. Dùng để xem trước — LẦN CHẠY
 *   ĐẦU sau khi triển khai sẽ gặp toàn bộ bản ghi cũ có từ trước tính năng này
 *   (chúng đều mang lessonAttempt = null vì trường đó mới thêm), và quét sạch
 *   chúng. Xem trước rồi hãy bật.
 * @param {ObjectId} student  giới hạn trong một học viên.
 *
 *   KHÔNG CÓ THAM SỐ NÀY THÌ HÀM CHẠY TRÊN TOÀN BỘ CƠ SỞ DỮ LIỆU. Đó là đúng
 *   với tác vụ nền, nhưng là bẫy với script kiểm thử: một lần gọi không giới
 *   hạn trong smoke test đã xoá mất 111 bản ghi có sẵn của máy phát triển.
 *   Mọi chỗ gọi vì mục đích kiểm thử BẮT BUỘC truyền `student`.
 */
async function deleteExpiredProvisional({
    ttlMs = PROVISIONAL_TTL_MS,
    dryRun = false,
    student = null,
} = {}) {
    const cutoff = new Date(Date.now() - ttlMs)
    const stale = await PracticeAttempt.find({
        lessonAttempt: null,
        createdAt: { $lt: cutoff },
        ...(student ? { student } : {}),
    })
        .select('audioPath')
        .lean()

    if (stale.length === 0) return { deleted: 0, bytesFreed: 0 }

    if (dryRun) {
        let bytes = 0
        for (const a of stale) {
            const abs = a.audioPath && resolveStoragePath(a.audioPath)
            if (!abs) continue
            try { bytes += (await fs.promises.stat(abs)).size } catch (e) { /* bỏ qua */ }
        }
        return { deleted: stale.length, bytesFreed: bytes, dryRun: true }
    }

    let bytesFreed = 0
    for (const a of stale) {
        const abs = a.audioPath && resolveStoragePath(a.audioPath)
        if (abs) {
            // Đo trước khi xoá, để báo cáo nói được con số thật.
            try {
                bytesFreed += (await fs.promises.stat(abs)).size
            } catch (e) { /* file đã biến mất, không sao */ }
        }
        await deletePracticeAudio(a.audioPath)
    }
    await PracticeAttempt.deleteMany({ _id: { $in: stale.map((a) => a._id) } })

    return { deleted: stale.length, bytesFreed }
}

/** 2. Nén các bản ghi đã giữ còn ở dạng WAV. */
async function compressKeptAudio({ limit = COMPRESS_BATCH, student = null } = {}) {
    const pending = await PracticeAttempt.find({
        lessonAttempt: { $ne: null },
        audioFormat: 'wav',
        audioPath: { $ne: '' },
        ...(student ? { student } : {}),
    })
        .select('audioPath')
        .limit(limit)
        .lean()

    let converted = 0
    let bytesSaved = 0

    for (const a of pending) {
        const absWav = resolveStoragePath(a.audioPath)
        if (!absWav || !fs.existsSync(absWav)) {
            // File đã mất nhưng bản ghi còn — đánh dấu để vòng sau khỏi thử lại mãi.
            await PracticeAttempt.updateOne({ _id: a._id }, { $set: { audioPath: '' } })
            continue
        }

        const before = (await fs.promises.stat(absWav)).size
        const absOut = await convertToM4a(absWav)
        if (!absOut) return { converted, bytesSaved, stopped: true } // ffmpeg hỏng -> dừng cả vòng

        const after = (await fs.promises.stat(absOut)).size
        const relativeOut = path.relative(STORAGE_ROOT, absOut)

        // THỨ TỰ: ghi file mới -> cập nhật DB -> xoá file cũ.
        //
        // Chết máy giữa chừng thì tệ nhất là thừa một file m4a chưa ai trỏ tới
        // (vòng quét mồ côi sẽ dọn), còn bản ghi vẫn trỏ vào WAV đang có thật.
        // Làm ngược lại là có lúc DB trỏ vào file chưa tồn tại.
        await PracticeAttempt.updateOne(
            { _id: a._id },
            { $set: { audioPath: relativeOut, audioFormat: 'm4a', audioBytes: after } }
        )
        await fs.promises.unlink(absWav).catch(() => { })

        converted++
        bytesSaved += before - after
    }

    return { converted, bytesSaved, stopped: false }
}

/**
 * 3. Quét file mồ côi: còn trên đĩa nhưng không bản ghi nào trỏ tới.
 *
 * Sinh ra từ các lỗi nửa chừng (xoá bản ghi xong thì chết máy trước khi xoá
 * file). Nếu không quét thì chúng nằm đó vĩnh viễn và không ai biết.
 *
 * CHỈ ĐỘNG VÀO FILE ĐÃ CŨ. File vừa tạo vài giây trước có thể đang trên đường
 * được ghi vào DB — xoá nó là xoá bản ghi âm của học viên đang luyện.
 *
 * `student` giới hạn vào đúng thư mục của một người — xem cảnh báo ở
 * deleteExpiredProvisional về việc gọi không giới hạn trong script kiểm thử.
 */
async function sweepOrphanFiles({ minAgeMs = PROVISIONAL_TTL_MS, student = null } = {}) {
    const root = path.join(STORAGE_ROOT, 'practice')
    if (!fs.existsSync(root)) return { deleted: 0, bytesFreed: 0 }

    const referenced = new Set(
        (
            await PracticeAttempt.find({ audioPath: { $ne: '' } }).select('audioPath').lean()
        ).map((a) => a.audioPath)
    )

    const cutoff = Date.now() - minAgeMs
    let deleted = 0
    let bytesFreed = 0

    const dirs = await fs.promises.readdir(root, { withFileTypes: true })
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        if (student && dir.name !== String(student)) continue
        const dirAbs = path.join(root, dir.name)
        for (const name of await fs.promises.readdir(dirAbs)) {
            const abs = path.join(dirAbs, name)
            const relative = path.relative(STORAGE_ROOT, abs)
            if (referenced.has(relative)) continue

            const stat = await fs.promises.stat(abs).catch(() => null)
            if (!stat || !stat.isFile() || stat.mtimeMs > cutoff) continue

            await fs.promises.unlink(abs).catch(() => { })
            deleted++
            bytesFreed += stat.size
        }
    }

    return { deleted, bytesFreed }
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

async function runMaintenance({ quiet = false, dryRun = false } = {}) {
    const expired = await deleteExpiredProvisional({ dryRun })
    // Nén và quét mồ côi đều chạm vào đĩa, nên chạy thử thì bỏ qua hẳn.
    const compressed = dryRun
        ? { converted: 0, bytesSaved: 0, stopped: false }
        : await compressKeptAudio()
    const orphans = dryRun ? { deleted: 0, bytesFreed: 0 } : await sweepOrphanFiles()

    if (!quiet) {
        const parts = []
        if (expired.deleted) parts.push(`xoá ${expired.deleted} bản ghi tạm (${mb(expired.bytesFreed)} MB)`)
        if (compressed.converted) parts.push(`nén ${compressed.converted} file (tiết kiệm ${mb(compressed.bytesSaved)} MB)`)
        if (orphans.deleted) parts.push(`dọn ${orphans.deleted} file mồ côi (${mb(orphans.bytesFreed)} MB)`)
        if (parts.length > 0) console.log('[practiceCleanup]', parts.join(', '))
    }

    return { expired, compressed, orphans }
}

/**
 * Chạy ngầm theo chu kỳ, gọi từ server.js.
 *
 * Dùng setInterval trong tiến trình thay vì cron ngoài: dự án deploy bằng
 * Docker một container, thêm cron là thêm một thứ phải cài và phải nhớ. Đổi
 * lại, chạy nhiều bản sao container thì mỗi bản đều dọn — các thao tác ở đây
 * đều idempotent nên không hỏng, chỉ là làm thừa.
 */
function startMaintenanceLoop(intervalMs = Number(process.env.PRACTICE_CLEANUP_INTERVAL_MS) || 30 * 60 * 1000) {
    const tick = () => {
        runMaintenance().catch((err) =>
            console.error('[practiceCleanup] Lỗi khi dọn:', err.message)
        )
    }
    // Chạy một lần sau khi khởi động xong, đừng chen vào lúc đang nạp.
    setTimeout(tick, 60 * 1000)
    const timer = setInterval(tick, intervalMs)
    timer.unref?.() // không giữ tiến trình sống chỉ vì cái hẹn giờ này
    return timer
}

module.exports = {
    PROVISIONAL_TTL_MS,
    deleteExpiredProvisional,
    compressKeptAudio,
    sweepOrphanFiles,
    runMaintenance,
    startMaintenanceLoop,
}
