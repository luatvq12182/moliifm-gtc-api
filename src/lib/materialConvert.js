/**
 * CHUYỂN BỘ SLIDE THÀNH ẢNH TỪNG TRANG — chức năng "Học liệu khoá học".
 *
 *   PowerPoint (.pptx/.ppt/.odp) --LibreOffice--> PDF --pdftoppm--> page-N.jpg
 *   PDF ------------------------------------------------^
 *   Link Google Slides --tải bản PDF Google xuất ra------^
 *
 * Cần hai công cụ trên máy chủ: `soffice` (LibreOffice) và `pdftoppm`
 * (poppler-utils), cùng bộ font chữ Hán (font-noto-cjk) — đã khai trong
 * Dockerfile. Thiếu công cụ thì bộ slide báo lỗi rõ ràng, máy chủ vẫn chạy.
 *
 * MỖI LÚC CHỈ CHUYỂN MỘT BỘ (hàng đợi tuần tự): LibreOffice ngốn nhiều RAM và
 * hay hỏng khi nhiều tiến trình chạy cùng lúc trên một VPS nhỏ.
 *
 * Bố cục thư mục: storage/materials/<deckId>/
 *     source-v<version>.<ext>     file gốc (KHÔNG phục vụ ra ngoài)
 *     v<version>/page-<n>.jpg     ảnh từng trang
 * Mỗi lần tải file mới là một version mới (ảnh cũ và mới không bao giờ lẫn
 * nhau); file của version cũ bị xoá sau khi bản mới chuyển xong.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const MaterialDeck = require('../models/MaterialDeck')

const STORAGE_ROOT = path.join(__dirname, '../../storage')
const MATERIALS_DIR = path.join(STORAGE_ROOT, 'materials')

const OFFICE_EXTS = ['pptx', 'ppt', 'odp']
const ALLOWED_EXTS = ['pdf', ...OFFICE_EXTS]

// Chiều rộng ảnh: đủ nét trên màn hình laptop/điện thoại, mỗi trang chỉ cỡ
// 60–150 KB ở chất lượng JPEG 85.
const PAGE_WIDTH = 1600
const JPEG_QUALITY = 85
// Ảnh thu nhỏ cho cột xem trước: vài KB mỗi trang, bộ 30 trang cũng nhẹ.
const THUMB_WIDTH = 320
const THUMB_QUALITY = 70
// Trần số trang: một bộ slide bài giảng hiếm khi quá 100 trang; file vài
// trăm trang nhiều khả năng là tải nhầm (cả giáo trình) và sẽ làm nghẽn hàng đợi.
const MAX_PAGES = 300
const OFFICE_TIMEOUT_MS = 3 * 60 * 1000
const RASTER_TIMEOUT_MS = 5 * 60 * 1000

// NGUỒN GOOGLE: link Google Slides (máy chủ lấy bản PDF Google xuất ra) hoặc
// link FILE trên Google Drive (PDF / PowerPoint giảng viên để sẵn trên Drive).
// Cho đổi gốc URL bằng biến môi trường để smoke test chạy được không cần mạng.
const googleExportBase = () => process.env.GOOGLE_SLIDES_EXPORT_BASE || 'https://docs.google.com/presentation/d'
const googleDriveBase = () => process.env.GOOGLE_DRIVE_DOWNLOAD_BASE || 'https://drive.usercontent.google.com/download'
const googleFolderBase = () => process.env.GOOGLE_DRIVE_FOLDER_BASE || 'https://drive.google.com/embeddedfolderview'
const GOOGLE_MAX_BYTES = 150 * 1024 * 1024
const GOOGLE_TIMEOUT_MS = 3 * 60 * 1000
const TOO_BIG = 'File quá lớn (trên 150MB). Hãy nén hoặc tách thành nhiều file.'

/**
 * Nhận diện link Google. Trả về:
 *   { type: 'slides', id }  bài trình bày Google Slides
 *       docs.google.com/presentation/d/<ID>/edit | /present | /u/1/d/<ID>/…
 *   { type: 'drive', id }   một FILE trên Google Drive
 *       drive.google.com/file/d/<ID>/view | /open?id=<ID> | /uc?id=<ID>
 *       drive.usercontent.google.com/download?id=<ID>
 *   { type: 'folder', id }  link THƯ MỤC công khai — lấy mọi file slide trong đó
 *   null                    không phải link Google dùng được
 */
