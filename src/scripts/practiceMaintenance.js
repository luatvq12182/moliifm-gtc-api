/**
 * Chạy tay tác vụ dọn kho ghi âm luyện nói.
 *
 *   npm run maintain:practice              dọn thật
 *   npm run maintain:practice -- --dry-run  chỉ xem sẽ xoá gì
 *
 * CHẠY --dry-run TRƯỚC TIÊN trên máy chủ đã có dữ liệu. Mọi bản ghi luyện nói
 * có từ TRƯỚC tính năng này đều mang lessonAttempt = null (trường mới thêm),
 * nên lần dọn đầu sẽ coi chúng là bài bỏ dở và xoá sạch.
 *
 * Bình thường việc này tự chạy mỗi 30 phút trong tiến trình máy chủ (xem
 * lib/practiceCleanup.js). Script này để chạy ngay khi cần — sau một đợt sự
 * cố, hoặc khi muốn nén dồn một lô lớn.
 */
require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const { runMaintenance, PROVISIONAL_TTL_MS } = require('../lib/practiceCleanup')

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
    await connectDB()
    console.log(`\nHạn bản ghi tạm: ${Math.round(PROVISIONAL_TTL_MS / 3600000)} giờ`)
    console.log(DRY_RUN ? 'CHẠY THỬ — không xoá gì cả\n' : '')
    const r = await runMaintenance({ quiet: true, dryRun: DRY_RUN })
    const mb = (b) => (b / 1024 / 1024).toFixed(1)
    console.log(`  Bản ghi tạm quá hạn : ${DRY_RUN ? 'sẽ xoá' : 'xoá'} ${r.expired.deleted} (${mb(r.expired.bytesFreed)} MB)`)
    console.log(`  Nén WAV -> AAC      : ${r.compressed.converted} file (tiết kiệm ${mb(r.compressed.bytesSaved)} MB)`)
    console.log(`  File mồ côi         : xoá ${r.orphans.deleted} (${mb(r.orphans.bytesFreed)} MB)`)
    if (r.compressed.stopped) console.log('\n  CẢNH BÁO: dừng nén giữa chừng — xem log ffmpeg ở trên.')
    console.log()
}

main()
    .catch((err) => {
        console.error('LỖI:', err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
