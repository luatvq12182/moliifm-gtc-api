/**
 * Chia từ vựng + bài tập của MỘT bài học ra các video, dựa vào file docx gốc.
 *
 * Dùng cho bài có NHIỀU video — mỗi video một file docx do khách soạn. Bài một
 * video thì dùng migrateRemoteVideoContent.js, không cần docx.
 *
 *   node src/scripts/splitLessonByDocx.js --lesson=<id> --docx=a.docx --docx=b.docx
 *   node src/scripts/splitLessonByDocx.js --lesson=<id> --docx=... --apply
 *
 * NGUYÊN TẮC: KHÔNG gõ lại dữ liệu từ docx.
 * Nội dung đã nhập trên web là bản chuẩn. docx chỉ dùng để QUYẾT ĐỊNH mỗi mục
 * thuộc video nào. Nhờ vậy sai lầm tệ nhất có thể xảy ra là xếp nhầm video —
 * không bao giờ có chuyện chữ nghĩa bị đọc sai rồi ghi đè lên bản đúng.
 *
 * GHÉP DOCX VỚI VIDEO BẰNG LỜI THOẠI, không theo thứ tự tham số. Lời thoại vốn
 * đã tách đúng theo video trong cơ sở dữ liệu, nên phép ghép tự kiểm chứng
 * được. Đặt sai thứ tự file trên dòng lệnh cũng không sai kết quả.
 *
 * DỪNG NGAY KHI CÓ MỤC KHÔNG RÕ. Một mục không tìm thấy trong docx nào, hoặc
 * thấy trong nhiều docx, là dấu hiệu thiếu file hoặc file không khớp bài. Lúc
 * đó đoán bừa còn tệ hơn dừng lại.
 */

const fs = require('fs')
const path = require('path')
const mammoth = require('mammoth')

const ROOT = path.join(__dirname, '..', '..')
const API = (process.env.API_URL || 'https://180-93-2-151.sslip.io/api').replace(/\/$/, '')
const BACKUP_DIR = path.join(ROOT, 'backup-lessons')

const APPLY = process.argv.includes('--apply')
const LESSON = (process.argv.find((a) => a.startsWith('--lesson=')) || '').split('=')[1]
const DOCX = process.argv.filter((a) => a.startsWith('--docx=')).map((a) => a.slice('--docx='.length))

// CHỈ ĐỊNH TAY cho mục mà docx không quyết được:  --assign='<hanzi>=<số video>'
//
// Cần đến khi giảng viên diễn đạt khác docx. Ví dụ thật: mục "V1 + V2(方向) + 来/去"
// không xuất hiện trong file nào, vì docx viết cùng mẫu ấy thành
// "搬过去 (Động từ + Bổ ngữ xu hướng kép)". Máy không thể biết hai cách nói đó là
// một, nên chỗ này phải do người quyết.
//
// Mọi chỉ định tay đều được in ra ở phần kết quả — không giấu, để còn soát lại.
const ASSIGN = new Map(
    process.argv
        .filter((a) => a.startsWith('--assign='))
        .map((a) => {
            const raw = a.slice('--assign='.length)
            const at = raw.lastIndexOf('=')
            if (at < 0) throw new Error(`--assign phải có dạng '<hanzi>=<số video>': ${raw}`)
            return [raw.slice(0, at).trim(), Number(raw.slice(at + 1))]
        })
)

const TYPES = ['multipleChoice', 'trueFalse', 'sentenceOrder', 'shortAnswer']
const FIELD = {
    multipleChoice: 'question',
    trueFalse: 'statement',
    sentenceOrder: 'correctSentence',
    shortAnswer: 'question',
}

// Chỉ giữ chữ Hán để so khớp: docx và web khác nhau về dấu cách, dấu câu, phiên
// âm kèm theo — so nguyên văn thì gần như không bao giờ trùng.
const han = (s) => (String(s || '').match(/[\u4e00-\u9fff]/g) || []).join('')

function readToken() {
    const line = fs
        .readFileSync(path.join(ROOT, 'ACCESS_TOKEN.md'), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('ADMIN_TOKEN='))
    if (!line) throw new Error('Không thấy ADMIN_TOKEN= trong ACCESS_TOKEN.md')
    return line.slice('ADMIN_TOKEN='.length).trim()
}