function parseGoogleLink(input) {
    let url
    try {
        url = new URL(String(input || '').trim())
    } catch {
        return null
    }
    const host = url.hostname
    const ID = /^[a-zA-Z0-9_-]{20,}$/
    const qid = url.searchParams.get('id')
    let m
    if (host === 'docs.google.com') {
        m = url.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/)
        if (m) return { type: 'slides', id: m[1] }
        if (url.pathname === '/uc' && ID.test(qid || '')) return { type: 'drive', id: qid }
        return null
    }
    if (host === 'drive.google.com') {
        m = url.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/)
        if (m) return { type: 'drive', id: m[1] }
        if (/^\/(open|uc)$/.test(url.pathname) && ID.test(qid || '')) return { type: 'drive', id: qid }
        m = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{20,})/)
        if (m) return { type: 'folder', id: m[1] }
        return null
    }
    if (host === 'drive.usercontent.google.com' && ID.test(qid || '')) return { type: 'drive', id: qid }
    return null
}

/** Giữ cho chỗ cũ còn gọi: chỉ nhận link Google Slides. */
function parseGoogleSlidesId(input) {
    const link = parseGoogleLink(input)
    return link && link.type === 'slides' ? link.id : null
}

const GOOGLE_ACCESS_HINT =
    'Không lấy được file từ Google. Mở file trên Google Drive / Google Slides → Chia sẻ → "Bất kỳ ai có đường liên kết" (Người xem), ' +
    'và đừng tắt quyền tải xuống cho người xem — rồi bấm Thử lại. Lấy xong có thể đặt lại chế độ riêng tư.'

/**
 * Tên file trong header Content-Disposition. Ưu tiên `filename*` (UTF-8, có
 * dấu tiếng Việt đúng); `filename="…"` thì Node đọc header như latin1 nên phải
 * giải mã lại.
 */
function dispositionFilename(header) {
    const h = String(header || '')
    const star = h.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)
    if (star) {
        try {
            return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
        } catch { /* rơi xuống dạng thường */ }
    }
    const plain = h.match(/filename\s*=\s*"([^"]+)"/) || h.match(/filename\s*=\s*([^;]+)/)
    if (!plain) return ''
    const raw = plain[1].trim()
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8')
    return utf8.includes('�') ? raw : utf8
}

/**
 * Loại file theo NỘI DUNG đầu file, không theo header: Drive trả mọi file với
 * kiểu chung application/octet-stream.
 *   %PDF            -> pdf
 *   PK\x03\x04 (zip)-> pptx (hoặc odp nếu tên file nói vậy)
 *   D0 CF 11 E0     -> ppt (PowerPoint đời cũ)
 */
async function sniffExt(file, filename) {
    const fd = await fs.promises.open(file, 'r')
    const head = Buffer.alloc(8)
    await fd.read(head, 0, 8, 0)
    await fd.close()
    const nameExt = path.extname(filename || '').slice(1).toLowerCase()
    if (head.slice(0, 4).toString('latin1') === '%PDF') return 'pdf'
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
        if (['pptx', 'odp'].includes(nameExt)) return nameExt
        if (!nameExt) return 'pptx'
        return null // zip nhưng là docx/xlsx/… -> không phải slide
    }
    if (head.readUInt32BE(0) === 0xd0cf11e0) return nameExt === 'ppt' || !nameExt ? 'ppt' : null
    return null
}

const SLIDE_EXTS = ['pdf', 'pptx', 'ppt', 'odp']

const decodeHtml = (t) =>
    String(t)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')

/**
 * Danh sách file trong một THƯ MỤC Google Drive công khai, đọc từ trang xem
 * thư mục dạng nhúng của Google (không cần khoá API). Chỉ một cấp — thư mục
 * con không được duyệt.
 *
 * Trả { files: [{ type, id, name }], skipped: [tên] }, files sắp theo tên kiểu
 * TỰ NHIÊN ("Bài 2" trước "Bài 10" — Drive thì xếp "Bài 1, 10, 11, …, 2").
 */
async function listDriveFolder(folderId) {
    let res
    try {
        res = await fetch(`${googleFolderBase()}?id=${encodeURIComponent(folderId)}`, {
            redirect: 'follow',
            signal: AbortSignal.timeout(30000),
        })
    } catch {
        throw new Error('Máy chủ không đọc được thư mục trên Google Drive. Thử lại sau ít phút.')
    }
    const html = res.ok ? await res.text() : ''
    if (!html.includes('flip-entries')) {
        throw new Error(
            'Không đọc được thư mục này. Trên Google Drive, chuột phải thư mục → Chia sẻ → "Bất kỳ ai có đường liên kết" (Người xem), rồi dán lại.'
        )
    }

    const files = []
    const skipped = []
    const entryRe = /<div class="flip-entry" id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)</g
    let m
    while ((m = entryRe.exec(html))) {
        const [, id, href, rawName] = m
        const name = decodeHtml(rawName).trim()
        if (/\/presentation\/d\//.test(href)) {
            files.push({ type: 'slides', id, name })
        } else if (/\/file\/d\//.test(href) && SLIDE_EXTS.includes(path.extname(name).slice(1).toLowerCase())) {
            files.push({ type: 'drive', id, name })
        } else {
            skipped.push(/\/folders\//.test(href) ? `${name} (thư mục con)` : name)
        }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true, sensitivity: 'base' }))
    return { files, skipped }
}

