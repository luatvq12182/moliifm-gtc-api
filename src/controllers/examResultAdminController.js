const mongoose = require('mongoose')
const ExamAttempt = require('../models/ExamAttempt')
const ExamTest = require('../models/ExamTest')
const ExamLevel = require('../models/ExamLevel')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const { gradeAttempt, sweepExamAttempts } = require('../lib/examGrading')
const { SECTION_LABEL } = require('../lib/examAttempt')

/**
 * QUẢN TRỊ KẾT QUẢ LUYỆN THI: danh sách bài làm (lọc theo cấp / đề / trạng
 * thái / tìm thí sinh), xem chi tiết từng bài, cho AI chấm lại, chấm lại cả đề
 * sau khi sửa đáp án, xoá bài làm.
 */

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function notFound(res) {
    res.status(404)
    return new Error('Không tìm thấy bài làm.')
}

const rowView = (a, student, level) => ({
    _id: a._id,
    testId: a.testId,
    title: a.snapshot?.title || '',
    level: level ? { _id: level._id, name: level.name } : null,
    candidate: a.candidate,
    student: student ? { _id: student._id, name: student.name, phone: student.phone } : null,
    status: a.status,
    submitReason: a.submitReason,
    startedAt: a.startedAt,
    submittedAt: a.submittedAt,
    section: a.status === 'in_progress' ? a.sections?.[a.sectionIndex]?.id || null : null,
    result: a.result
        ? { total: a.result.total, max: a.result.max, passed: a.result.passed, passScore: a.result.passScore, sections: a.result.sections, ai: { status: a.result.ai?.status, error: a.result.ai?.error || '' } }
        : null,
})

/** GET /api/admin/exam/attempts?levelId=&testId=&status=&search=&page=&limit= */
const listAttempts = asyncHandler(async function listAttempts(req, res) {
    const { levelId, testId, status, search = '' } = req.query
    const query = {}
    if (isId(levelId)) query.levelId = levelId
    if (isId(testId)) query.testId = testId
    if (['in_progress', 'submitted'].includes(status)) query.status = status
    const q = String(search).trim()
    if (q) {
        const re = new RegExp(escapeRegex(q), 'i')
        const students = await Student.find({ $or: [{ name: re }, { phone: re }] }).select('_id').limit(500).lean()
        query.$or = [{ 'candidate.name': re }, { 'candidate.phone': re }, { 'candidate.classCode': re }, { student: { $in: students.map((s) => s._id) } }]
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const [rows, total] = await Promise.all([
        ExamAttempt.find(query).select('-answers -result.items -snapshot.groups -snapshot.keywords').sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        ExamAttempt.countDocuments(query),
    ])
    const [students, levels] = await Promise.all([
        Student.find({ _id: { $in: rows.map((r) => r.student) } }).select('name phone').lean(),
        ExamLevel.find({ _id: { $in: rows.map((r) => r.levelId) } }).select('name').lean(),
    ])
    const studentOf = new Map(students.map((s) => [String(s._id), s]))
    const levelOf = new Map(levels.map((l) => [String(l._id), l]))
    res.json({
        data: rows.map((a) => rowView(a, studentOf.get(String(a.student)), levelOf.get(String(a.levelId)))),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    })
})

async function loadAttempt(req, res) {
    const a = isId(req.params.id) ? await ExamAttempt.findById(req.params.id).lean() : null
    if (!a) throw notFound(res)
    return a
}

/** GET /api/admin/exam/attempts/:id — chi tiết (kèm từng câu, nhận xét AI). */
const getAttempt = asyncHandler(async function getAttempt(req, res) {
    const a = await loadAttempt(req, res)
    const [student, level] = await Promise.all([Student.findById(a.student).select('name phone').lean(), ExamLevel.findById(a.levelId).select('name').lean()])
    res.json({
        ...rowView(a, student, level),
        sections: a.sections.map((x) => ({ id: x.id, label: SECTION_LABEL[x.id], durationSec: x.durationSec })),
        groups: a.snapshot.groups,
        keywords: a.snapshot.keywords || {},
        answers: a.answers || {},
        result: a.result || null,
    })
})

/** POST /api/admin/exam/attempts/:id/regrade — chấm lại cả bài (kể cả AI, không tính hạn mức). */
const regradeAttempt = asyncHandler(async function regradeAttempt(req, res) {
    const a = await loadAttempt(req, res)
    if (a.status !== 'submitted') {
        res.status(400)
        throw new Error('Bài chưa nộp.')
    }
    await gradeAttempt(a._id, { ignoreLimit: true })
    req.params.id = String(a._id)
    return getAttempt(req, res)
})

const deleteAttempt = asyncHandler(async function deleteAttempt(req, res) {
    const a = await loadAttempt(req, res)
    await ExamAttempt.deleteOne({ _id: a._id })
    res.json({ deleted: true })
})

/**
 * POST /api/admin/exam/tests/:id/regrade — sửa đáp án xong, chấm lại phần máy
 * chấm của MỌI bài đã nộp của đề (giữ nguyên nhận xét AI phần đặt câu).
 */
const regradeTest = asyncHandler(async function regradeTest(req, res) {
    const test = isId(req.params.id) ? await ExamTest.findById(req.params.id).select('_id title').lean() : null
    if (!test) {
        res.status(404)
        throw new Error('Không tìm thấy đề.')
    }
    await sweepExamAttempts()
    const ids = await ExamAttempt.find({ testId: test._id, status: 'submitted' }).select('_id').lean()
    for (const { _id } of ids) await gradeAttempt(_id, { keepAi: true })
    res.json({ regraded: ids.length, message: `Đã chấm lại ${ids.length} bài của "${test.title}" theo đáp án hiện tại.` })
})

/** Số bài đã nộp của từng đề (cho danh sách đề / trang soạn đề). */
async function submittedCounts(testIds) {
    const rows = await ExamAttempt.aggregate([
        { $match: { testId: { $in: testIds }, status: 'submitted' } },
        { $group: { _id: '$testId', n: { $sum: 1 } } },
    ])
    return new Map(rows.map((r) => [String(r._id), r.n]))
}

module.exports = { listAttempts, getAttempt, regradeAttempt, deleteAttempt, regradeTest, submittedCounts }
