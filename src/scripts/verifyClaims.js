/**
 * CHẠY LẠI TOÀN BỘ CÁC KHẲNG ĐỊNH ĐÃ ĐƯA RA, để đối chiếu.
 *
 *   npm run verify
 *
 * Mục đích: trong quá trình sửa module chấm phát âm đã có nhiều kết luận bị đảo
 * ngược. File này gom lại những gì ĐÃ CHỨNG MINH ĐƯỢC, dưới dạng KIỂM THỬ CHẠY
 * ĐƯỢC — không phải lời khẳng định trong tài liệu.
 *
 * Nếu một dòng báo LỆCH: hoặc code vừa bị sửa hỏng, hoặc khẳng định đó sai.
 * Cả hai trường hợp đều cần xem lại, đừng bỏ qua.
 *
 * Xem thêm docs/DOI-CHIEU.md để biết điều gì CHƯA chứng minh được.
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')

const TARGET_RATE = 16000
let pass = 0
let fail = 0

function check(label, actual, expected, note = '') {
    const ok = String(actual) === String(expected)
    ok ? pass++ : fail++
    console.log(
        `  ${ok ? '✓' : '✗ LỆCH'}  ${label.padEnd(46)} ${String(actual).padEnd(38)}` +
        (ok ? note : `  (mong đợi: ${expected})`)
    )
}

// Nạp parseIseXml (không được export ra ngoài) bằng bản sao tạm.
function loadParser() {
    const src = fs.readFileSync(path.join(__dirname, '../lib/iflytek.js'), 'utf8')
    const tmp = path.join(__dirname, '../lib/.iflytek-verify-tmp.js')
    fs.writeFileSync(
        tmp,
        src.replace(
            'module.exports = { isConfigured, assessAndRecognize }',
            'module.exports = { isConfigured, assessAndRecognize, parseIseXml }'
        )
    )
    const mod = require(tmp)
    fs.unlinkSync(tmp)
    return mod.parseIseXml
}

const phone = (c, isYun, level, perr) =>
    `<phone content="${c}" dp_message="0" is_yun="${isYun}" perr_level_msg="${level}" perr_msg="${perr}" rec_node_type="paper"/>`

function oneChar(parseIseXml, content, symbol, phones, syllDp = 0) {
    const xml =
        `<xml_result><read_sentence version="7"><rec_paper>` +
        `<read_sentence content="x" phone_score="80" tone_score="80" fluency_score="80" integrity_score="100" total_score="80" is_rejected="false">` +
        `<sentence content="x" rec_node_type="paper"><word content="${content}" symbol="${symbol}">` +
        `<syll content="${content}" dp_message="${syllDp}" rec_node_type="paper" symbol="${symbol}">${phones}</syll>` +
        `</word></sentence></read_sentence></rec_paper></read_sentence></xml_result>`
    return parseIseXml(xml).chars[0]
}

// ---------------------------------------------------------------------------
console.log('\n1. BỘ HẠ SAMPLE CŨ CÓ GÂY ALIASING KHÔNG?')
console.log('   (bằng chứng cho việc phải sửa downsampleToPCM16 ở gtc-fe)\n')
{
    const tone = (f, rate, n) => {
        const s = new Float32Array(n)
        for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * f * i) / rate)
        return s
    }
    const oldDownsample = (x, rate) => {
        const r = rate / TARGET_RATE
        const n = Math.floor(x.length / r)
        const o = new Float32Array(n)
        for (let i = 0; i < n; i++) o[i] = x[Math.floor(i * r)]
        return o
    }
    const magAt = (sig, f, rate) => {
        let re = 0
        let im = 0
        for (let i = 0; i < sig.length; i++) {
            const w = (2 * Math.PI * f * i) / rate
            re += sig[i] * Math.cos(w)
            im -= sig[i] * Math.sin(w)
        }
        return (2 * Math.hypot(re, im)) / sig.length
    }
    const alias = magAt(oldDownsample(tone(12000, 48000, 48000), 48000), 4000, TARGET_RATE)
    check('Tone 12kHz → biên độ giả tại 4kHz', alias.toFixed(2), '1.00', 'gập nguyên vẹn 100%')
}

// ---------------------------------------------------------------------------
console.log('\n2. PHÂN LOẠI LỖI CÓ BÁO ĐỦ CÁC TRỤC KHÔNG?')
console.log('   (XML dựng theo đúng cấu trúc quan sát được từ iFLYTEK thật)\n')
{
    const p = loadParser()
    check(
        '好: thanh mẫu + vận mẫu + thanh điệu',
        oneChar(p, '好', 'hao3', phone('h', 0, 3, 1) + phone('ao', 1, 3, 3)).issue,
        'sai thanh mẫu, vận mẫu và thanh điệu'
    )
    check(
        '字: thanh mẫu + vận mẫu',
        oneChar(p, '字', 'zi9', phone('z', 0, 3, 1) + phone('ii', 1, 3, 1)).issue,
        'sai thanh mẫu và vận mẫu'
    )
    check(
        '哦: zero thanh mẫu (phone `_o`)',
        oneChar(p, '哦', 'o1', phone('_o', 0, 3, 1)).issue,
        'sai vận mẫu',
        'không bao giờ là "sai thanh mẫu"'
    )
    check(
        '气: đúng, nhưng perr_level_msg=2',
        oneChar(p, '气', 'qi9', phone('q', 0, 2, 0) + phone('i', 1, 1, 0)).level,
        'good',
        'không tự tạo lỗi mới'
    )
    check(
        '大: sai thanh điệu (level thấp)',
        oneChar(p, '大', 'da4', phone('d', 0, 1, 0) + phone('a', 1, 1, 2)).level,
        'weak',
        'thanh điệu luôn nặng'
    )
    check(
        '天: đọc thừa (lỗi nhịp)',
        oneChar(p, '天', 'tian1', phone('t', 0, 1, 0) + phone('ian', 1, 1, 0), 32).level,
        'fair',
        'sai nhịp, không sai âm'
    )
}

// ---------------------------------------------------------------------------
console.log('\n3. ĐỐI CHIẾU IAT CÓ SIẾT OAN BÀI ĐỌC ĐÚNG KHÔNG?\n')
{
    const { computeSpokenMatch } = require('../lib/spokenTextMatch')
    const cap = (ref, spoken) => {
        const m = computeSpokenMatch(ref, spoken)
        return m.cap === null ? 'không siết' : `trần ${m.cap}`
    }
    check('Đọc chuẩn (IAT khớp 9/9)', cap('大卫，今天天气怎么样？', '大卫今天天气怎么样'), 'không siết')
    check('IAT nhầm 1 chữ (8/9)', cap('大卫，今天天气怎么样？', '大为今天天气怎么样'), 'không siết', 'trong dung sai')
    check('IAT nhầm 2 chữ (7/9)', cap('大卫，今天天气怎么样？', '大为今天天汽怎么样'), 'không siết', 'trong dung sai')
    check('IAT chết / rỗng', cap('大卫，今天天气怎么样？', ''), 'không siết', 'sự cố ≠ điểm kém')
    check(
        'Đọc ra chữ khác hẳn (10/14)',
        cap('今天天气很好啊，不冷不热，很舒服。', '今天天气很好啊母狼哺乳很舒服'),
        'trần 51'
    )
}

// ---------------------------------------------------------------------------
console.log('\n4. PHÂN TỪ CÓ ĐÚNG KHÔNG?\n')
{
    const { groupCharsIntoWords } = require('../lib/wordSegmentation')
    const mk = (s) => s.split('').map((c) => ({ content: c, pinyin: 'x1', ok: true, issue: '' }))
    const grp = (hanzi, pinyin) =>
        groupCharsIntoWords(mk(hanzi), pinyin)
            .groups.map((g) => g.map((c) => c.content).join(''))
            .join('|')
    check(
        'Dùng phiên âm bài học',
        grp('你好你叫什么名字', 'Zhāng lǎoshī: Nǐ hǎo! Nǐ jiào shénme míngzi?'),
        '你|好|你|叫|什么|名字'
    )
    check(
        'Câu bắt đầu bằng nguyên âm có dấu (Ō)',
        grp('哦这是你的女儿吗她今年几岁了', "Ō, zhè shì nǐ de nǚ'ér ma? Tā jīnnián jǐ suì le?"),
        '哦|这|是|你|的|女儿|吗|她|今年|几|岁|了'
    )
}

// ---------------------------------------------------------------------------
console.log('\n5. GHÉP LẠI TỪ BỊ PHIÊN ÂM TÁCH RỜI?\n')
{
    const { findCompounds } = require('../lib/compoundWords')
    const mkWords = (arr) => arr.map((w) => ({ content: w, pinyin: '' }))
    const found = (arr, text) =>
        findCompounds(mkWords(arr), text)
            .map((c) => c.content)
            .join('|') || '(không gộp)'

    check('您好 bị tách bởi "Nín hǎo"', found(['您', '好'], '您好！'), '您好', 'yêu cầu của khách')
    check('你好 bị tách bởi "Nǐ hǎo"', found(['你', '好'], '你好！你叫什么名字？'), '你好')
    check(
        'Không gộp bừa cụm không phải từ',
        found(['今天', '天气', '很', '好', '啊'], '今天天气很好啊'),
        '(không gộp)',
        '很好 không phải mục từ điển'
    )
    check(
        'Không gộp xuyên qua dấu phẩy',
        found(['大卫', '今天'], '大卫，今天天气怎么样？'),
        '(không gộp)',
        'hai bên dấu phẩy không liền nhau'
    )
}

// ---------------------------------------------------------------------------
console.log('\n6. ÉP CÁCH ĐỌC CHO TTS CÓ AN TOÀN KHÔNG?\n')
{
    // Đọc thẳng hàm trong gtc-fe để kiểm chứng ĐÚNG code đang chạy, thay vì
    // chép lại logic ra đây rồi hai bản lệch nhau lúc nào không biết.
    const fs = require('fs')
    const path = require('path')
    const speakPath = path.join(__dirname, '..', '..', '..', 'gtc-fe', 'src', 'lib', 'speak.js')

    if (!fs.existsSync(speakPath)) {
        console.log('  ‑  Bỏ qua: không tìm thấy gtc-fe/src/lib/speak.js\n')
    } else {
        const src = fs.readFileSync(speakPath, 'utf8')
        const grab = (name) => {
            const i = src.indexOf('function ' + name + '(')
            return src.slice(i, src.indexOf('\n}', i) + 2)
        }
        // eslint-disable-next-line no-eval
        const toSapiPhonemes = eval('(' + grab('toSapiPhonemes') + ')')
        // eslint-disable-next-line no-eval
        const countHanzi = eval('(' + grab('countHanzi') + ')')
        const ph = (han, pinyin) => toSapiPhonemes(pinyin, countHanzi(han)) || '(không ép)'

        check('你 biến điệu trong 你好', ph('你', 'ni2'), 'ni 2', 'nǐ -> ní')
        check('不 trước thanh 4 (不热)', ph('不', 'bu2'), 'bu 2')
        check('不 trước thanh 3 (不冷)', ph('不', 'bu4'), 'bu 4')
        check('Cả từ ghép 你好', ph('你好', 'ni2 hao3'), 'ni 2 hao 3')
        check('气 mang thanh 9', ph('气', 'qi9'), '(không ép)', '9 lúc là thanh nhẹ lúc là thanh 4')
        check('服 thanh nhẹ (fu7)', ph('服', 'fu7'), '(không ép)', 'không đoán bừa')
        check('Lệch số âm tiết so với số chữ', ph('你好', 'ni2'), '(không ép)', 'chốt chặn')
        check('女 dùng ü', ph('女', 'nv3'), 'nv 3', 'Azure viết ü thành v')
    }
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(96))
console.log(`  ĐẠT ${pass}  ·  LỆCH ${fail}`)
if (fail > 0) {
    console.log('  Có khẳng định không còn đúng — xem lại trước khi tin vào kết quả chấm.')
    process.exit(1)
}
console.log('  Toàn bộ khẳng định trong docs/DOI-CHIEU.md vẫn đúng với code hiện tại.')
console.log('─'.repeat(96) + '\n')