/** Tải một URL về `dest` theo luồng, có trần dung lượng và thời gian chờ. */
async function fetchToFile(url, dest) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS)
    try {
        let res
        try {
            res = await fetch(url, { redirect: 'follow', signal: controller.signal })
        } catch (err) {
            throw new Error(
                err.name === 'AbortError'
                    ? 'Google phản hồi quá lâu. Thử lại sau ít phút.'
                    : 'Máy chủ không kết nối được tới Google. Thử lại sau ít phút.'
            )
        }
        // File riêng tư / không tồn tại / chủ file chặn tải: Google trả trang
        // HTML (đăng nhập, báo lỗi) chứ không trả file.
        const type = res.headers.get('content-type') || ''
        if (!res.ok || type.includes('text/html')) {
            res.body?.cancel().catch(() => { })
            throw new Error(GOOGLE_ACCESS_HINT)
        }
        // Biết trước là quá lớn thì dừng NGAY, không tải về rồi mới vứt.
        if ((Number(res.headers.get('content-length')) || 0) > GOOGLE_MAX_BYTES) {
            res.body?.cancel().catch(() => { })
            throw new Error(TOO_BIG)
        }

        let bytes = 0
        const counter = new Transform({
            transform(chunk, enc, cb) {
                bytes += chunk.length
                if (bytes > GOOGLE_MAX_BYTES) return cb(new Error(TOO_BIG))
                cb(null, chunk)
            },
        })
        try {
            await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest))
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Google phản hồi quá lâu. Thử lại sau ít phút.')
            throw err
        }
        return { bytes, filename: dispositionFilename(res.headers.get('content-disposition')) }
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Lấy file nguồn của một bộ slide từ Google về thư mục của nó, đúng version.
 * Trả { ext, bytes, filename }.
 */
async function downloadGoogleSource(deckId, version, source) {
    await fs.promises.mkdir(deckDir(deckId), { recursive: true })
    const incoming = path.join(deckDir(deckId), `incoming-v${version}`)
    try {
        const url =
            source.googleType === 'drive'
                ? `${googleDriveBase()}?id=${encodeURIComponent(source.googleId)}&export=download&confirm=t`
                : `${googleExportBase()}/${source.googleId}/export/pdf`
        const { bytes, filename } = await fetchToFile(url, incoming)
        const ext = await sniffExt(incoming, filename)
        if (!ext) {
            const err = new Error(
                `File "${filename || 'trên Drive'}" không phải PDF hay PowerPoint. Chỉ nhận PDF, .pptx, .ppt, .odp.`
            )
            // Để bộ slide lỗi vẫn mang tên file thật — admin biết ngay file nào hỏng.
            err.filename = filename
            throw err
        }
        await fs.promises.rename(incoming, sourcePath(deckId, version, ext))
        return { ext, bytes, filename }
    } finally {
        await fs.promises.rm(incoming, { force: true }).catch(() => { })
    }
}

const deckDir = (deckId) => path.join(MATERIALS_DIR, String(deckId))
const sourcePath = (deckId, version, ext) => path.join(deckDir(deckId), `source-v${version}.${ext}`)
const pagesDir = (deckId, version) => path.join(deckDir(deckId), `v${version}`)

/**
 * Đường dẫn tuyệt đối tới ảnh một trang (hoặc ảnh thu nhỏ của nó), có chặn đi
 * ra ngoài thư mục bộ slide. Chưa có ảnh thu nhỏ thì trả ảnh lớn.
 */
function pagePath(deck, index, { thumb = false } = {}) {
    const page = deck.pages && deck.pages[index]
    if (!page) return null
    const dir = path.resolve(pagesDir(deck._id, deck.version))
    const abs = path.resolve(dir, thumb && page.thumb ? page.thumb : page.file)
    if (!abs.startsWith(dir + path.sep)) return null
    return abs
}

