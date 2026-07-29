const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

// Quản lý các job nén video chạy ngầm. Lưu trạng thái trong bộ nhớ (RAM) —
// đủ dùng cho quy mô hiện tại (1 admin upload); nếu server restart giữa
// chừng, job đang chạy sẽ mất trạng thái nhưng file gốc vẫn còn nguyên,
// admin chỉ cần upload lại.
const jobs = new Map() // jobId -> { status: 'processing'|'done'|'error', url, error }

function getJob(jobId) {
    return jobs.get(jobId) || null
}

// Nén video về 1080p H.264 Main profile — cấu hình đã kiểm chứng khắc phục
// lỗi giật trên Safari/WebKit khi phát tốc độ cao (video AI gốc thường là
// 4K bitrate ~24Mbps quá nặng để giải mã nhanh).
// preset "fast" thay vì "slow": VPS CPU yếu, ưu tiên nén xong nhanh (vài
// phút) hơn là tối ưu thêm vài % dung lượng.
function compressVideo(jobId, inputPath) {
    const dir = path.dirname(inputPath)
    const ext = '.mp4'
    const base = path.basename(inputPath, path.extname(inputPath))
    const tmpOutput = path.join(dir, `${base}.compressing${ext}`)
    const finalOutput = path.join(dir, `${base}${ext}`)

    jobs.set(jobId, { status: 'processing', url: null, error: null })

    const args = [
        '-y',
        '-i', inputPath,
        '-vf', "scale='min(1920,iw)':-2",
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-level', '4.0',
        '-preset', 'fast',
        '-crf', '23',
        '-bf', '2',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        tmpOutput,
    ]

    const proc = spawn('ffmpeg', args)

    let stderrTail = ''
    proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    proc.on('error', (err) => {
        // ffmpeg không tồn tại trong môi trường chạy — giữ nguyên file gốc,
        // báo done kèm cảnh báo để không chặn admin làm việc.
        console.error('[videoProcessor] Không chạy được ffmpeg:', err.message)
        jobs.set(jobId, {
            status: 'done',
            url: `/uploads/videos/${path.basename(inputPath)}`,
            error: 'Server chưa cài ffmpeg — video được giữ nguyên bản gốc, chưa nén.',
        })
    })

    proc.on('close', (code) => {
        if (code !== 0) {
            console.error('[videoProcessor] ffmpeg lỗi, code:', code, '| stderr:', stderrTail)
            fs.promises.unlink(tmpOutput).catch(() => { })
            // Nén lỗi -> vẫn dùng file gốc, không chặn công việc của admin
            jobs.set(jobId, {
                status: 'done',
                url: `/uploads/videos/${path.basename(inputPath)}`,
                error: 'Nén video thất bại — hệ thống dùng bản gốc chưa nén.',
            })
            return
        }

        // Nén xong: thay file gốc bằng file đã nén (đổi tên đè), URL cuối cùng
        // luôn có đuôi .mp4 kể cả khi admin upload .mov/.webm
        fs.promises
            .rename(tmpOutput, finalOutput)
            .then(() => {
                if (finalOutput !== inputPath) {
                    return fs.promises.unlink(inputPath).catch(() => { })
                }
            })
            .then(() => {
                jobs.set(jobId, {
                    status: 'done',
                    url: `/uploads/videos/${path.basename(finalOutput)}`,
                    error: null,
                })
            })
            .catch((err) => {
                console.error('[videoProcessor] Lỗi thay file sau nén:', err)
                jobs.set(jobId, {
                    status: 'done',
                    url: `/uploads/videos/${path.basename(inputPath)}`,
                    error: 'Không thay được file sau nén — hệ thống dùng bản gốc.',
                })
            })
    })
}

module.exports = { compressVideo, getJob }