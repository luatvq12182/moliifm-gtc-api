const AppSetting = require('../models/AppSetting')
const asyncHandler = require('../utils/asyncHandler')
const {
    gradeSentences,
    isAiConfigured,
    currentModel,
    fallbackModel,
    isValidModel,
    MODEL_KEY,
    MODEL_OPTIONS,
    currentRubric,
    DEFAULT_RUBRIC,
    RUBRIC_KEY,
    MAX_RUBRIC,
} = require('../lib/aiGrader')

/**
 * "CẤU HÌNH AI CHẤM" — admin sửa hướng dẫn chấm phần đặt câu ngay trên web,
 * và chấm thử trước khi lưu. Phần kỹ thuật (định dạng kết quả, chống chèn
 * lệnh) nằm cố định trong lib/aiGrader.js, không sửa ở đây.
 */

const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max)

async function settingsView() {
    const [cur, model] = await Promise.all([currentRubric(), currentModel()])
    return {
        rubric: cur.rubric,
        isDefault: cur.isDefault,
        updatedAt: cur.updatedAt,
        defaultRubric: DEFAULT_RUBRIC,
        maxLength: MAX_RUBRIC,
        model: model.model,
        modelSource: model.source, // 'admin' | 'env' | 'default'
        defaultModel: fallbackModel(),
        modelOptions: MODEL_OPTIONS,
        configured: isAiConfigured(),
    }
}

function badModel(res) {
    res.status(400)
    return new Error('Mã model không hợp lệ (dạng claude-…, vd. claude-sonnet-5).')
}

/** GET /api/admin/materials/ai-grading */
const getAiGrading = asyncHandler(async function getAiGrading(req, res) {
    res.json(await settingsView())
})

/**
 * PUT /api/admin/materials/ai-grading { rubric?, model? }
 *
 * Gửi trường nào lưu trường đó. Để trống / trùng bản mặc định = dùng mặc định
 * (hướng dẫn mặc định; model theo .env hoặc mặc định của hệ thống).
 */
const saveAiGrading = asyncHandler(async function saveAiGrading(req, res) {
    const by = req.admin?._id || null
    if (req.body.model !== undefined) {
        const model = String(req.body.model || '').trim()
        if (model && !isValidModel(model)) throw badModel(res)
        if (!model || model === fallbackModel()) await AppSetting.deleteOne({ key: MODEL_KEY })
        else await AppSetting.updateOne({ key: MODEL_KEY }, { $set: { value: model, updatedBy: by } }, { upsert: true })
    }
    if (req.body.rubric !== undefined) {
        const raw = String(req.body.rubric ?? '')
        if (raw.length > MAX_RUBRIC) {
            res.status(400)
            throw new Error(`Hướng dẫn chấm dài quá ${MAX_RUBRIC} ký tự.`)
        }
        const rubric = text(raw, MAX_RUBRIC)
        if (!rubric || rubric === DEFAULT_RUBRIC.trim()) await AppSetting.deleteOne({ key: RUBRIC_KEY })
        else await AppSetting.updateOne({ key: RUBRIC_KEY }, { $set: { value: rubric, updatedBy: by } }, { upsert: true })
    }
    res.json(await settingsView())
})

/**
 * POST /api/admin/materials/ai-grading/test { rubric?, model?, items: [{ word, sample, image, answer }] }
 *
 * Chấm thử bằng hướng dẫn / model đang chọn (chưa cần lưu). Tối đa 10 câu một lần.
 */
const testAiGrading = asyncHandler(async function testAiGrading(req, res) {
    if (!isAiConfigured()) {
        res.status(400)
        throw new Error('Máy chủ chưa có ANTHROPIC_API_KEY trong .env — chưa chấm thử được.')
    }
    const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 10) : []
    const items = list
        .map((it, i) => ({
            id: `t${i + 1}`,
            word: text(it?.word, 40),
            sample: text(it?.sample, 2000),
            image: /^\/uploads\//.test(String(it?.image || '')) ? text(it.image, 500) : '',
            answer: text(it?.answer, 300),
        }))
        .filter((it) => it.word)
    if (items.length === 0) {
        res.status(400)
        throw new Error('Nhập ít nhất một câu có từ cần đặt câu.')
    }
    const rubric = req.body.rubric !== undefined ? text(req.body.rubric, MAX_RUBRIC) : undefined
    const model = String(req.body.model || '').trim() || undefined
    if (model && !isValidModel(model)) throw badModel(res)
    let graded
    try {
        graded = await gradeSentences(items, { rubric, model })
    } catch (err) {
        res.status(502)
        throw err
    }
    res.json({ model: graded.model, items: items.map((it) => ({ ...it, ...graded.items[it.id], model: graded.model })) })
})

module.exports = { getAiGrading, saveAiGrading, testAiGrading }