function run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                // Lỗi "không có lệnh" thì nói thẳng là thiếu công cụ, đừng để
                // giảng viên tưởng file của mình hỏng.
                if (err.code === 'ENOENT') err.message = `Máy chủ chưa cài công cụ "${cmd}".`
                else if (err.killed) err.message = `Chuyển đổi quá lâu (quá ${Math.round(timeout / 1000)} giây).`
                err.stderr = stderr
                return reject(err)
            }
            resolve({ stdout, stderr })
        })
    })
}

/** Kích thước ảnh JPEG đọc từ header (khối SOF) — khỏi cần thư viện xử lý ảnh. */
function jpegSize(buf) {
    let i = 2
    while (i < buf.length) {
        if (buf[i] !== 0xff) return null
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        // SOF0..SOF15, trừ DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        i += 2 + len
    }
    return null
}

async function convertDeck(deckId) {
    const deck = await MaterialDeck.findById(deckId)
    if (!deck || deck.conversion !== 'processing') return
    const version = deck.version
    let ext = deck.source.ext

    // Thư mục làm việc riêng cho mỗi lần chuyển, kể cả hồ sơ LibreOffice:
    // dùng chung hồ sơ mặc định là nguồn lỗi kinh điển khi chạy không màn hình.
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gtc-deck-'))
    try {
        // Nguồn Google: mỗi lần chuyển (kể cả "Cập nhật từ Google") đều lấy bản
        // MỚI NHẤT về trước. Loại file (pdf/pptx…) chỉ biết sau khi tải.
        if (deck.source.kind === 'google') {
            const got = await downloadGoogleSource(deckId, version, deck.source)
            ext = got.ext
            const set = { 'source.ext': got.ext, 'source.bytes': got.bytes, 'source.originalName': got.filename || '' }
            // Admin không đặt tên -> lấy theo tên file ("Bài 14 ok.pdf" -> "Bài 14 ok").
            if (deck.titleFromSource && got.filename) {
                set.title = path.parse(got.filename).name.slice(0, 200)
                set.titleFromSource = false
            }
            await MaterialDeck.updateOne({ _id: deckId, version }, { $set: set })
        }
        let pdf = sourcePath(deckId, version, ext)
        if (OFFICE_EXTS.includes(ext)) {
            await run(
                'soffice',
                [
                    '--headless',
                    `-env:UserInstallation=file://${path.join(work, 'lo-profile')}`,
                    '--convert-to',
                    'pdf',
                    '--outdir',
                    work,
                    pdf,
                ],
                OFFICE_TIMEOUT_MS
            )
            pdf = path.join(work, `source-v${version}.pdf`)
            if (!fs.existsSync(pdf)) {
                throw new Error('Không mở được file PowerPoint này. Thử lưu lại bằng PowerPoint (hoặc xuất ra PDF) rồi tải lên lại.')
            }
        }

        const outDir = pagesDir(deckId, version)
        await fs.promises.rm(outDir, { recursive: true, force: true })
        await fs.promises.mkdir(outDir, { recursive: true })
        try {
            await run(
                'pdftoppm',
                ['-jpeg', '-jpegopt', `quality=${JPEG_QUALITY}`, '-scale-to-x', String(PAGE_WIDTH), '-scale-to-y', '-1', '-l', String(MAX_PAGES + 1), pdf, path.join(outDir, 'page')],
                RASTER_TIMEOUT_MS
            )
        } catch (err) {
            // Lỗi đọc PDF thì nói bằng lời của giảng viên; chi tiết kỹ thuật
            // (stderr) vẫn được ghi vào log ở khối catch bên ngoài.
            if (err.code !== 'ENOENT' && !err.killed) {
                err.message = 'Không đọc được file PDF này (file hỏng hoặc có đặt mật khẩu). Hãy xuất lại file rồi tải lên.'
            }
            throw err
        }

        // Ảnh thu nhỏ: cùng lệnh, cỡ nhỏ. Hỏng thì bỏ qua — trình xem tự dùng
        // ảnh lớn thay thế, không đáng để làm hỏng cả bộ slide.
        try {
            await run(
                'pdftoppm',
                ['-jpeg', '-jpegopt', `quality=${THUMB_QUALITY}`, '-scale-to-x', String(THUMB_WIDTH), '-scale-to-y', '-1', '-l', String(MAX_PAGES), pdf, path.join(outDir, 'thumb')],
                RASTER_TIMEOUT_MS
            )
        } catch (err) {
            console.warn(`[materialConvert] Bộ slide ${deckId}: không tạo được ảnh thu nhỏ —`, err.message)
        }
        const byNumber = (prefix) =>
            new Map(
                fs.readdirSync(outDir)
                    .filter((f) => new RegExp(`^${prefix}-\\d+\\.jpg$`).test(f))
                    .map((f) => [Number(f.match(/\d+/)[0]), f])
            )
        const thumbs = byNumber('thumb')

        // pdftoppm đánh số có đệm số 0 theo tổng số trang (page-01.jpg…), nên
        // sắp theo SỐ chứ không theo chuỗi.
        const files = (await fs.promises.readdir(outDir))
            .filter((f) => /^page-\d+\.jpg$/.test(f))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        if (files.length === 0) throw new Error('File không có trang nào.')
        if (files.length > MAX_PAGES) {
            throw new Error(`Bộ slide dài quá ${MAX_PAGES} trang. Hãy tách thành nhiều bộ nhỏ.`)
        }

        const pages = []
        for (const file of files) {
            const head = Buffer.alloc(64 * 1024)
            const fd = await fs.promises.open(path.join(outDir, file), 'r')
            await fd.read(head, 0, head.length, 0)
            await fd.close()
            const size = jpegSize(head) || { width: 0, height: 0 }
            const n = Number(file.match(/\d+/)[0])
            pages.push({ file, thumb: thumbs.get(n) || '', width: size.width, height: size.height })
        }

        // Giảng viên có thể đã tải file khác trong lúc đang chuyển — chỉ ghi kết
        // quả nếu version vẫn là version vừa chuyển.
        const res = await MaterialDeck.updateOne(
            { _id: deckId, version },
            { $set: { pages, conversion: 'ready', conversionError: '' } }
        )
        if (res.matchedCount) await removeOldVersions(deckId, version)
    } catch (err) {
        console.error(`[materialConvert] Bộ slide ${deckId}:`, err.message, err.stderr ? String(err.stderr).slice(0, 500) : '')
        const set = { conversion: 'failed', conversionError: err.message.slice(0, 300), pages: [] }
        // Thêm bằng link mà chưa lấy được tên: đừng để mãi "Đang lấy tên file…".
        if (deck.titleFromSource) {
            set.title = err.filename ? path.parse(err.filename).name.slice(0, 200) : 'Bài giảng từ Google (chưa lấy được)'
        }
        await MaterialDeck.updateOne({ _id: deckId, version }, { $set: set })
    } finally {
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => { })
    }
}

