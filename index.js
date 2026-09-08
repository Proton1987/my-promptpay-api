const express = require('express');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const app = express();

/**
 * ฟังก์ชันคำนวณ CRC16 (CCITT-FALSE / XMODEM)
 */
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

/**
 * สร้าง EMVCo Payload สำหรับ e-Wallet ID (15 หลัก) เช่น TrueMoney, ShopeePay
 */
function generateEWalletPayload(targetId, amount = 0) {
    const targetStr = String(targetId).trim();
    const amountNum = parseFloat(amount) || 0;
    
    // Formatting Amount (Tag 54)
    let amountPayload = '';
    if (amountNum > 0) {
        const amountStr = amountNum.toFixed(2);
        const amountLen = String(amountStr.length).padStart(2, '0');
        amountPayload = `54${amountLen}${amountStr}`;
    }

    // Formatting Merchant Info (Tag 29) - e-Wallet Standard (A000000677010111)
    const merchantInfo = `0016A0000006770101110215${targetStr}`;
    const merchantLen = String(merchantInfo.length).padStart(2, '0');
    const field29 = `29${merchantLen}${merchantInfo}`;

    // Static (11) หรือ Dynamic (12) ตามการระบุยอดเงิน
    const qrType = amountNum > 0 ? '010212' : '010211';

    // Base Raw EMVCo Payload
    const raw = `000201${qrType}${field29}5303764${amountPayload}5802TH6304`;

    return raw + calculateCRC16(raw);
}

/**
 * สร้าง EMVCo Payload สำหรับ Bill Payment / Biller ID (15 หลัก)
 */
function generateBillerPayload(billerId, ref1 = '', ref2 = '', amount = 0) {
    const billerStr = String(billerId).trim();
    const amountNum = parseFloat(amount) || 0;

    let amountPayload = '';
    if (amountNum > 0) {
        const amountStr = amountNum.toFixed(2);
        const amountLen = String(amountStr.length).padStart(2, '0');
        amountPayload = `54${amountLen}${amountStr}`;
    }

    // Tag 30 - Bill Payment Standard (A000000677010112)
    let subFields = `0016A0000006770101120115${billerStr}`;
    if (ref1) subFields += `02${String(ref1.length).padStart(2, '0')}${ref1}`;
    if (ref2) subFields += `03${String(ref2.length).padStart(2, '0')}${ref2}`;

    const field30 = `30${String(subFields.length).padStart(2, '0')}${subFields}`;
    const qrType = amountNum > 0 ? '010212' : '010211';

    const raw = `000201${qrType}${field30}5303764${amountPayload}5802TH6304`;

    return raw + calculateCRC16(raw);
}

// API Endpoint หลัก: /qr/:id/:amount?
app.get('/qr/:id/:amount?', async (req, res) => {
    try {
        const { id, amount } = req.params;
        const { ref1, ref2, type } = req.query; // ตัวเลือกเสริมส่งผ่าน Query String
        
        const targetId = String(id).replace(/[^0-9]/g, '').trim(); // ลบขีดหรือช่องว่างออกให้เหลือเฉพาะตัวเลข
        const parsedAmount = amount ? parseFloat(amount) : 0;

        let payload = '';

        // แยกตรวจสอบประเภทข้อมูลอัตโนมัติ
        if (type === 'biller') {
            // บังคับใช้ Bill Payment
            payload = generateBillerPayload(targetId, ref1, ref2, parsedAmount);
        } else if (targetId.length === 15) {
            // e-Wallet ID (เช่น TrueMoney 14000xxxxxxxxxx)
            payload = generateEWalletPayload(targetId, parsedAmount);
        } else if (targetId.length === 10 || targetId.length === 13) {
            // เบอร์โทรศัพท์ (10 หลัก) หรือ เลขบัตรประชาชน/ผู้เสียภาษี (13 หลัก)
            payload = generatePayload(targetId, { amount: parsedAmount });
        } else {
            // ลองใช้ไลบรารีมาตรฐานแปลงเบอร์หรือเลขบัญชี
            payload = generatePayload(targetId, { amount: parsedAmount });
        }

        // ตั้งค่า Response และเปลี่ยนเป็นรูปภาพ PNG
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        
        await QRCode.toFileStream(res, payload, {
            margin: 2,
            width: 500,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });
    } catch (err) {
        res.status(400).json({ error: 'Invalid Parameters', message: err.message });
    }
});

// หน้า Home สำหรับเช็คสถานะ
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        supported_types: [
            'Mobile Phone (10 digits)',
            'National ID / Tax ID (13 digits)',
            'TrueMoney & e-Wallet ID (15 digits)',
            'PromptPay Bill Payment (Biller ID)'
        ],
        example_usage: '/qr/140000000000000/100'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;