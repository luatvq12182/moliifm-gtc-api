/**
 * Soát chỉ mục lúc máy chủ khởi động và kêu to nếu sai.
 *
 * VÌ SAO CẦN: Mongoose tự tạo chỉ mục theo schema, NHƯNG nếu đã có chỉ mục
 * cùng tên với tuỳ chọn khác thì nó **giữ nguyên cái cũ và không báo gì**.
 * Đổi `email` thành tuỳ chọn (unique + sparse) mà cơ sở dữ liệu vẫn giữ bản
 * unique cũ thì hậu quả chỉ lộ ra rất muộn và rất khó đoán:
 *
 *   - Tạo học viên KHÔNG email: người đầu tiên được, người thứ hai báo
 *     'Giá trị "email" đã tồn tại' — trong khi họ có nhập email nào đâu.
 *   - Nhập file hàng loạt: đúng một dòng vào được, toàn bộ phần còn lại bị
 *     loại với lý do khó hiểu.
 *
 * Đã xảy ra thật sau lần deploy đổi sang đăng nhập bằng số điện thoại.
 *
 * CHỈ CẢNH BÁO, KHÔNG TỰ SỬA. Dựng lại chỉ mục trên cơ sở dữ liệu đang chạy là
 * việc người vận hành phải biết mình đang làm gì — script migrate làm việc đó,
 * và nó còn xử luôn dữ liệu cũ (gỡ email rỗng, chuẩn hoá số) mà chỗ này không
 * làm được.
 */

const EXPECTED = [
    { collection: 'students', field: 'phone', unique: true, sparse: true },
    { collection: 'students', field: 'email', unique: true, sparse: true },
]

async function checkIndexes(connection) {
    const problems = []

    for (const want of EXPECTED) {
        let indexes
        try {
            indexes = await connection.collection(want.collection).indexes()
        } catch (err) {
            // Collection chưa tồn tại (cơ sở dữ liệu mới tinh) — không phải lỗi.
            continue
        }

        const found = indexes.find((i) => i.key && i.key[want.field] === 1)
        if (!found) {
            problems.push(`${want.collection}.${want.field}: chưa có chỉ mục`)
            continue
        }
        if (want.unique && !found.unique) {
            problems.push(`${want.collection}.${want.field}: thiếu "unique"`)
        }
        if (want.sparse && !found.sparse) {
            problems.push(
                `${want.collection}.${want.field}: thiếu "sparse" — học viên thứ hai bỏ trống ${want.field} sẽ không tạo được`
            )
        }
    }

    if (problems.length > 0) {
        const line = '='.repeat(74)
        console.warn('\n' + line)
        console.warn('  CẢNH BÁO: CHỈ MỤC CƠ SỞ DỮ LIỆU CHƯA ĐÚNG')
        console.warn(line)
        problems.forEach((p) => console.warn('  - ' + p))
        console.warn('')
        console.warn('  Chạy để sửa:  npm run migrate:phone-login -- --apply')
        console.warn('  Trong Docker:  docker exec <container> npm run migrate:phone-login -- --apply')
        console.warn(line + '\n')
    }

    return problems
}

module.exports = { checkIndexes }
