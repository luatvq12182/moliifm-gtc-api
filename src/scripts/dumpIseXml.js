/**
 * Xuất XML thô mà iFLYTEK trả về, để đối chứng nhãn lỗi.
 *
 *   npm run dump:xml            # xuất 5 lượt gần nhất
 *   npm run dump:xml -- 20      # xuất 20 lượt gần nhất
 *
 * Kết quả ghi ra file  ise-xml-dump.txt  ở thư mục gốc gtc-api.
 * Gửi file đó đi là đủ để phân tích — nó chứa cả câu mẫu, nhãn lỗi ta suy ra,
 * và XML gốc để đối chiếu xem suy ra đúng hay sai.
 *
 * Cần PRACTICE_HISTORY_ENABLED=true lúc học viên luyện thì XML mới được lưu.
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const PracticeAttempt = require('../models/PracticeAttempt')

const LIMIT = parseInt(process.argv[2], 10) || 5
const OUT_FILE = path.join(__dirname, '../../ise-xml-dump.txt')

async function main() {
    await connectDB()

    const attempts = await PracticeAttempt.find({ rawXml: { $ne: '' } })
        .sort({ createdAt: -1 })
        .limit(LIMIT)
        .lean()

    if (attempts.length === 0) {
        console.log('\nChưa có lượt nào lưu được XML.')
        console.log('Kiểm tra: PRACTICE_HISTORY_ENABLED=true trong .env, rồi luyện nói lại vài câu.\n')
        await mongoose.connection.close()
        return
    }

    const blocks = attempts.map((a, i) => {
        const wrong = (a.chars || []).filter((c) => !c.ok)
        return [
            '='.repeat(78),
            `LƯỢT ${i + 1}/${attempts.length}   ${new Date(a.createdAt).toLocaleString('vi-VN')}`,
            '='.repeat(78),
            `Câu mẫu   : ${a.referenceText}`,
            `Phiên âm  : ${a.referencePinyin || '(trống)'}`,
            `IAT nghe  : ${a.spokenText || '(trống)'}`,
            `Điểm      : ${a.pronScore ?? '--'}   ` +
            `[phát âm ${Math.round(a.rawScores?.phone_score ?? 0)} · ` +
            `thanh điệu ${Math.round(a.rawScores?.tone_score ?? 0)} · ` +
            `trôi chảy ${Math.round(a.rawScores?.fluency_score ?? 0)} · ` +
            `đầy đủ ${Math.round(a.rawScores?.integrity_score ?? 0)}]`,
            '',
            'NHÃN LỖI HỆ THỐNG SUY RA (để đối chiếu với XML bên dưới):',
            ...(wrong.length === 0
                ? ['  (không có chữ nào bị gắn cờ)']
                : wrong.map((c) => `  ${c.content}  ${(c.pinyin || '').padEnd(8)} -> ${c.issue}`)),
            '',
            'GOM TỪ: ' + (a.words || []).map((w) => `${w.content}(${w.status})`).join(' '),
            '',
            '--- XML THÔ TỪ iFLYTEK ---',
            a.rawXml,
            '',
        ].join('\n')
    })

    fs.writeFileSync(OUT_FILE, blocks.join('\n'), 'utf8')

    console.log(`\nĐã xuất ${attempts.length} lượt ra:\n  ${OUT_FILE}`)
    console.log(`Dung lượng: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB\n`)

    await mongoose.connection.close()
}

main().catch(async (err) => {
    console.error('Lỗi:', err.message)
    await mongoose.connection.close().catch(() => { })
    process.exit(1)
})
