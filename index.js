const express = require('express');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const app = express();

// โลโก้ URL สำรอง (สามารถเปลี่ยนเป็น URL รูปโลโก้ของคุณเองได้)
const LOGOS = {
    PROMPTPAY: 'https://raw.githubusercontent.com/PromptPay/promptpay-logo/master/promptpay-logo.png',
    TRUEMONEY: 'https://www.truemoney.com/wp-content/uploads/2020/12/truemoneywallet-logo-icon.png',
    DEFAULT: 'https://raw.githubusercontent.com/PromptPay/promptpay-logo/master/promptpay-logo.png'
};

function calculateCRC16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        let c = data.charCodeAt(i);
        crc ^= (c << 8);
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function generateEWalletPayload(targetId, amount = 0) {
    const targetStr = String(targetId).trim();
    const amountNum = parseFloat(amount) || 0;
    
    let amountPayload = '';
    if (amountNum > 0) {
        const amountStr = amountNum.toFixed(2);
        amountPayload = `54${String(amountStr.length).padStart(2, '0')}${amountStr}`;
    }

    const merchantInfo = `0016A0000006770101110215${targetStr}`;
    const field29 = `29${String(merchantInfo.length).padStart(2, '0')}${merchantInfo}`;
    const qrType = amountNum > 0 ? '010212' : '010211';
    const raw = `000201${qrType}${field29}5303764${amountPayload}5802TH6304`;

    return raw + calculateCRC16(raw);
}

// ฟังก์ชันสำหรับวาดกรอบ และวางโลโก้ลงบน QR Code
async function drawDecoratedQR(payload, logoType) {
    const canvasSize = 600;
    const qrSize = 440;
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext('2d');

    // 1. วาดกรอบสี่เหลี่ยมขอบมน (Card Background)
    ctx.fillStyle = '#FFFFFF';
    ctx.roundRect(10, 10, canvasSize - 20, canvasSize - 20, 30);
    ctx.fill();
    
    // เส้นขอบการ์ดสวยๆ
    ctx.lineWidth = 6;
    ctx.strokeStyle = logoType === 'TRUEMONEY' ? '#FF5722' : '#003366'; // สีตามแบรนด์
    ctx.stroke();

    // 2. เจนรูป QR Code ตัวหลัก
    const qrBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'H', // ตั้งค่า High เพื่อให้รองรับการทับโลโก้ตรงกลางแล้วยังสแกนติด
        margin: 1,
        width: qrSize,
        color: { dark: '#000000', light: '#FFFFFF' }
    });
    const qrImage = await loadImage(qrBuffer);

    // วาด QR Code ลงตรงกลางการ์ด
    const qrX = (canvasSize - qrSize) / 2;
    const qrY = (canvasSize - qrSize) / 2;
    ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

    // 3. ใส่โลโก้ตรงกลาง
    try {
        const logoUrl = LOGOS[logoType] || LOGOS.DEFAULT;
        const logoImage = await loadImage(logoUrl);
        
        const logoSize = 90;
        const logoX = (canvasSize - logoSize) / 2;
        const logoY = (canvasSize - logoSize) / 2;
        const padding = 10;

        // วาดพื้นหลังขาวกลมๆ/มนๆ รองใต้โลโก้ เพื่อไม่ให้บังเส้น QR
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(canvasSize / 2, canvasSize / 2, (logoSize / 2) + padding, 0, Math.PI * 2);
        ctx.fill();

        // วาดรูปโลโก้
        ctx.drawImage(logoImage, logoX, logoY, logoSize, logoSize);
    } catch (e) {
        console.log('Logo loading failed, generating QR without logo:', e.message);
    }

    return canvas.toBuffer('image/png');
}

app.get('/qr/:id/:amount?', async (req, res) => {
    try {
        const { id, amount } = req.params;
        const targetId = String(id).replace(/[^0-9]/g, '').trim();
        const parsedAmount = amount ? parseFloat(amount) : 0;

        let payload = '';
        let logoType = 'PROMPTPAY';

        // เช็คประเภท ID เพื่อเลือกโครงสร้าง QR และโลโก้
        if (targetId.length === 15) {
            payload = generateEWalletPayload(targetId, parsedAmount);
            logoType = 'TRUEMONEY'; // ถ้าเป็น 15 หลัก เลือกโลโก้ TrueMoney
        } else {
            payload = generatePayload(targetId, { amount: parsedAmount });
            logoType = 'PROMPTPAY'; // 10 หรือ 13 หลัก เลือกโลโก้ PromptPay
        }

        // สร้างรูปภาพแบบมีกรอบและโลโก้
        const imageBuffer = await drawDecoratedQR(payload, logoType);

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(imageBuffer);

    } catch (err) {
        res.status(400).json({ error: 'Invalid Parameters', message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;