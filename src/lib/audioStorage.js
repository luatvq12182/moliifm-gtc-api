/**
 * Lưu bản ghi âm luyện nói ra đĩa dưới dạng file WAV.
 *
 * VỊ TRÍ LƯU: storage/practice/<studentId>/<tên file>.wav
 *
 * CỐ Ý ĐỂ NGOÀI thư mục uploads/. app.js đang mở uploads/ ra công khai bằng
 * express.static — bất kỳ ai đoán đúng URL đều tải được file trong đó. Giọng
 * nói học viên là dữ liệu cá nhân nên phải nằm ngoài, chỉ đọc được qua route
 * có protectAdmin.
 */

const fs = require('fs')
const path = require('path')

const STORAGE_ROOT = path.join(__dirname, '../../storage')
const PRACTICE_DIR = path.join(STORAGE_ROOT, 'practice')

const SAMPLE_RATE = 16000
const BITS_PER_SAMPLE = 16
const CHANNELS = 1

/**
 * Dựng header WAV 44 byte cho dữ liệu PCM thô (little-endian, có dấu).
 * Nhờ header này file mở được bằng mọi trình phát và bằng thẻ <audio> trên web,
 * thay vì là một đống byte không ai đọc được.
 */
function buildWavHeader(dataLength, sampleRate = SAMPLE_RATE) {
    const header = Buffer.alloc(44)
    const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8
    const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8

    header.write('RIFF', 0)
    header.writeUInt32LE(36 + dataLength, 4) // kích thước file trừ 8 byte đầu
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // độ dài khối fmt
    header.writeUInt16LE(1, 20) // 1 = PCM không nén
    header.writeUInt16LE(CHANNELS, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(BITS_PER_SAMPLE, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataLength, 40)

    return header
}

function pcmToWav(pcmBuffer, sampleRate = SAMPLE_RATE) {
    return Buffer.concat([buildWavHeader(pcmBuffer.length, sampleRate), pcmBuffer])
}

function durationMsOf(pcmBuffer, sampleRate = SAMPLE_RATE) {
    const bytesPerSample = (BITS_PER_SAMPLE / 8) * CHANNELS
    return Math.round((pcmBuffer.length / bytesPerSample / sampleRate) * 1000)
}

/**
 * Ghi buffer PCM thành file WAV. Trả về đường dẫn TƯƠNG ĐỐI tính từ storage/
 * (vd. "practice/665f.../1712345678-123.wav") để lưu vào DB — không lưu đường
 * dẫn tuyệt đối, tránh hỏng khi đổi máy chủ hoặc chạy trong Docker.
 */
async function savePracticeAudio(studentId, pcmBuffer, sampleRate = SAMPLE_RATE) {
    const dir = path.join(PRACTICE_DIR, String(studentId))
    await fs.promises.mkdir(dir, { recursive: true })

    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.wav`
    const absolutePath = path.join(dir, filename)
    await fs.promises.writeFile(absolutePath, pcmToWav(pcmBuffer, sampleRate))

    return {
        relativePath: path.posix.join('practice', String(studentId), filename),
        bytes: pcmBuffer.length + 44,
        durationMs: durationMsOf(pcmBuffer, sampleRate),
    }
}

/**
 * Đổi đường dẫn tương đối trong DB thành đường dẫn tuyệt đối trên đĩa, CÓ kiểm
 * tra chống path traversal: kết quả bắt buộc phải nằm trong storage/. Nếu không
 * kiểm tra, một giá trị audioPath độc hại kiểu "../../.env" sẽ đọc được file
 * bất kỳ trên máy chủ.
 */
function resolveStoragePath(relativePath) {
    const absolutePath = path.resolve(STORAGE_ROOT, relativePath)
    const root = path.resolve(STORAGE_ROOT)
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
        return null
    }
    return absolutePath
}

async function deletePracticeAudio(relativePath) {
    if (!relativePath) return
    const absolutePath = resolveStoragePath(relativePath)
    if (!absolutePath) return
    await fs.promises.unlink(absolutePath).catch(() => { })
}

module.exports = {
    STORAGE_ROOT,
    SAMPLE_RATE,
    pcmToWav,
    durationMsOf,
    savePracticeAudio,
    resolveStoragePath,
    deletePracticeAudio,
}
