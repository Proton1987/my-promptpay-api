🇹🇭 Thai PromptPay QR API

บริการ API สำหรับสร้าง QR Code รับเงินผ่าน PromptPay ใช้งานง่ายผ่าน HTTP API รองรับข้อมูลผู้รับเงินแบบ เบอร์โทรศัพท์, เลขบัตรประชาชน และ TrueMoney Wallet

🔗 Live API: https://my-promptpay-api.onrender.com/

✨ Features

สร้าง QR Code สำหรับรับเงินผ่าน PromptPay

รองรับ เบอร์โทรศัพท์

รองรับ เลขบัตรประชาชน

รองรับ TrueMoney Wallet

รองรับการระบุจำนวนเงิน

มีหน้า Demo สำหรับทดลองใช้งานผ่านหน้าแรกของ API

มี Endpoint สำหรับตรวจสอบสถานะระบบ

🚀 API Endpoints

สร้าง PromptPay QR

GET /qr/:id/:amount?

สร้าง QR Code จากหมายเลขผู้รับเงิน โดยสามารถระบุจำนวนเงินเพิ่มเติมได้

Parameters

Parameter

Required

Description

id

✅

เบอร์โทรศัพท์ / เลขบัตรประชาชน / TrueMoney Wallet

amount

❌

จำนวนเงินที่ต้องการแสดงใน QR Code

ตัวอย่าง

https://my-promptpay-api.onrender.com/qr/0891234567

https://my-promptpay-api.onrender.com/qr/0891234567/100

ตรวจสอบสถานะ API

GET /health

ใช้สำหรับตรวจสอบสถานะการทำงานของ API

ตัวอย่าง:

https://my-promptpay-api.onrender.com/health

🧪 ทดลองใช้งาน

สามารถเปิดหน้าแรกของ API เพื่อดูเอกสารและทดลองสร้าง QR Code ได้โดยตรง:

https://my-promptpay-api.onrender.com/

📌 Important

โปรเจกต์นี้เปิดให้ใช้งานผ่าน API ที่กำหนดไว้ด้านบน โดยเอกสารนี้เน้นการใช้งาน API เท่านั้น และไม่ได้เผยแพร่ขั้นตอนการ Deploy หรือขั้นตอนสำหรับนำโปรเจกต์ไปติดตั้งเป็นบริการของบุคคลอื่น

Thai PromptPay QR API

สร้าง QR Code รับเงินผ่าน PromptPay ได้ง่ายและรวดเร็ว