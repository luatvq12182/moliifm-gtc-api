# Từ điển từ ghép — `src/data/compounds.txt`

## Dùng để làm gì

`wordSegmentation.js` phân từ theo **dấu cách trong phiên âm bài học**. Cách đó
phản ánh đúng ý người soạn và chính xác hơn thư viện phân từ tự động, nhưng
chính tả pinyin đôi khi tách rời cái mà từ vựng coi là một từ:

```
您好！   <->  "Nín hǎo!"   ->  hai token  ->  hai ô chữ:  您 | 好
```

Khách hàng (cử nhân tiếng Trung) yêu cầu: giữ hai ô để luyện từng chữ, **và**
bổ sung một ô nghe cả từ đọc liền. `compoundWords.js` dò bằng từ điển này.

## Nguồn và giấy phép

CC-CEDICT — <https://www.mdbg.net/chinese/dictionary?page=cc-cedict>
Giấy phép **CC BY-SA 4.0**. Tác phẩm gốc: CEDICT, © 1997–1998 Paul Andrew Denisowski.

> **Cần lưu ý về pháp lý.** CC BY-SA đòi hỏi ghi công (đã ghi trong header của
> `compounds.txt`) và điều khoản **chia sẻ tương tự** áp lên bản phái sinh của
> *cơ sở dữ liệu*. Nếu điều này vướng với mô hình kinh doanh, phương án thay thế
> là tự soạn danh sách từ HSK 1-4 (khoảng 1.200 từ) — danh sách từ vựng theo cấp
> độ là dữ kiện, không phải tác phẩm có bản quyền.

## Tạo lại

```bash
curl -o cedict.txt.gz https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
gunzip cedict.txt.gz
node -e '
const fs=require("fs")
const HAN=/^[一-鿿]+$/
const out=new Set()
for(const line of fs.readFileSync("cedict.txt","utf8").split("\n")){
  if(!line||line[0]==="#") continue
  const m=line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/)
  if(!m) continue
  const [,,simp,pin,defs]=m
  if(!HAN.test(simp)||simp.length<2||simp.length>4) continue
  if(/[A-Z]/.test(pin)) continue                                   // danh từ riêng
  if(/(^|\/)(variant of|old variant|erhua variant)/.test(defs)) continue
  out.add(simp)
}
fs.writeFileSync("compounds.body.txt",[...out].sort().join("\n"))
console.log(out.size+" từ")
'
```

Rồi ghép lại phần header ghi công (10 dòng đầu của file hiện tại) với
`compounds.body.txt`.

**Bộ lọc, và lý do:**

| Bỏ | Vì sao |
|---|---|
| Mục dài < 2 hoặc > 4 chữ | Chỉ gộp tối đa 3 ô liền nhau, không quá 4 chữ. |
| Phiên âm có chữ **hoa** | Quy ước CC-CEDICT cho danh từ riêng (`[Bei3 jing1]`). Gộp trúng tên riêng là sai. |
| `variant of` / `old variant` | Dạng chữ hiếm, không phải từ học viên gặp. |

Đừng dùng cờ `/i` cho phép thử `[A-Z]` — với `/i` thì `[A-Z]` khớp cả chữ
thường, và bộ lọc nuốt oan hàng loạt từ hợp lệ (`再见` từng bị loại vì vậy).

## Chốt chặn khi gộp

Xem `src/lib/compoundWords.js`. Hai điều kiện, kiểm bằng `npm run verify` mục 5:

1. **Tối đa 3 ô / 4 chữ.** Nới rộng hơn thì bắt đầu gộp trúng những cụm chỉ tình
   cờ tạo thành một mục từ điển.
2. **Chuỗi ghép phải xuất hiện liền mạch trong câu gốc.** iFLYTEK chỉ trả về chữ
   Hán, đã lược dấu câu — không có chốt này thì 大卫 và 今天 trong
   "大卫，今天天气怎么样？" có thể bị gộp xuyên qua dấu phẩy.
