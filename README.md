# Thai PromptPay QR API

สร้าง QR Code รับเงินผ่าน PromptPay (เบอร์โทร / เลขบัตรประชาชน / TrueMoney Wallet)

## Deploy บน Render

1. Push โค้ดขึ้น GitHub repo
2. Render dashboard → **New** → **Web Service** → เลือก repo นี้
3. ตั้งค่า:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. ไม่ต้องตั้ง environment variable เพิ่มเติมใดๆ — ระบบไม่พึ่ง external service
   (Render จะ inject `PORT` ให้เองอัตโนมัติ โค้ดอ่านจาก `process.env.PORT` อยู่แล้ว)
5. กด **Create Web Service** รอ build เสร็จ ใช้งานได้ทันที

## รันเครื่อง local

```bash
npm install
npm start
# เปิด http://localhost:3000
```

## Endpoint หลัก

ดูเอกสารเต็มพร้อมฟอร์ม demo ทดลองได้ที่หน้าแรกของ service เอง (route `/`)

- `GET /qr/:id/:amount?` — สร้าง QR Code
- `GET /health` — status check

## หมายเหตุ

- โปรเจกต์นี้ deploy บน **Render** (ไม่ใช่ Vercel) — ไม่ต้องใช้ไฟล์ `vercel.json`
- รัน `npm audit` เป็นระยะเพื่อเช็ค dependency vulnerability (มี `overrides` บังคับ version ของ `qs` ไว้แล้วเพื่อปิดช่องโหว่ที่ต้นทาง `express` ยังไม่อัปเดต)