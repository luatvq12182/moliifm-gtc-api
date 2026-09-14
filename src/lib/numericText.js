/**
 * Chuẩn bị câu mẫu trước khi gửi cho iFLYTEK chấm phát âm.
 *
 * VẤN ĐỀ: iFLYTEK TỪ CHỐI câu mẫu không có chữ Hán nào. Bài 4 có dòng thoại là
 * một số điện thoại trần — "2038559800。" — và mọi lượt luyện nói câu đó đều
 * chết với `SRecWrite error: iSEInputAppend error, ret=8195`.
 *
 * Đo được (gửi cùng một file audio, đổi mỗi câu mẫu):
 *     "2038559800。"            -> lỗi 8195
 *     "2038559800"              -> lỗi 8195
 *     "二零三八五五九八零零"      -> chấm được, 95.99 điểm
 *     "我的电话是2038559800。"   -> chấm được (có chữ Hán nên qua được)
 *
 * CÁCH ĐỌC SỐ PHỤ THUỘC NGỮ CẢNH, nên KHÔNG tự đoán:
 *     2038559800  ->  二零三八五五九八零零   (số điện thoại: đọc rời)
 *     800块       ->  八百块                (giá tiền: đọc thành số)
 *     215房间     ->  二幺五房间             (số phòng: đọc rời, 1 đọc là 幺)
 *
 * Nguồn đáng tin là PHIÊN ÂM của chính dòng thoại — người soạn bài đã ghi rõ
 * cách đọc. Chỉ khi không suy được từ phiên âm mới lùi về đọc rời từng số.
 *
 * CHỈ ĐỘNG VÀO CÂU KHÔNG CÓ CHỮ HÁN. Câu đã có chữ Hán thì iFLYTEK tự xử lý số
 * rất tốt (và đúng ngữ cảnh) — đo trên 15 dòng thoại còn lại đều khớp với phiên
 * âm bài học. Đụng vào là phá thứ đang chạy tốt.
 *
 * BẢN SAO Ở FRONTEND: gtc-fe/src/lib/numericText.js — trang quản trị cần cảnh
 * báo ngay lúc giảng viên gõ. Hai bản phải cho cùng kết quả; `npm run verify`
 * mục 7 đối chiếu chúng.
 */

const HAS_HAN = /[一-鿿]/

const DIGIT_HAN = {
    0: '零', 1: '一', 2: '二', 3: '三', 4: '四',
    5: '五', 6: '六', 7: '七', 8: '八', 9: '九',
}

// Âm tiết pinyin -> chữ số Hán. Gồm cả 幺 (cách đọc số 1 khi đọc rời từng chữ
// số: số điện thoại, số phòng) và 两 (dùng thay 二 trước lượng từ).
const PINYIN_HAN = {
    ling: '零', yi: '一', yao: '幺', er: '二', liang: '两',
    san: '三', si: '四', wu: '五', liu: '六',
    qi: '七', ba: '八', jiu: '九',
    shi: '十', bai: '百', qian: '千', wan: '万',
}

// Bỏ dấu thanh, về chữ thường: "Èr" -> "er", "líng" -> "ling".
function plainSyllable(token) {
    return token
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ü/gi, 'v')
        .toLowerCase()
}

// Các khoá của PINYIN_HAN, xếp DÀI TRƯỚC để khớp tham lam lấy được cụm dài nhất.
const PINYIN_KEYS = Object.keys(PINYIN_HAN).sort((a, b) => b.length - a.length)

/**
 * Tách một token pinyin thành các âm tiết CHỮ SỐ.
 *
 * Cần vì chính tả pinyin viết liền các âm tiết trong cùng một từ: "bābǎi" là
 * 八百 (hai âm tiết), tra nguyên cụm thì không thấy trong bảng và ta sẽ lùi về
 * đọc rời thành 八零零 — sai hẳn cách đọc giá tiền.
 *
 * Khớp tham lam, dài trước: "babai" -> "ba" + "bai" -> 八百.
 * Trả về '' nếu có đoạn không phải chữ số.
 */
function splitNumeralToken(plain) {
    let rest = plain
    let out = ''
    while (rest.length > 0) {
        const key = PINYIN_KEYS.find((k) => rest.startsWith(k))
        if (!key) return ''
        out += PINYIN_HAN[key]
        rest = rest.slice(key.length)
    }
    return out
}

/**
 * Suy cách đọc từ phiên âm. Trả về chuỗi chữ số Hán, hoặc '' nếu không suy được.
 *
 * Chỉ nhận khi MỌI âm tiết đều là chữ số — phiên âm còn lẫn chữ khác nghĩa là
 * nó không mô tả một dãy số thuần, lúc đó suy ra là sai.
 */
function readingFromPinyin(pinyin) {
    const raw = String(pinyin || '').trim()
    if (!raw) return ''

    // Phiên âm thường có tiền tố tên người nói: "Dàwèi: Èr líng sān..."
    const colon = raw.search(/[:：]/)
    const body = colon > -1 ? raw.slice(colon + 1) : raw

    const tokens = body.split(/[^A-Za-zÀ-ÿüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀǍĒĚĪǏŌǑŪǓǕǗǙǛ']+/).filter(Boolean)
    if (tokens.length === 0) return ''

    const out = []
    for (const token of tokens) {
        const han = splitNumeralToken(plainSyllable(token))
        if (!han) return '' // có âm tiết không phải số -> không dùng phiên âm
        out.push(han)
    }
    return out.join('')
}

/**
 * text: nguyên văn dòng thoại;  pinyin: phiên âm của chính dòng đó.
 *
 * Trả về { text, changed, source }
 *   text    — chuỗi nên gửi cho iFLYTEK
 *   changed — có phải đã đổi so với bản gốc không
 *   source  — 'pinyin' | 'digit' | '' (căn cứ nào để đổi)
 *
 * text rỗng nghĩa là không cứu được (không chữ Hán, cũng không chữ số) — chỗ
 * gọi nên báo lỗi tử tế thay vì ném cho iFLYTEK để nhận về mã lỗi khó hiểu.
 */
function toSpeakableText(text, pinyin) {
    const raw = String(text || '').trim()

    if (HAS_HAN.test(raw)) return { text: raw, changed: false, source: '' }
    if (!/[0-9]/.test(raw)) return { text: '', changed: false, source: '' }

    const fromPinyin = readingFromPinyin(pinyin)
    if (fromPinyin) return { text: fromPinyin, changed: true, source: 'pinyin' }

    const digits = raw.match(/[0-9]/g) || []
    return {
        text: digits.map((d) => DIGIT_HAN[d]).join(''),
        changed: true,
        source: 'digit',
    }
}

module.exports = { toSpeakableText, readingFromPinyin, HAS_HAN }