/** Xoá ảnh + file gốc của các version cũ hơn version đang dùng. */
async function removeOldVersions(deckId, keepVersion) {
    const dir = deckDir(deckId)
    let entries = []
    try {
        entries = await fs.promises.readdir(dir)
    } catch {
        return
    }
    for (const name of entries) {
        const m = name.match(/^(?:source-)?v(\d+)/)
        if (m && Number(m[1]) < keepVersion) {
            await fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => { })
        }
    }
}

/** Xoá hết file của một bộ slide (khi xoá bộ slide hoặc cả khoá). */
async function removeDeckFiles(deckId) {
    await fs.promises.rm(deckDir(deckId), { recursive: true, force: true }).catch(() => { })
}

// ---------- hàng đợi tuần tự ----------

let chain = Promise.resolve()
const queued = new Set()

function enqueueConversion(deckId) {
    const id = String(deckId)
    if (queued.has(id)) return
    queued.add(id)
    chain = chain
        .then(() => convertDeck(id))
        .catch((err) => console.error('[materialConvert] Lỗi không mong đợi:', err.message))
        .finally(() => queued.delete(id))
}

/**
 * Lúc máy chủ khởi động: chạy lại các bộ slide đang chuyển dở (máy chủ bị tắt
 * giữa chừng), và cảnh báo nếu thiếu công cụ chuyển đổi.
 */
async function resumeMaterialConversions() {
    for (const [cmd, args] of [['soffice', ['--version']], ['pdftoppm', ['-v']]]) {
        try {
            await run(cmd, args, 20000)
        } catch (err) {
            console.warn(`[materialConvert] CẢNH BÁO: ${err.message} Tải slide lên sẽ báo lỗi cho tới khi cài.`)
        }
    }
    const pending = await MaterialDeck.find({ conversion: 'processing' }).select('_id').lean()
    pending.forEach((d) => enqueueConversion(d._id))
    if (pending.length) console.log(`[materialConvert] Chuyển tiếp ${pending.length} bộ slide còn dở.`)
}

module.exports = {
    MATERIALS_DIR,
    parseGoogleLink,
    parseGoogleSlidesId,
    listDriveFolder,
    dispositionFilename,
    sniffExt,
    ALLOWED_EXTS,
    OFFICE_EXTS,
    deckDir,
    sourcePath,
    pagesDir,
    pagePath,
    jpegSize,
    enqueueConversion,
    convertDeck,
    removeDeckFiles,
    removeOldVersions,
    resumeMaterialConversions,
}
