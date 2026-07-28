const Curriculum = require('../models/Curriculum')
const asyncHandler = require('../utils/asyncHandler')

const listPublicCurricula = asyncHandler(async function listPublicCurricula(req, res) {
    const curricula = await Curriculum.find({ status: 'published' }).sort({ order: 1 })
    res.json(curricula)
})

const getPublicCurriculum = asyncHandler(async function getPublicCurriculum(req, res) {
    const curriculum = await Curriculum.findOne({ slug: req.params.slug, status: 'published' })
    if (!curriculum) {
        res.status(404)
        throw new Error('Không tìm thấy giáo trình.')
    }
    res.json(curriculum)
})

const listAdminCurricula = asyncHandler(async function listAdminCurricula(req, res) {
    const curricula = await Curriculum.find().sort({ order: 1 })
    res.json(curricula)
})

const createCurriculum = asyncHandler(async function createCurriculum(req, res) {
    const { name, slug, description, thumbnail, order, status } = req.body

    if (!name || !slug) {
        res.status(400)
        throw new Error('Vui lòng nhập tên và slug giáo trình.')
    }

    const curriculum = await Curriculum.create({ name, slug, description, thumbnail, order, status })
    res.status(201).json(curriculum)
})

const updateCurriculum = asyncHandler(async function updateCurriculum(req, res) {
    const curriculum = await Curriculum.findById(req.params.id)
    if (!curriculum) {
        res.status(404)
        throw new Error('Không tìm thấy giáo trình.')
    }

    const fields = ['name', 'slug', 'description', 'thumbnail', 'order', 'status']
    fields.forEach((f) => {
        if (req.body[f] !== undefined) curriculum[f] = req.body[f]
    })

    await curriculum.save()
    res.json(curriculum)
})

const deleteCurriculum = asyncHandler(async function deleteCurriculum(req, res) {
    const curriculum = await Curriculum.findById(req.params.id)
    if (!curriculum) {
        res.status(404)
        throw new Error('Không tìm thấy giáo trình.')
    }

    // Lưu ý: chưa kiểm tra ràng buộc "còn Course thuộc giáo trình này không"
    // trước khi xóa — cân nhắc chặn xóa nếu vẫn còn Course con, tránh dữ liệu
    // mồ côi (Course trỏ tới curriculumId không còn tồn tại).
    await curriculum.deleteOne()
    res.json({ message: 'Đã xóa giáo trình.' })
})

module.exports = {
    listPublicCurricula,
    getPublicCurriculum,
    listAdminCurricula,
    createCurriculum,
    updateCurriculum,
    deleteCurriculum,
}