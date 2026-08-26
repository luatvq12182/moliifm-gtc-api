/**
 * Cắt bớt khoảng lặng ở đầu và cuối đoạn ghi âm, TRƯỚC KHI gửi lên iFLYTEK.
 *
 * VÌ SAO CẦN:
 * XML thật cho thấy bộ căn chỉnh của iFLYTEK bị lệch khi đầu file có nhiều
 * khoảng lặng. Ví dụ đo được (24/08/2026):
 *
 *   sil    0 → 107   (1.070ms im lặng)
 *   你    107 → 130   (230ms)
 *   好    130 → 140   (100ms)  <- phone h chỉ 40ms, ao 60ms
 *
 * Cả cụm 你好 bị nhét vào 330ms, trong khi bình thường phải 600-800ms. Với
 * 100ms thì chữ 好 gần như không đủ tín hiệu để chấm, và quả nhiên nó bị báo
 * sai cả ba trục còn <sentence content="你好"> chỉ được phone_score=50.
 * Phần sau của câu, nơi không có khoảng lặng dài, được phone_score=83.
 *
 * Đây là lỗi CĂN CHỈNH chứ không phải lỗi phát âm.
 *
 * NGUYÊN TẮC AN TOÀN: cắt hụt mất phụ âm đầu còn tệ hơn nhiều so với để thừa
 * khoảng lặng. Nên hàm này chừa lại một khoảng đệm rộng rãi và từ chối cắt
 * trong mọi trường hợp đáng ngờ (audio quá nhỏ, kết quả quá ngắn...).
 *
 * ===========================================================================
 * KHÔNG DÙNG TRONG LUỒNG CHẠY THẬT — ĐÃ ĐO VÀ THẤY KHÔNG ĂN THUA
 * ===========================================================================
 *
 * Đo A/B trên 3 file ghi âm thật (24/08/2026), gửi cùng một đoạn lên iFLYTEK
 * ở hai dạng cắt và không cắt:
 *
 *   今天天气很好啊…   không cắt: phát âm 96, 1 chữ gắn cờ
 *                     ĐÃ CẮT   : phát âm 89, 3 chữ gắn cờ   <- TỆ ĐI RÕ RỆT
 *   大卫… (đọc sai)   không cắt: phát âm 89  |  đã cắt: 94   <- khá hơn chút
 *   大卫… (đọc chuẩn) không cắt: phát âm 100 |  đã cắt: 100  <- không đổi
 *
 * Không có cải thiện nhất quán, lại có một lần hỏng hẳn. Giả thuyết hợp lý
 * nhất: iFLYTEK DÙNG chính khoảng lặng đầu/cuối để chuẩn hoá nền nhiễu và
 * neo bộ căn chỉnh. Cắt đi là lấy mất điểm tựa của nó — đúng các âm tiết ĐẦU
 * và CUỐI câu (今, 服) là những chữ bị gắn cờ thêm sau khi cắt.
 *
 * Giữ lại file này để lưu kết quả đo, tránh có người thấy khoảng lặng dài rồi
 * lại đi làm lại từ đầu. Muốn thử lại thì phải đo A/B, đừng bật thẳng.
 */

const BYTES_PER_SAMPLE = 2 // PCM 16-bit mono

// Cửa sổ phân tích. 20ms đủ mịn để bắt đúng thời điểm bắt đầu nói.
const WINDOW_MS = 20

// Khoảng đệm giữ lại hai đầu. Phụ âm bật hơi (p/t/k/q/ch) có phần câm rất nhẹ
// đứng trước tiếng nổ; cắt sát quá là mất luôn phụ âm đầu. 150ms là rộng rãi.
const PADDING_MS = 150

// Không cắt nếu phần còn lại ngắn hơn mức này — dấu hiệu có gì đó sai.
const MIN_RESULT_MS = 300

// Biên độ đỉnh tối thiểu để coi là "có tiếng nói". Dưới ngưỡng này thì toàn bộ
// file gần như im lặng, cắt sẽ hỏng -> giữ nguyên.
const MIN_PEAK = 0.02 // ~ -34 dBFS

function rmsOfWindow(pcm, startByte, endByte) {
    let sum = 0
    let n = 0
    for (let i = startByte; i + 1 < endByte; i += BYTES_PER_SAMPLE) {
        const v = pcm.readInt16LE(i) / 32768
        sum += v * v
        n++
    }
    return n > 0 ? Math.sqrt(sum / n) : 0
}

/**
 * pcm: Buffer PCM 16-bit little-endian, mono.
 * Trả về { pcm, trimmedLeadMs, trimmedTailMs, trimmed }.
 * Khi không cắt được an toàn thì trả lại nguyên buffer gốc.
 */
function trimSilence(pcm, sampleRate = 16000) {
    const unchanged = { pcm, trimmedLeadMs: 0, trimmedTailMs: 0, trimmed: false }

    const windowBytes = Math.floor((sampleRate * WINDOW_MS) / 1000) * BYTES_PER_SAMPLE
    if (!pcm || pcm.length < windowBytes * 4) return unchanged

    const levels = []
    for (let off = 0; off + windowBytes <= pcm.length; off += windowBytes) {
        levels.push(rmsOfWindow(pcm, off, off + windowBytes))
    }
    if (levels.length < 4) return unchanged

    const peak = Math.max(...levels)
    if (peak < MIN_PEAK) return unchanged // gần như im lặng toàn bộ -> không đụng vào

    // Nền nhiễu = phân vị 20 của các cửa sổ. Dùng phân vị chứ không dùng giá trị
    // nhỏ nhất, để một cửa sổ câm tuyệt đối không kéo ngưỡng xuống quá thấp.
    const sorted = [...levels].sort((a, b) => a - b)
    const noiseFloor = sorted[Math.floor(sorted.length * 0.2)]

    // Ngưỡng phải vượt hẳn nền nhiễu, đồng thời không được quá gần đỉnh (tránh
    // cắt mất phần đầu câu vốn thường nhẹ hơn phần giữa).
    const threshold = Math.max(noiseFloor * 4, peak * 0.03)

    let first = levels.findIndex((v) => v > threshold)
    let last = -1
    for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i] > threshold) {
            last = i
            break
        }
    }
    if (first === -1 || last === -1 || last < first) return unchanged

    const padWindows = Math.ceil(PADDING_MS / WINDOW_MS)
    first = Math.max(0, first - padWindows)
    last = Math.min(levels.length - 1, last + padWindows)

    const startByte = first * windowBytes
    const endByte = Math.min(pcm.length, (last + 1) * windowBytes)

    const resultMs = ((endByte - startByte) / BYTES_PER_SAMPLE / sampleRate) * 1000
    if (resultMs < MIN_RESULT_MS) return unchanged

    const trimmedLeadMs = Math.round((startByte / BYTES_PER_SAMPLE / sampleRate) * 1000)
    const trimmedTailMs = Math.round(((pcm.length - endByte) / BYTES_PER_SAMPLE / sampleRate) * 1000)
    if (trimmedLeadMs === 0 && trimmedTailMs === 0) return unchanged

    return {
        pcm: pcm.subarray(startByte, endByte),
        trimmedLeadMs,
        trimmedTailMs,
        trimmed: true,
    }
}

module.exports = { trimSilence, WINDOW_MS, PADDING_MS }
