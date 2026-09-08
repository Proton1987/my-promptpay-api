const express = require('express');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const app = express();

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

// ฟังก์ชันวาดโลโก้ Vector TrueMoney / PromptPay ตรงกลาง
function drawCenterLogo(ctx, cx, cy, logoType) {
    // ขยายความกว้างกล่องเพื่อรองรับตัวอักษรที่ยาวขึ้น
    const boxWidth = 140;  
    const boxHeight = 50;  
    const x = cx - boxWidth / 2;
    const y = cy - boxHeight / 2;

    // 1. วาดพื้นหลังกลม/มนสีขาวรองใต้โลโก้ (ป้องกันทับลาย QR)
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(x - 6, y - 6, boxWidth + 12, boxHeight + 12, 16);
    ctx.fill();

    if (logoType === 'TRUEMONEY') {
        // วาดกล่องสีส้ม + ข้อความ TrueMoney
        ctx.fillStyle = '#FF5722';
        ctx.beginPath();
        ctx.roundRect(x, y, boxWidth, boxHeight, 12);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('TrueMoney', cx, cy);
    } else {
        // วาดกล่องสีน้ำเงิน + ข้อความ PromptPay
        ctx.fillStyle = '#003366';
        ctx.beginPath();
        ctx.roundRect(x, y, boxWidth, boxHeight, 12);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PromptPay', cx, cy);
    }
}

// ฟังก์ชันวาดการ์ด กรอบ และประกอบรูปภาพ
async function drawDecoratedQR(payload, logoType) {
    const canvasSize = 600;
    const qrSize = 440;
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext('2d');

    // 1. วาดการ์ดหลังสีขาว
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(10, 10, canvasSize - 20, canvasSize - 20, 32);
    ctx.fill();
    
    // 2. วาดขอบการ์ดตามสีแบรนด์
    ctx.lineWidth = 8;
    ctx.strokeStyle = logoType === 'TRUEMONEY' ? '#FF5722' : '#003366';
    ctx.stroke();

    // 3. เจนรูป QR Code ตัวหลัก
    const qrBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'H', // ตั้งเป็น High เพื่อให้สแกนติดแม้โดนทับตรงกลาง
        margin: 1,
        width: qrSize,
        color: { dark: '#000000', light: '#FFFFFF' }
    });
    const qrImage = await loadImage(qrBuffer);

    // วาด QR Code ลงตรงกลาง
    const qrX = (canvasSize - qrSize) / 2;
    const qrY = (canvasSize - qrSize) / 2;
    ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

    // 4. วาดโลโก้การ์ตูน/สัญลักษณ์แบรนด์ตรงกลาง
    drawCenterLogo(ctx, canvasSize / 2, canvasSize / 2, logoType);

    return canvas.toBuffer('image/png');
}

app.get('/qr/:id/:amount?', async (req, res) => {
    try {
        const { id, amount } = req.params;
        const targetId = String(id).replace(/[^0-9]/g, '').trim();
        const parsedAmount = amount ? parseFloat(amount) : 0;

        let payload = '';
        let logoType = 'PROMPTPAY';

        if (targetId.length === 15) {
            payload = generateEWalletPayload(targetId, parsedAmount);
            logoType = 'TRUEMONEY';
        } else {
            payload = generatePayload(targetId, { amount: parsedAmount });
            logoType = 'PROMPTPAY';
        }

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