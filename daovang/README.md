# ⛏️ Đào Vàng – bot game Telegram

Game bấm để đào vàng (kiểu Hamster Kombat) chạy ngay trong Telegram dưới dạng **Mini App**, thu tiền bằng **Telegram Stars ⭐**.
Đây là game riêng, không dùng chung dữ liệu với Chợ Lá Xanh.

- `index.html`: giao diện game. GitHub Pages phục vụ tại `https://minhvy107.github.io/cholaxanh/daovang/`.
  Mở bằng trình duyệt thường thì chạy **bản xem thử**, lưu trên máy đó.
- `server/`: máy chủ Cloudflare Worker + cơ sở dữ liệu D1 (cả hai có gói miễn phí).

## Lối chơi
- ⛏️ Bấm tảng đá để nhận vàng. Mỗi lần bấm tốn 1 ⚡; năng lượng hồi 1 điểm mỗi giây.
- ⬆️ Nâng cấp bằng vàng: **Cuốc chim** (thêm vàng mỗi lần bấm), **Thợ mỏ** (vàng mỗi giây, vẫn đào khi offline tối đa 3 giờ), **Bình năng lượng**.
- 🎁 Quà mỗi ngày: nhận liên tiếp được nhiều hơn.
- 🏆 Bảng xếp hạng theo tổng vàng đã đào.
- 👥 Mời bạn: người mời và người được mời đều nhận 2.500 vàng.
- ⭐ Cửa hàng Stars: Nạp đầy năng lượng (15⭐), x2 vàng 2 giờ (30⭐), Rương vàng (49⭐), Thợ mỏ vàng +50/giây vĩnh viễn (99⭐).

Mọi số liệu (vàng, cấp, năng lượng) nằm trên máy chủ. Trình duyệt chỉ gửi số lần bấm, máy chủ giới hạn tối đa 20 lần mỗi giây và không vượt quá năng lượng còn lại. Sửa code ở máy người chơi không tự tăng được vàng. Mỗi khoản Stars chỉ được cộng một lần, kể cả khi Telegram gửi lại thông báo.

## Cài đặt (làm được trên điện thoại)

### 1. Tạo bot
1. Mở **@BotFather** trên Telegram và gõ `/newbot`. Đặt tên, ví dụ "Đào Vàng", và username, ví dụ `daovang_vn_bot`. Nhận **token**.
2. Gõ `/newapp`, chọn bot vừa tạo, rồi điền URL `https://minhvy107.github.io/cholaxanh/daovang/` và short name, ví dụ `play`. Link chơi sẽ là `t.me/<username>/play`.
3. Trong `server/wrangler.toml`, điền `BOT_USERNAME` (không có @) và `SUPPORT` (ví dụ `@ten_cua_ban`).

### 2. Thêm secret cho GitHub Actions
Vào repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `DAOVANG_BOT_TOKEN`: token bot ở bước 1.
- `DAOVANG_ADMIN_KEY`: mật khẩu tự đặt, ít nhất 8 ký tự.
- `CLOUDFLARE_API_TOKEN`: đã có sẵn từ Chợ Lá Xanh. Cần thêm quyền **D1: Edit** (sửa token ở dash.cloudflare.com → My Profile → API Tokens).

### 3. Đưa máy chủ lên
Merge vào `main`, hoặc vào tab **Actions → "Cập nhật máy chủ Đào Vàng" → Run workflow**. Workflow sẽ:
tạo D1 → deploy Worker → nạp token → gọi `/setup` (tạo bảng, gắn webhook, lệnh `/start /paysupport /terms`, nút **⛏️ Chơi**).

Nếu địa chỉ Worker khác `https://daovang-bot.tnhn1311.workers.dev`, sửa hằng `API` ở đầu thẻ `<script>` trong `index.html`.

### Chạy tay (máy tính có Node.js)
```bash
cd daovang/server
npx wrangler d1 create daovang            # dán database_id vào wrangler.toml
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
# mở trên trình duyệt: https://daovang-bot.<tên>.workers.dev/setup?key=<ADMIN_KEY>
```

## Tiền Stars
- Stars người chơi trả vào số dư của bot. Xem trong @BotFather → bot → **Balance**, hoặc trong app Telegram ở phần quản lý bot.
- Rút ra TON qua **Fragment** sau khoảng 21 ngày. Mỗi lần rút tối thiểu 1.000⭐, mỗi Star được khoảng $0,013.
- Hoàn Stars cho một giao dịch: `https://<worker>/refund?key=<ADMIN_KEY>&charge=<telegram_payment_charge_id>`. Mã giao dịch có trong bảng `payments` của D1, xem ở Cloudflare → D1 → daovang → Console: `SELECT * FROM payments ORDER BY at DESC`.

## Lưu ý
- Hàng ảo bán trong Telegram **bắt buộc thu bằng Stars**, không được dẫn người chơi đi chuyển khoản ngoài.
- Không hứa đổi vàng lấy tiền hay tiền mã hóa (airdrop, token…), vì dễ bị coi là lừa đảo hoặc cờ bạc. Không tạo tài khoản ảo để bơm lượt mời: Telegram có thể khóa bot và giữ Stars.
- Gói miễn phí của D1 cho 100.000 lượt ghi mỗi ngày. Game gửi số lần bấm 4 giây một lần khi người chơi đang bấm. Đông người chơi thì nâng lên gói Workers Paid ($5/tháng).
