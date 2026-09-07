/**
 * Nhận ra những chỗ mà cách phân từ của ta TÁCH RỜI một từ ghép có thật.
 *
 * BỐI CẢNH: wordSegmentation.js phân từ theo dấu cách trong phiên âm bài học —
 * cách đó phản ánh đúng ý người soạn và chính xác hơn mọi thư viện tự động.
 * Nhưng chính tả pinyin đôi khi tách cái mà từ vựng coi là một từ:
 *
 *   您好！  <->  "Nín hǎo!"   -> hai token -> hai ô chữ: 您 | 好
 *
 * Khách hàng (cử nhân tiếng Trung) phản hồi: học viên cần nghe được 您好 đọc
 * LIỀN như một lời chào, chứ nghe 您 rồi 好 rời nhau không ra cách người ta nói.
 *
 * CHỦ Ý: đây là lớp PHỦ THÊM, không thay thế cách phân từ.
 * Yêu cầu của khách là "2 chữ riêng xong 1 từ ghép lại đầy đủ" — giữ nguyên các
 * ô chữ để luyện từng chữ, và BỔ SUNG một ô nghe cả từ. Ngoài ra việc xếp loại
 * good/fair/weak đã qua nhiều vòng chỉnh cho khớp giữa màu cụm và màu từng chữ
 * (xem wordFeedback.js); gộp ô lại sẽ làm xáo trộn toàn bộ chuyện đó mà không
 * đổi lại được gì.
 */

const fs = require('fs')
const path = require('path')

// Gộp tối đa 3 ô liền nhau, và không quá 4 chữ Hán. Nới rộng hơn thì bắt đầu
// gom trúng những cụm chỉ TÌNH CỜ tạo thành một mục từ điển.
const MAX_SPAN = 3
const MAX_CHARS = 4

let dictionary = null

function loadDictionary() {
    if (dictionary) return dictionary
    dictionary = new Set()
    try {
        const file = path.join(__dirname, '..', 'data', 'compounds.txt')
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const word = line.trim()
            if (word && word[0] !== '#') dictionary.add(word)
        }
    } catch (err) {
        // Thiếu từ điển thì chỉ mất tính năng nghe từ ghép, KHÔNG được làm hỏng
        // việc chấm điểm — đó mới là chức năng chính.
        console.warn('[compoundWords] Không đọc được từ điển từ ghép:', err.message)
    }
    return dictionary
}

/**
 * words: mảng từ đã gom (mỗi phần tử có .content và .chars)
 * referenceText: nguyên văn chữ Hán của câu mẫu
 *
 * Trả về [{ start, span, content, pinyin }] — start/span trỏ vào mảng words.
 * Các vùng KHÔNG chồng lấn nhau.
 */
function findCompounds(words, referenceText) {
    if (!Array.isArray(words) || words.length < 2) return []
    const dict = loadDictionary()
    if (dict.size === 0) return []

    const text = typeof referenceText === 'string' ? referenceText : ''
    const compounds = []
    let i = 0

    while (i < words.length) {
        let hit = null

        // Thử vùng DÀI trước: nếu cả 怎么样 lẫn 怎么 đều có trong từ điển thì lấy
        // cái dài hơn, vì nó mới là từ mà người ta thực sự nói.
        for (let span = Math.min(MAX_SPAN, words.length - i); span >= 2; span--) {
            const part = words.slice(i, i + span)
            const content = part.map((w) => w.content).join('')

            if (content.length > MAX_CHARS) continue
            if (!dict.has(content)) continue

            // CHỐT CHẶN DẤU CÂU: hai từ đứng hai bên dấu phẩy thì trong câu gốc
            // chúng KHÔNG liền nhau, dù ghép chuỗi lại có thể trúng một mục từ
            // điển. Ví dụ "大卫，今天..." — không được phép gộp 大卫 với 今天.
            // iFLYTEK chỉ trả về chữ Hán (đã lược dấu câu) nên bản thân mảng
            // words không cho biết điều này; phải soi lại câu gốc.
            if (text && !text.includes(content)) continue

            hit = {
                start: i,
                span,
                content,
                pinyin: part.map((w) => w.pinyin).filter(Boolean).join(' '),
            }
            break
        }

        if (hit) {
            compounds.push(hit)
            i += hit.span
        } else {
            i += 1
        }
    }

    return compounds
}

module.exports = { findCompounds }
