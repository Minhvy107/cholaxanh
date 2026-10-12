# 💞 Mơ AI – trò chuyện cùng nhân vật AI trên Telegram

Mini App kiểu "bạn đồng hành AI": chọn nhân vật, trò chuyện có trí nhớ, chơi theo kịch bản, mở khóa ảnh. Thu tiền bằng ⭐ Telegram Stars và 💳 chuyển khoản VietQR.
Nội dung giữ ở mức **lãng mạn, không khiêu dâm**, có bước xác nhận 18+.

- `index.html`: giao diện (GitHub Pages: `https://minhvy107.github.io/cholaxanh/mo-ai/`). Mở ngoài Telegram thì chạy **bản xem thử** với câu trả lời mẫu.
- `server/`: Cloudflare Worker + D1 + Claude API (SDK `@anthropic-ai/sdk`).
  - `chars.js`: **nhân vật** (tên, tuổi, tính cách, câu chào, kịch bản, ảnh). Sửa ở đây để thêm hoặc đổi nhân vật.
  - `worker.js`: chat, lượt miễn phí, ví 💗, VIP, mở khóa ảnh, Stars, chuyển khoản.

## Tính năng
- 6 nhân vật (4 nữ, 2 nam), mỗi người có tính cách, cách xưng hô và 2 kịch bản riêng.
- Trò chuyện có trí nhớ: gửi kèm 30 tin gần nhất. Chọn kịch bản thì bắt đầu cuộc trò chuyện mới.
- Mỗi ngày miễn phí **10 tin**. Hết lượt thì mỗi tin tốn **💗 1**. Người mới được tặng **💗 20**.
- Bộ sưu tập ảnh: ảnh miễn phí và ảnh khóa (💗 30).
- Gói bán:

| Gói | ⭐ Stars | 💳 Chuyển khoản |
|---|---|---|
| 💗 100 tim | 50 | 27.000đ |
| 💗 550 tim | 200 | 109.000đ |
| 👑 VIP 30 ngày (không giới hạn tin + 300 tim) | 250 | 135.000đ |

- Lời nhắc an toàn trong vai: không nội dung tình dục, người dùng dưới 18 tuổi thì chỉ trò chuyện như bạn bè, không xin tiền hay thông tin nhạy cảm, thành thật là AI khi được hỏi, có đường dây nóng khi người dùng gặp khủng hoảng.
- Câu nào AI từ chối trả lời thì không trừ lượt.

## ⚠️ Chi phí AI (đọc trước khi mở bán)
Mỗi tin nhắn gọi Claude API một lần và **tính tiền theo token**. Đây là ước tính thô, hãy theo dõi thực tế ở console.anthropic.com → Usage.

| Model (`CLAUDE_MODEL` trong `server/wrangler.toml`) | Ước tính / tin | Ghi chú |
|---|---|---|
| `claude-opus-5-5` (mặc định) | ~250–500đ | Trả lời hay nhất, đắt nhất |
| `claude-sonnet-5-5` | ~120–250đ | Cân bằng |
| `claude-haiku-5-5` | ~10–25đ | Rẻ nhất |

So sánh với tiền thu được: gói 💗 100 tim bằng Stars về tay bạn khoảng 165đ/tin, bằng chuyển khoản khoảng 270đ/tin. **Với model mặc định (Opus), tin trả phí có thể lỗ, và 10 tin miễn phí/ngày tốn khoảng 2.500–5.000đ cho mỗi người dùng.** Có thể đổi `CLAUDE_MODEL`, giảm `FREE_PER_DAY` hoặc tăng giá gói (`PACKS`) trong `server/worker.js`.

## Cài đặt
1. **Tạo bot:** @BotFather → `/newbot`. Sau đó `/newapp` với URL `https://minhvy107.github.io/cholaxanh/mo-ai/`, short name ví dụ `chat`.
2. **Khóa Claude API:** đăng ký tại https://console.anthropic.com, nạp tiền (Billing), rồi tạo **API Key** (Settings → API Keys).
3. **Thêm secret GitHub** (Settings → Secrets and variables → Actions):
   - `MOAI_BOT_TOKEN`: token bot
   - `MOAI_ADMIN_KEY`: mật khẩu tự đặt, ít nhất 8 ký tự
   - `MOAI_ANTHROPIC_KEY`: khóa Claude API
   - `MOAI_SEPAY_KEY` (tùy chọn): bật chuyển khoản. Thêm webhook SePay mới trỏ tới `https://mo-ai-bot.tnhn1311.workers.dev/sepay`, kiểu chứng thực API Key, dùng đúng khóa này.
4. **Merge vào `main`.** Workflow **"Cập nhật máy chủ Mơ AI"** sẽ tạo D1 `mo-ai`, deploy Worker, nạp khóa và gắn bot.

Tài khoản nhận chuyển khoản: `PAY_*` trong `server/wrangler.toml`.

## Thay ảnh minh họa bằng ảnh thật
Đặt ảnh vào `mo-ai/img/<id-nhân-vật>/`, ví dụ `mo-ai/img/linh/avatar.jpg`, rồi điền đường dẫn trong `server/chars.js`: `avatar: 'img/linh/avatar.jpg'`, và `img: 'img/linh/3.jpg'` cho từng ảnh trong `gallery`.
- Chỉ dùng ảnh bạn có quyền sử dụng: tự tạo bằng AI, mua bản quyền, hoặc người mẫu đã đồng ý. **Không dùng ảnh người thật lấy trên mạng**, không dùng ảnh khiêu dâm.
- Ảnh trên GitHub Pages là công khai: ai biết đường dẫn cũng mở được, kể cả ảnh "khóa". Muốn bảo vệ thật thì cần lưu ảnh khóa trên máy chủ (ví dụ Cloudflare R2) và chỉ trả cho người đã mở khóa.

## Hoàn tiền Stars
`https://mo-ai-bot.tnhn1311.workers.dev/refund?key=<ADMIN_KEY>&charge=<telegram_payment_charge_id>`. Mã giao dịch xem trong bảng `payments` của D1.

## Lưu ý
- Telegram quy định hàng ảo bán trong bot phải thu bằng Stars. Bật chuyển khoản trong app có thể khiến bot bị khóa nếu bị báo cáo.
- Không đưa nội dung khiêu dâm vào app, kể cả ảnh. Đó là vi phạm pháp luật Việt Nam và quy định của Telegram cũng như Anthropic.
