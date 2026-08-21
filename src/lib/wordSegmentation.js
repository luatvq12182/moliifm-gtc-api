/**
 * Gom các CHỮ mà iFLYTEK trả về thành TỪ.
 *
 * VÌ SAO CẦN:
 * iFLYTEK chấm và trả kết quả theo từng chữ Hán một. Nhưng chấm ở mức chữ tạo
 * ra rất nhiều báo sai oan, và tập trung vào đúng một chỗ: ÂM TIẾT THANH NHẸ
 * (轻声) — âm tiết thứ hai của từ song âm tiết.
 *
 * Ví dụ thật lấy từ dữ liệu luyện nói:
 *   什 shen2  -> đúng          名 ming2 -> đúng
 *   么 me5    -> BÁO SAI       字 zi9   -> BÁO SAI
 *
 * 么 trong 什么 và 字 trong 名字 đều là thanh nhẹ: đọc ngắn, nhẹ, âm sắc mờ đi
 * — bản chất của thanh nhẹ là như vậy, người bản xứ cũng đọc thế. Máy so với
 * âm tiết đọc đầy đủ nên báo sai. Gom 什么 và 名字 thành MỘT đơn vị thì lỗi này
 * tự tan.
 *
 * Ngoài ra học viên học theo TỪ chứ không theo chữ rời: "luyện lại từ 什么" là
 * lời khuyên dùng được, còn "chữ 么 sai thanh mẫu" thì không.
 *
 * ---------------------------------------------------------------------------
 * CÁCH PHÂN TỪ: dùng chính phiên âm của bài học.
 *
 * Chính tả pinyin viết liền các âm tiết trong cùng một từ và tách các từ bằng
 * dấu cách — nghĩa là NGƯỜI SOẠN BÀI đã phân từ sẵn cho ta rồi:
 *
 *   你好！你叫什么名字？  <->  Nǐ hǎo! Nǐ jiào shénme míngzi?
 *   8 chữ Hán                 Nǐ|hǎo|Nǐ|jiào|shénme|míngzi = 1+1+1+1+2+2 = 8
 *
 * Đếm số âm tiết trong mỗi token pinyin là biết mỗi từ gồm mấy chữ. Cách này
 * chính xác hơn mọi thư viện phân từ tự động, vì nó phản ánh đúng ý người soạn.
 *
 * AN TOÀN: nếu tổng số âm tiết KHÔNG khớp số chữ iFLYTEK trả về thì tuyệt đối
 * không gom bừa — lùi về phương án dự phòng. Gom lệch còn tệ hơn không gom.
 */

// Nguyên âm pinyin, kể cả dạng có dấu thanh.
const VOWELS = new Set('aeiouüvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ'.split(''))

/**
 * Đếm số âm tiết trong một token pinyin bằng cách đếm các CỤM nguyên âm liền
 * nhau. Mỗi âm tiết tiếng Trung có đúng một cụm nguyên âm làm hạt nhân.
 *
 *   jiào      -> "iào" là 1 cụm            -> 1 âm tiết
 *   shénme    -> "é" và "e"                -> 2 âm tiết
 *   zěnmeyàng -> "ě", "e", "à"             -> 3 âm tiết
 *   nǚ'ér     -> "ǚ" và "é" (dấu ' ngắt)   -> 2 âm tiết
 */
function countSyllables(token) {
    let count = 0
    let inVowelRun = false
    for (const ch of token.toLowerCase()) {
        const isVowel = VOWELS.has(ch)
        if (isVowel && !inVowelRun) count++
        inVowelRun = isVowel
    }
    // Token không có nguyên âm (vd. 嗯 "n", "hm") vẫn là 1 âm tiết.
    return count > 0 ? count : 1
}

// Tách chuỗi pinyin thành các token là từ. Dấu câu và khoảng trắng đều là ranh
// giới; dấu nháy đơn thì KHÔNG (nó nằm trong từ, vd. nǚ'ér).
function tokenizePinyin(pinyin) {
    return (pinyin || '')
        .split(/[^A-Za-zÀ-ÿüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ']+/)
        .map((t) => t.replace(/^'+|'+$/g, ''))
        .filter((t) => t.length > 0)
}

/**
 * Phiên âm trong dữ liệu bài học thường có tiền tố tên người nói
 * ("Zhāng lǎoshī: Nǐ hǎo!") trong khi trường chữ Hán thì không.
 *
 * KHÔNG cắt mù ở dấu hai chấm đầu tiên: có câu bản thân nó chứa dấu hai chấm
 * ("我家有三口人:我爸爸..."). Thay vào đó trả về CẢ HAI phương án rồi để hàm gọi
 * chọn phương án nào khớp số chữ — tự kiểm chứng, không phải đoán.
 */
function pinyinCandidates(pinyin) {
    const raw = (pinyin || '').trim()
    if (!raw) return []
    const candidates = [raw]
    const colonIndex = raw.search(/[:：]/)
    if (colonIndex > -1 && colonIndex < raw.length - 1) {
        candidates.push(raw.slice(colonIndex + 1).trim())
    }
    return candidates
}

// Thanh nhẹ: iFLYTEK đánh số 5 hoặc 9 ở cuối phiên âm (vd. me5, zi9).
function isNeutralTone(charPinyin) {
    return /[59]$/.test(charPinyin || '')
}

/**
 * Phương án DỰ PHÒNG khi không dùng được phiên âm bài học: dồn âm tiết thanh
 * nhẹ vào chữ đứng trước nó.
 *
 * Không đầy đủ bằng phân từ thật, nhưng xử lý được đúng nhóm gây báo sai nhiều
 * nhất — vì thanh nhẹ trong tiếng Trung gần như không bao giờ đứng đầu từ, nó
 * luôn bám vào âm tiết phía trước.
 */
function groupByNeutralTone(chars) {
    const groups = []
    chars.forEach((c, i) => {
        if (i > 0 && isNeutralTone(c.pinyin) && groups.length > 0) {
            groups[groups.length - 1].push(c)
        } else {
            groups.push([c])
        }
    })
    return groups
}

/**
 * chars: [{ content, pinyin, issue, ok }] theo thứ tự iFLYTEK trả về
 * referencePinyin: chuỗi phiên âm của câu mẫu trong dữ liệu bài học
 *
 * Trả về { groups, method } với groups là mảng các mảng chữ.
 * method: 'pinyin' (tin cậy nhất) | 'neutral-tone' (dự phòng) | 'per-char'
 */
function groupCharsIntoWords(chars, referencePinyin) {
    if (!Array.isArray(chars) || chars.length === 0) {
        return { groups: [], method: 'per-char' }
    }

    for (const candidate of pinyinCandidates(referencePinyin)) {
        const tokens = tokenizePinyin(candidate)
        if (tokens.length === 0) continue

        const sizes = tokens.map(countSyllables)
        const totalSyllables = sizes.reduce((sum, n) => sum + n, 0)

        // Chốt an toàn: chỉ gom khi tổng âm tiết khớp CHÍNH XÁC số chữ.
        if (totalSyllables !== chars.length) continue

        const groups = []
        let cursor = 0
        for (const size of sizes) {
            groups.push(chars.slice(cursor, cursor + size))
            cursor += size
        }
        return { groups, method: 'pinyin' }
    }

    const groups = groupByNeutralTone(chars)
    return {
        groups,
        method: groups.length < chars.length ? 'neutral-tone' : 'per-char',
    }
}

module.exports = { groupCharsIntoWords, countSyllables, tokenizePinyin, isNeutralTone }
