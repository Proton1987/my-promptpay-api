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

// ฟังก์ชันแปลง SVG PromptPay เป็น Image Buffer แล้ววาดลง Canvas
async function drawPromptPaySVG(ctx, x, y, width, height) {
    const svgString = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 140" width="${width}" height="${height}">
      <g transform="translate(10, 10)">
        <g id="promptpay-icon">
          <path d="M 40 45 C 40 20, 70 20, 70 45 C 70 70, 20 60, 20 85 C 20 110, 50 110, 50 85" fill="none" stroke="#002d63" stroke-width="14" stroke-linecap="round"/>
          <path d="M 50 75 C 50 100, 20 100, 20 75 C 20 50, 70 60, 70 35 C 70 10, 40 10, 40 35" fill="none" stroke="#fa9e1b" stroke-width="14" stroke-linecap="round"/>
          <circle cx="40" cy="35" r="7" fill="#002d63"/>
          <circle cx="50" cy="85" r="7" fill="#fa9e1b"/>
        </g>
        <g id="promptpay-text" transform="translate(100, 0)">
          <text x="0" y="70" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="900" fill="#002d63" letter-spacing="-2">prompt</text>
          <text x="215" y="70" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="900" fill="#fa9e1b" letter-spacing="-2">pay</text>
        </g>
      </g>
    </svg>`;

    const img = await loadImage(Buffer.from(svgString));
    ctx.drawImage(img, x, y, width, height);
}

async function createThaiQRCard(payload, targetId, amount) {
    const width = 750;
    const height = 900;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const isTrueMoney = targetId.length === 15;

    // 1. วาดพื้นหลังทั้งรูปตามแบรนด์
    ctx.fillStyle = isTrueMoney ? '#FF6B00' : '#EBF6FF';
    ctx.fillRect(0, 0, width, height);

    // 2. ข้อความยี่ห้อด้านบน
    ctx.fillStyle = isTrueMoney ? '#FFFFFF' : '#1BA5E1';
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isTrueMoney ? 'truemoney' : 'Krungthai กรุงไทย', width / 2, 75);

    // 3. วาดการ์ดสีขาวตรงกลาง
    const cardX = 50;
    const cardY = 120;
    const cardW = 650;
    const cardH = 720;
    const borderRadius = 24;

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, borderRadius);
    ctx.fill();

    // 4. แถบ Header สีน้ำเงินเข้ม (THAI QR PAYMENT)
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, borderRadius);
    ctx.clip();

    ctx.fillStyle = '#0F3B7A';
    ctx.fillRect(cardX, cardY, cardW, 90);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('THAI QR PAYMENT', width / 2, cardY + 55);
    ctx.restore();

    // 5. วาดโลโก้ PromptPay SVG เหนือ QR Code
    const svgW = 260;
    const svgH = 80;
    const svgX = (width - svgW) / 2;
    const svgY = cardY + 110;
    await drawPromptPaySVG(ctx, svgX, svgY, svgW, svgH);

    // 6. วาด QR Code
    const qrSize = 430;
    const qrX = (width - qrSize) / 2;
    const qrY = svgY + svgH + 10;

    const qrBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: qrSize,
        color: { dark: '#000000', light: '#FFFFFF' }
    });
    const qrImage = await loadImage(qrBuffer);
    ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

    // 7. วาดไอคอนสี่เหลี่ยมเล็กตรงกลาง QR Code
    const iconSize = 48;
    const iconX = (width - iconSize) / 2;
    const iconY = qrY + (qrSize - iconSize) / 2;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(iconX - 4, iconY - 4, iconSize + 8, iconSize + 8);

    ctx.fillStyle = '#0F3B7A';
    ctx.fillRect(iconX, iconY, iconSize, iconSize);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('QR', width / 2, iconY + 28);

    // 8. แสดงจำนวนเงิน (ถ้ามีการระบุยอด)
    if (amount > 0) {
        ctx.fillStyle = '#00A859';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`จำนวนเงิน ${amount.toLocaleString()} บาท`, width / 2, qrY + qrSize + 45);
    }

    return canvas.toBuffer('image/png');
}

app.get('/qr/:id/:amount?', async (req, res) => {
    try {
        const { id, amount } = req.params;
        const targetId = String(id).replace(/[^0-9]/g, '').trim();
        const parsedAmount = amount ? parseFloat(amount) : 0;

        let payload = '';
        if (targetId.length === 15) {
            payload = generateEWalletPayload(targetId, parsedAmount);
        } else {
            payload = generatePayload(targetId, { amount: parsedAmount });
        }

        const imageBuffer = await createThaiQRCard(payload, targetId, parsedAmount);

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