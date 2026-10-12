/**
 * Dời từ vựng + bài tập từ cấp BÀI HỌC xuống VIDEO, qua API của web demo.
 *
 * Khác với migrateVideoContent.js (chạy thẳng vào MongoDB nội bộ), script này
 * làm việc qua HTTP nên dùng được với dữ liệu đã nhập trên web demo.
 *
 * CHỈ TỰ ĐỘNG DỜI KHI BÀI CÓ ĐÚNG MỘT VIDEO — lúc đó không có gì để đoán, toàn
 * bộ nội dung của bài chính là nội dung của video ấy. Bài nhiều video cần file
 * docx mới biết mục nào thuộc video nào; script này chỉ liệt kê ra, không đụng.
 *
 *   node src/scripts/migrateRemoteVideoContent.js                  # chạy thử
 *   node src/scripts/migrateRemoteVideoContent.js --apply          # ghi thật
 *   node src/scripts/migrateRemoteVideoContent.js --lesson=<id>    # đúng 1 bài
 *
 * Token đọc từ ACCESS_TOKEN.md (đã gitignore). KHÔNG in token ra màn hình.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const API = (process.env.API_URL || 'https://180-93-2-151.sslip.io/api').replace(/\/$/, '')
const BACKUP_DIR = path.join(ROOT, 'backup-lessons')

const APPLY = process.argv.includes('--apply')
const ONLY = (process.argv.find((a) => a.startsWith('--lesson=')) || '').split('=')[1] || null

const TYPES = ['multipleChoice', 'trueFalse', 'sentenceOrder', 'shortAnswer']
const countEx = (e) => TYPES.reduce((s, k) => s + (e?.[k]?.length || 0), 0)

function readToken() {
    const file = path.join(ROOT, 'ACCESS_TOKEN.md')
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('ADMIN_TOKEN='))
    if (!line) throw new Error('Không thấy dòng ADMIN_TOKEN= trong ACCESS_TOKEN.md')
    const token = line.slice('ADMIN_TOKEN='.length).trim()
    if (!token) throw new Error('ADMIN_TOKEN rỗng')
    return token
}

async function api(token, urlPath, options = {}) {
    const res = await fetch(API + urlPath, {
        ...options,
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${urlPath} — ${text.slice(0, 300)}`)
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(`Trả về không phải JSON từ ${urlPath}: ${text.slice(0, 200)}`)
    }
}

async function main() {
    const token = readToken()

    const courses = await api(token, '/admin/courses')
    const courseName = {}
    courses.forEach((c) => {
        courseName[String(c._id)] = c.name || c.title || '?'
    })

    const brief = await api(token, '/admin/lessons')
    const lessons = []
    for (const b of brief) {
        if (ONLY && String(b._id) !== ONLY) continue
        lessons.push(await api(token, '/admin/lessons/' + b._id))
    }

    const ready = []
    const needDocx = []
    const skipped = []

    for (const lesson of lessons) {
        const videos = lesson.videos || []
        const vocabCount = lesson.vocabulary?.length || 0
        const exCount = countEx(lesson.exercises)
        const label = `${courseName[String(lesson.courseId)] || '?'} / ${lesson.title}`

        if (vocabCount === 0 && exCount === 0) {
            skipped.push({ label, why: 'không còn nội dung ở cấp bài học' })
        } else if (videos.length !== 1) {
            needDocx.push({ label, lesson, videos, vocabCount, exCount })
        } else if ((videos[0].vocabulary?.length || 0) > 0 || countEx(videos[0].exercises) > 0) {
            skipped.push({ label, why: 'video đã có nội dung riêng, không ghi đè' })
        } else {
            ready.push({ label, lesson, vocabCount, exCount })
        }
    }

    const line = '─'.repeat(80)
    console.log('\n' + line)
    console.log(APPLY ? '  GHI THẬT vào ' + API : '  CHẠY THỬ — chưa ghi gì. Thêm --apply để ghi.')
    console.log(line + '\n')

    if (ready.length) {
        console.log(`DỜI ĐƯỢC NGAY (${ready.length} bài — mỗi bài đúng 1 video):\n`)
        ready.forEach((r) =>
            console.log(`  ${r.label.padEnd(22)} ${r.vocabCount} từ vựng, ${r.exCount} câu hỏi  ->  video "${r.lesson.videos[0].title || 'không tên'}"`)
        )
        console.log()
    }

    if (needDocx.length) {
        console.log(`CẦN FILE DOCX (${needDocx.length} bài — nhiều video, không đoán được):\n`)
        needDocx.forEach((r) => {
            console.log(`  ${r.label.padEnd(22)} ${r.videos.length} video, ${r.vocabCount} từ vựng, ${r.exCount} câu hỏi`)
            r.videos.forEach((v, i) =>
                console.log(`      video ${i + 1}: "${v.title || 'không tên'}" — ${(v.dialogue || []).length} câu thoại`)
            )
        })
        console.log()
    }

    if (skipped.length) {
        console.log(`BỎ QUA (${skipped.length}):\n`)
        skipped.forEach((r) => console.log(`  ${r.label.padEnd(22)} ${r.why}`))
        console.log()
    }

    if (!APPLY) {
        if (ready.length) console.log('Xem ổn thì chạy lại với  --apply\n')
        return
    }

    if (!ready.length) {
        console.log('Không có bài nào để ghi.\n')
        return
    }

    // SAO LƯU TRƯỚC KHI GHI. Bản gốc nằm trên máy, hỏng gì còn dựng lại được.
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    console.log('Đang ghi...\n')

    for (const { label, lesson } of ready) {
        const backupFile = path.join(BACKUP_DIR, `${lesson._id}.json`)
        fs.writeFileSync(backupFile, JSON.stringify(lesson, null, 2))

        const videos = lesson.videos.map((v, i) =>
            i === 0
                ? {
                    ...v,
                    vocabulary: lesson.vocabulary || [],
                    exercises: {
                        multipleChoice: lesson.exercises?.multipleChoice || [],
                        trueFalse: lesson.exercises?.trueFalse || [],
                        sentenceOrder: lesson.exercises?.sentenceOrder || [],
                        shortAnswer: lesson.exercises?.shortAnswer || [],
                    },
                }
                : v
        )

        const payload = {
            title: lesson.title,
            slug: lesson.slug,
            description: lesson.description,
            order: lesson.order,
            status: lesson.status,
            videos,
            // Dọn chỗ cũ để trang quản trị thôi hiện khung "Nội dung cũ".
            vocabulary: [],
            exercises: { multipleChoice: [], trueFalse: [], sentenceOrder: [], shortAnswer: [] },
        }

        await api(token, '/admin/lessons/' + lesson._id, {
            method: 'PUT',
            body: JSON.stringify(payload),
        })

        // ĐỌC LẠI ĐỂ KIỂM. PUT trả 200 không có nghĩa là dữ liệu đã vào đúng chỗ:
        // nếu máy chủ còn schema cũ thì Mongoose lặng lẽ loại bỏ hai trường mới
        // và ta sẽ tưởng là xong trong khi vừa xoá sạch nội dung ở cấp bài học.
        const after = await api(token, '/admin/lessons/' + lesson._id)
        const gotVocab = after.videos?.[0]?.vocabulary?.length || 0
        const gotEx = countEx(after.videos?.[0]?.exercises)
        const wantVocab = lesson.vocabulary?.length || 0
        const wantEx = countEx(lesson.exercises)

        if (gotVocab === wantVocab && gotEx === wantEx) {
            console.log(`  ✓  ${label.padEnd(22)} ${gotVocab} từ vựng, ${gotEx} câu hỏi đã nằm trong video`)
        } else {
            console.log(`  ✗  ${label.padEnd(22)} LỆCH: mong ${wantVocab}/${wantEx}, nhận ${gotVocab}/${gotEx}`)
            console.log(`     Bản gốc đã lưu ở ${backupFile} — KHÔI PHỤC NGAY trước khi làm tiếp.`)
            throw new Error('Ghi không khớp, dừng lại để không hỏng thêm bài nào nữa.')
        }
    }

    console.log(`\nXong. Bản gốc lưu ở ${BACKUP_DIR}/\n`)
}

main().catch((err) => {
    console.error('\nLỖI:', err.message, '\n')
    process.exit(1)
})