async function api(token, urlPath, options = {}) {
    const res = await fetch(API + urlPath, {
        ...options,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${urlPath} — ${text.slice(0, 300)}`)
    return JSON.parse(text)
}

/**
 * Cắt riêng mục "IV. TỪ VỰNG / TỪ MỚI VÀ NGỮ PHÁP MỞ RỘNG" của một docx.
 *
 * VÌ SAO CẦN: từ vựng ngắn và thông dụng (请, 过, 还, 怎么...) xuất hiện trong
 * LỜI THOẠI của nhiều phần, nên tra toàn văn thì mục nào cũng "thấy ở 2-3 file"
 * và không phân loại được. Chỗ DUY NHẤT nói "đây là từ mới của phần này" là
 * mục IV. Tra đúng chỗ đó thì hết mơ hồ.
 *
 * Trả về null nếu không tìm thấy mục — lúc đó lùi về tra toàn văn, và mục nào
 * mơ hồ sẽ tự lộ ra ở bước kiểm cuối chứ không bị giấu đi.
 */
function extractVocabSection(rawText) {
    const start = rawText.search(/(TỪ VỰNG|TỪ MỚI)\s+VÀ\s+NGỮ\s*PHÁP/i)
    if (start < 0) return null
    const rest = rawText.slice(start)
    const end = rest.search(/\n\s*[VⅤ]\s*[.．]\s*BẢN\s+DỊCH/i)
    return end > 0 ? rest.slice(0, end) : rest
}

/**
 * Danh sách ĐẦU MỤC từ vựng của mục IV, dạng "(1) 阿姨 / āyí / danh từ / ...".
 * Đây là chỗ khai báo "từ mới của phần này", chính xác hơn cả mục IV nói chung.
 */
/**
 * Các dòng "Cấu trúc: ..." trong mục IV.
 *
 * Mục từ vựng đôi khi là MẪU NGỮ PHÁP viết lẫn chữ Latin — "A + 什么 + A",
 * "不 + Tính từ + 不 + Tính từ". Lọc chữ Hán ra thì chúng teo lại còn "什么",
 * "不不", quá ngắn nên đụng đâu cũng thấy. Mẫu ngữ pháp chỉ được khai báo ở
 * dòng "Cấu trúc", nên soi riêng những dòng đó là hết nhầm.
 */
function extractStructureLines(vocabSectionRaw) {
    if (!vocabSectionRaw) return ''
    return han(
        vocabSectionRaw
            .split('\n')
            .filter((l) => /^\s*Cấu trúc/i.test(l))
            .join('\n')
    )
}

function extractHeadwords(vocabSectionRaw) {
    if (!vocabSectionRaw) return []
    return [...vocabSectionRaw.matchAll(/[（(]\s*\d+\s*[)）]\s*([^\/\n]{1,24}?)\s*[\/／]/g)]
        .map((m) => han(m[1]))
        .filter(Boolean)
}

// Mục này nằm trong những docx nào? Trả về mảng chỉ số docx.
function locate(text, docs) {
    const needle = han(text)
    if (!needle) return []
    return docs.map((d, i) => (d.text.includes(needle) ? i : -1)).filter((i) => i >= 0)
}

/**
 * Từ vựng thuộc phần nào — thử ba mức, chặt trước lỏng sau.
 *
 * Vì sao không tra thẳng toàn văn: từ ngắn và thông dụng (请, 过, 还, 怎么) nằm
 * trong LỜI THOẠI của mọi phần, tra kiểu đó thì mục nào cũng "thấy ở 2-3 file".
 *
 * Vì sao khớp CHÍNH XÁC đầu mục trước khi thử chuỗi con: Phần 2 khai báo 还可以
 * còn Phần 3 khai báo 还 — hai từ khác nhau. Dùng chuỗi con trước thì 还 dính cả
 * hai, mà thật ra nó thuộc về Phần 3.
 */
function locateVocabulary(text, docs) {
    const needle = han(text)
    if (!needle) return []

    const exact = docs.map((d, i) => (d.headwords.includes(needle) ? i : -1)).filter((i) => i >= 0)
    if (exact.length === 1) return exact

    const partial = docs
        .map((d, i) => (d.headwords.some((h) => h.includes(needle)) ? i : -1))
        .filter((i) => i >= 0)
    if (partial.length === 1) return partial

    // Mẫu ngữ pháp: chỉ soi các dòng "Cấu trúc", trước khi soi cả mục IV.
    const inStructure = docs
        .map((d, i) => (d.structureLines.includes(needle) ? i : -1))
        .filter((i) => i >= 0)
    if (inStructure.length === 1) return inStructure

    const inSection = docs
        .map((d, i) => (d.vocabSection !== null && d.vocabSection.includes(needle) ? i : -1))
        .filter((i) => i >= 0)
    if (inSection.length === 1) return inSection

    return exact.length ? exact : partial.length ? partial : inStructure.length ? inStructure : inSection
}

async function main() {
    if (!LESSON || DOCX.length === 0) {
        throw new Error('Thiếu --lesson=<id> hoặc --docx=<file>')
    }

    const token = readToken()
    const lesson = await api(token, '/admin/lessons/' + LESSON)
    const videos = lesson.videos || []

    if (videos.length !== DOCX.length) {
        throw new Error(`Bài có ${videos.length} video nhưng đưa ${DOCX.length} file docx — phải bằng nhau.`)
    }

    const docs = []
    for (const file of DOCX) {
        const raw = (await mammoth.extractRawText({ path: file })).value
        const section = extractVocabSection(raw)
        docs.push({
            file: path.basename(file),
            text: han(raw),
            vocabSection: section === null ? null : han(section),
            headwords: extractHeadwords(section),
            structureLines: extractStructureLines(section),
        })
    }
    const missingSection = docs.filter((d) => d.vocabSection === null)
    if (missingSection.length > 0) {
        console.log('\nLƯU Ý: không thấy mục "TỪ VỰNG/TỪ MỚI VÀ NGỮ PHÁP" trong:')
        missingSection.forEach((d) => console.log('  ' + d.file))
        console.log('Những file này sẽ tra toàn văn, dễ mơ hồ hơn.')
    }

    const line = '─'.repeat(80)
    console.log('\n' + line)
    console.log(`  ${lesson.title}  —  ${videos.length} video, ${DOCX.length} file docx`)
    console.log(APPLY ? '  GHI THẬT vào ' + API : '  CHẠY THỬ — chưa ghi gì.')
    console.log(line + '\n')

    // --- 1. Ghép docx với video bằng lời thoại -----------------------------
    console.log('GHÉP DOCX VỚI VIDEO (đối chiếu lời thoại):\n')
    const docOfVideo = []
    videos.forEach((v, vi) => {
        // Bỏ câu quá ngắn: "好啊！" có thể xuất hiện ở bất kỳ file nào.
        const lines = (v.dialogue || []).map((d) => han(d.hanzi)).filter((x) => x.length > 5)
        const hits = docs.map((d) => lines.filter((l) => d.text.includes(l)).length)
        const best = hits.indexOf(Math.max(...hits))
        const tie = hits.filter((h) => h === hits[best]).length > 1
        console.log(
            `  video ${vi + 1}: ${lines.length} câu thoại  ->  ` +
            docs.map((d, i) => `${d.file}=${hits[i]}`).join('  ') +
            (tie || hits[best] === 0 ? '   KHÔNG PHÂN BIỆT ĐƯỢC' : `   khớp ${docs[best].file}`)
        )
        if (tie || hits[best] === 0) throw new Error('Không ghép được docx với video ' + (vi + 1))
        docOfVideo[vi] = best
    })
    if (new Set(docOfVideo).size !== videos.length) {
        throw new Error('Hai video cùng khớp một file docx — kiểm lại danh sách file.')
    }
    const videoOfDoc = []
    docOfVideo.forEach((d, v) => { videoOfDoc[d] = v })

    // --- 2. Phân loại từng mục --------------------------------------------
    const buckets = videos.map(() => ({ vocabulary: [], exercises: Object.fromEntries(TYPES.map((t) => [t, []])) }))
    const unclear = []

    console.log('\nPHÂN LOẠI:\n')

    const assigned = []
    ;(lesson.vocabulary || []).forEach((item) => {
        const manual = ASSIGN.get(String(item.hanzi).trim())
        if (manual) {
            if (!(manual >= 1 && manual <= videos.length)) {
                throw new Error(`--assign cho "${item.hanzi}" trỏ tới video ${manual}, ngoài khoảng 1..${videos.length}`)
            }
            buckets[manual - 1].vocabulary.push(item)
            assigned.push(`${item.hanzi} -> video ${manual}`)
            return
        }
        const found = locateVocabulary(item.hanzi, docs)
        if (found.length !== 1) {
            unclear.push({ kind: 'từ vựng', text: item.hanzi, found })
            return
        }
        buckets[videoOfDoc[found[0]]].vocabulary.push(item)
    })

    TYPES.forEach((type) => {
        ;(lesson.exercises?.[type] || []).forEach((q) => {
            const found = locate(q[FIELD[type]], docs)
            if (found.length !== 1) {
                unclear.push({ kind: type, text: q[FIELD[type]], found })
                return
            }
            buckets[videoOfDoc[found[0]]].exercises[type].push(q)
        })
    })

    buckets.forEach((b, vi) => {
        const ex = TYPES.map((t) => `${t} ${b.exercises[t].length}`).join(', ')
        console.log(`  video ${vi + 1} ("${videos[vi].title || 'không tên'}"): ${b.vocabulary.length} từ vựng | ${ex}`)
    })

    if (assigned.length > 0) {
        console.log('\n  CHỈ ĐỊNH TAY (không do docx quyết định):')
        assigned.forEach((a) => console.log('    ' + a))
    }

    const totalVocab = buckets.reduce((s, b) => s + b.vocabulary.length, 0)
    const totalEx = buckets.reduce((s, b) => s + TYPES.reduce((n, t) => n + b.exercises[t].length, 0), 0)
    const wantVocab = lesson.vocabulary?.length || 0
    const wantEx = TYPES.reduce((n, t) => n + (lesson.exercises?.[t]?.length || 0), 0)

    console.log(`\n  Tổng: ${totalVocab}/${wantVocab} từ vựng, ${totalEx}/${wantEx} câu hỏi`)

    if (unclear.length > 0) {
        console.log(`\nKHÔNG RÕ (${unclear.length} mục) — DỪNG, không ghi gì:\n`)
        unclear.forEach((u) =>
            console.log(`  [${u.kind}] ${String(u.text).slice(0, 50)}  ->  ${u.found.length === 0 ? 'không thấy trong docx nào' : 'thấy trong ' + u.found.length + ' file'}`)
        )
        console.log('\nThiếu file docx, hoặc file không khớp bài này.\n')
        process.exit(1)
    }

    if (!APPLY) {
        console.log('\nXem ổn thì chạy lại với  --apply\n')
        return
    }

    // --- 3. Ghi, có sao lưu và đọc lại kiểm --------------------------------
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const backupFile = path.join(BACKUP_DIR, `${lesson._id}.json`)
    fs.writeFileSync(backupFile, JSON.stringify(lesson, null, 2))

    const payload = {
        title: lesson.title,
        slug: lesson.slug,
        description: lesson.description,
        order: lesson.order,
        status: lesson.status,
        videos: videos.map((v, vi) => ({ ...v, ...buckets[vi] })),
        vocabulary: [],
        exercises: Object.fromEntries(TYPES.map((t) => [t, []])),
    }

    await api(token, '/admin/lessons/' + lesson._id, { method: 'PUT', body: JSON.stringify(payload) })

    const after = await api(token, '/admin/lessons/' + lesson._id)
    const gotVocab = (after.videos || []).reduce((s, v) => s + (v.vocabulary?.length || 0), 0)
    const gotEx = (after.videos || []).reduce((s, v) => s + TYPES.reduce((n, t) => n + (v.exercises?.[t]?.length || 0), 0), 0)

    console.log('\nĐÃ GHI, đọc lại để đối chiếu:\n')
    ;(after.videos || []).forEach((v, vi) =>
        console.log(`  video ${vi + 1}: ${v.vocabulary?.length || 0} từ vựng, ${TYPES.reduce((n, t) => n + (v.exercises?.[t]?.length || 0), 0)} câu hỏi`)
    )

    if (gotVocab === wantVocab && gotEx === wantEx && (after.vocabulary?.length || 0) === 0) {
        console.log(`\n  ✓ Khớp: ${gotVocab} từ vựng, ${gotEx} câu hỏi. Chỗ cũ đã dọn.`)
        console.log(`  Bản gốc: ${backupFile}\n`)
    } else {
        console.log(`\n  ✗ LỆCH: mong ${wantVocab}/${wantEx}, nhận ${gotVocab}/${gotEx}`)
        console.log(`  KHÔI PHỤC từ ${backupFile}\n`)
        process.exit(1)
    }
}

main().catch((err) => {
    console.error('\nLỖI:', err.message, '\n')
    process.exit(1)
})
