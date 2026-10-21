# 🍲 Quán Ngon Pixel

Game quản lý quán ăn pixel chơi trên trình duyệt, chỉ cần mở `index.html` (không cần cài đặt, không cần file ảnh: mọi hình pixel và âm thanh đều được vẽ/tạo bằng code). Giao diện dọc, hợp với điện thoại.

## Cách chơi
1. Khách đi vào, ngồi bàn và gọi món. Phiếu **B(số bàn)** hiện ở khay dưới, kèm thanh kiên nhẫn.
2. Chọn phiếu (hoặc chạm vào bàn trong quán), rồi bấm **món** (Còn N) và **đồ thêm** (nước, tráng miệng, thịt thêm…) để xếp mâm. Món cần lấy sẽ nhấp nháy.
3. Bấm **PHỤC VỤ**. Phục vụ nhanh để lên **Combo**, được nhiều sao và tiền boa hơn. Để khách chờ quá lâu thì khách bỏ về và quán bị đánh giá 1 sao.
4. Hết món thì bấm 🔥 để nấu 1 mẻ (4 phần). Thiếu nguyên liệu thì game tự nhập thêm nếu đủ tiền, hoặc nhập ở **Kho**.
5. Quán mở 8:00–22:00, đông khách lúc 11–13h và 18–20h. Cuối ngày có bảng tổng kết, trả lương và tiền mặt bằng.

## Tính năng
- **3 quán, mỗi quán một khung cảnh** (chuyển qua lại bằng nút ‹ ›):
  - 🍲 *Sôi Lẩu*: phố cửa xanh, mái hiên sọc đỏ. 7 món lẩu.
  - 🥭 *Lúc Lắc*: ăn vặt bờ sông lúc hoàng hôn, có cầu vòm và dây đèn. Mở ở cấp 6.
  - ☕ *Phố Hội*: phố cổ đèn lồng. Cà phê, bánh mì, cao lầu, mì Quảng. Mở ở cấp 12.
- **Thực đơn**: học món mới theo cấp, nâng cấp món để tăng giá bán (tối đa ★10), tạm ngưng bán món.
- **Nâng cấp**: thêm bàn (4 → 12), thêm bếp (1 → 5), bếp ga xịn (nấu nhanh), trang trí (khách kiên nhẫn hơn, thêm cây cảnh, đèn lồng, loa, biển OPEN, mèo thần tài), quảng cáo (thêm khách).
- **Nhân viên**: đầu bếp tự nấu khi sắp hết món, phục vụ tự bưng món ra bàn, quản lý kho tự nhập hàng; đào tạo để làm nhanh hơn.
- **Nhiệm vụ** liên tục (bán N phần món, phục vụ N bàn, đạt combo, kiếm doanh thu) có thưởng tiền và XP. Lên cấp có thưởng và mở món, mở quán mới.
- Đồ hoạ pixel chi tiết: nhân vật chibi có viền, mắt long lanh, nhiều kiểu tóc; bàn đá cẩm thạch chân vàng, ghế đẩu đỏ; quán lẩu 2 tầng có khách ngồi tầng trên, cầu thang, ban công hoa giấy và biển neon; nhà phố hai bên; bờ sông hoàng hôn có mây, cầu Rồng, thuyền đèn lồng.
- Đánh giá sao trung bình ảnh hưởng lượng khách. Có ngày đêm với đèn sáng buổi tối, người đi đường, xe máy, shipper giao hàng khi nhập nguyên liệu.
- Tốc độ 1×/2×/3×, tạm dừng, thu gọn khay để xem quán rộng hơn, âm thanh bật/tắt, tự lưu trên máy (`localStorage`).
