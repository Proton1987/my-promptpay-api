const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// =========================================================================
// Security headers
// =========================================================================
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"]
        }
    }
}));

app.use(cors());

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too Many Requests',
        message: 'เรียก API บ่อยเกินไป กรุณาลองใหม่อีกครั้งในอีกสักครู่'
    }
});

app.use(globalLimiter);

// รับ JSON body สำหรับ Payment API
app.use(express.json({ limit: '100kb' }));

// =========================================================================
// Font
// =========================================================================
try {
    GlobalFonts.registerFromPath(
        require.resolve('@fontsource/sarabun/files/sarabun-thai-400-normal.woff2'),
        'SarabunThai'
    );

    GlobalFonts.registerFromPath(
        require.resolve('@fontsource/sarabun/files/sarabun-latin-400-normal.woff2'),
        'SarabunLatin'
    );

    GlobalFonts.registerFromPath(
        require.resolve('@fontsource/sarabun/files/sarabun-thai-700-normal.woff2'),
        'SarabunThaiBold'
    );

    GlobalFonts.registerFromPath(
        require.resolve('@fontsource/sarabun/files/sarabun-latin-700-normal.woff2'),
        'SarabunLatinBold'
    );
} catch (err) {
    console.error(
        'ไม่สามารถโหลดฟอนต์ Sarabun ได้ ตัวอักษรไทยบนภาพอาจแสดงผลผิดพลาด:',
        err.message
    );
}

const FONT_REGULAR = '"SarabunThai", "SarabunLatin"';
const FONT_BOLD = '"SarabunThaiBold", "SarabunLatinBold"';

// =========================================================================
// Error logging
// =========================================================================
function logError(err, context = {}) {
    const errorId = Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase();

    console.error(
        `[${errorId}] [${context.route || 'unknown'}]`,
        err
    );

    return errorId;
}

// =========================================================================
// QR Rate Limit
// =========================================================================
const qrLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too Many Requests',
        message: 'เรียก API บ่อยเกินไป กรุณาลองใหม่อีกครั้งในอีกสักครู่'
    }
});

// =========================================================================
// Validation
// =========================================================================
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

function validateTargetId(rawId) {
    const id = String(rawId || '')
        .replace(/[^0-9]/g, '')
        .trim();

    if (!id) {
        throw new ValidationError(
            'กรุณาระบุหมายเลขพร้อมเพย์ (เบอร์โทร, เลขบัตรประชาชน หรือ TrueMoney Wallet ID)'
        );
    }

    if (![10, 13, 15].includes(id.length)) {
        throw new ValidationError(
            'รูปแบบหมายเลขไม่ถูกต้อง ต้องเป็นเบอร์โทร (10 หลัก), เลขบัตรประชาชน (13 หลัก) หรือ TrueMoney Wallet ID (15 หลัก)'
        );
    }

    if (id.length === 10 && !/^0[1-9]\d{8}$/.test(id)) {
        throw new ValidationError(
            'รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง'
        );
    }

    return id;
}

function validateAmount(rawAmount) {
    if (
        rawAmount === undefined ||
        rawAmount === null ||
        rawAmount === ''
    ) {
        return 0;
    }

    const amount = parseFloat(rawAmount);

    if (Number.isNaN(amount) || !Number.isFinite(amount)) {
        throw new ValidationError('จำนวนเงินไม่ถูกต้อง');
    }

    if (amount < 0) {
        throw new ValidationError('จำนวนเงินต้องไม่ติดลบ');
    }

    if (amount > 1000000) {
        throw new ValidationError(
            'จำนวนเงินต้องไม่เกิน 1,000,000 บาท'
        );
    }

    return Math.round(amount * 100) / 100;
}

function maskId(id) {
    if (id.length <= 7) {
        return id;
    }

    return `${id.slice(0, 3)}-xxx-${id.slice(-4)}`;
}

// =========================================================================
// Logo SVG
// =========================================================================

const TRUEMONEY_SVG = (w, h) => `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${w}"
    height="${h}"
    viewBox="0 0 120 80"
    fill="none"
>
    <rect
        x="2"
        y="2"
        width="116"
        height="76"
        rx="18"
        fill="#ffffff"
        opacity="0.95"
    />

    <circle
        cx="60"
        cy="40"
        r="27"
        fill="#f38020"
    />

    <path
        d="M45 40h30M60 25v30"
        stroke="#fff"
        stroke-width="7"
        stroke-linecap="round"
    />

    <text
        x="60"
        y="72"
        text-anchor="middle"
        font-family="Arial"
        font-size="10"
        font-weight="700"
        fill="#f38020"
    >
        TrueMoney
    </text>
</svg>
`;

const PROMPTPAY_HEADER_SVG = (w, h) => `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${w}"
    height="${h}"
    viewBox="0 0 644 215"
>
    <rect
        x="2"
        y="2"
        width="640"
        height="211"
        rx="24"
        fill="#ffffff"
    />

    <rect
        x="18"
        y="18"
        width="180"
        height="179"
        rx="20"
        fill="#002D63"
    />

    <path
        d="M63 55v55c0 24 19 43 43 43h42v-38h-31c-9 0-16-7-16-16V55H63z"
        fill="#fff"
    />

    <path
        d="M136 160v-48c0-9 7-16 16-16h31V58h-42c-24 0-43 19-43 43v59h38z"
        fill="#00A796"
    />

    <text
        x="220"
        y="105"
        font-family="Arial"
        font-size="64"
        font-weight="700"
        fill="#003d6b"
    >
        PromptPay
    </text>

    <text
        x="222"
        y="151"
        font-family="Arial"
        font-size="26"
        fill="#6B7280"
    >
        Thailand PromptPay
    </text>
</svg>
`;

const PROMPTPAY_ICON_SVG = (w, h) => `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${w}"
    height="${h}"
    viewBox="0 0 122 78"
>
    <rect
        x="1"
        y="1"
        width="120"
        height="76"
        rx="12"
        fill="#ffffff"
    />

    <path
        d="M35 12h-7c-9 0-16 7-16 16v22c0 9 7 16 16 16h19V54H34c-3 0-5-2-5-5V45h18V32H29v-4c0-3 2-5 5-5h19V12H35z"
        fill="#002D63"
    />

    <path
        d="M87 66h7c9 0 16-7 16-16V28c0-9-7-16-16-16H75v12h14c3 0 5 2 5 5v4H76v13h18v4c0 3-2 5-5 5H70v11h17z"
        fill="#00A796"
    />
</svg>
`;

// =========================================================================
// Image cache
// =========================================================================

const imageCache = new Map();

function getCachedImage(key, svgFactory, w, h) {
    const cacheKey = `${key}:${w}x${h}`;

    if (!imageCache.has(cacheKey)) {
        imageCache.set(
            cacheKey,
            loadImage(
                Buffer.from(svgFactory(w, h))
            )
        );
    }

    return imageCache.get(cacheKey);
}

// =========================================================================
// Design tokens
// =========================================================================

const COLORS = {
    krungthaiBgTop: '#E9F3FF',
    krungthaiBgBottom: '#CFE7FF',
    trueMoneyBgTop: '#FFA640',
    trueMoneyBgBottom: '#FF7A00',
    headerTop: '#0C3C78',
    headerBottom: '#155AA8',
    card: '#FFFFFF',
    textDark: '#1A2B3C',
    textGray: '#6B7280',
    textLight: '#9CA3AF',
    divider: '#E5EAF0',
    accent: '#00A796'
};

// =========================================================================
// Text
// =========================================================================

const TEXTS = {
    th: {
        subtitle: 'สแกนเพื่อชำระเงินผ่าน PromptPay',
        headerTitle: 'THAI QR PAYMENT',
        amountLabel: 'ยอดชำระ',
        dateLocale: 'th-TH',
        footer: (t) => `สร้างเมื่อ ${t} น.`
    },

    en: {
        subtitle: 'Scan to pay via PromptPay',
        headerTitle: 'THAI QR PAYMENT',
        amountLabel: 'Amount',
        dateLocale: 'en-GB',
        footer: (t) => `Generated at ${t}`
    }
};

// =========================================================================
// Create QR Card
// =========================================================================

async function createThaiQRCard(
    payload,
    targetId,
    amount = 0,
    options = {}
) {
    const {
        lang = 'th',
        showFooter = true
    } = options;

    const t = TEXTS[lang] || TEXTS.th;
    const isTrueMoney = targetId.length === 15;
    const hasAmount = amount > 0;

    const width = 750;

    const logoTopY = 34;
    const logoH = 69;
    const subtitleY = logoTopY + logoH + 30;

    const cardX = 45;
    const cardY = subtitleY + 27;
    const cardW = width - cardX * 2;
    const borderRadius = 28;

    const headerH = 92;
    const idLineY = cardY + headerH + 34;

    const ppW = 250;
    const ppH = 77;
    const ppY = idLineY + 18;

    const qrSize = 410;
    const qrPad = 22;
    const qrBoxSize = qrSize + qrPad * 2;
    const qrBoxY = ppY + ppH + 24;

    let cursorY = qrBoxY + qrBoxSize + 26;

    let amountLabelY = 0;
    let amountValueY = 0;
    let dividerY = 0;

    if (hasAmount) {
        dividerY = cursorY;
        amountLabelY = cursorY + 40;
        amountValueY = amountLabelY + 46;
        cursorY = amountValueY + 28;
    }

    let footerY = null;

    if (showFooter) {
        footerY = cursorY + 8;
        cursorY = footerY;
    }

    const cardH = cursorY + 26 - cardY;
    const height = cardY + cardH + 40;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    const bgGradient = ctx.createLinearGradient(
        0,
        0,
        0,
        height
    );

    if (isTrueMoney) {
        bgGradient.addColorStop(
            0,
            COLORS.trueMoneyBgTop
        );

        bgGradient.addColorStop(
            1,
            COLORS.trueMoneyBgBottom
        );
    } else {
        bgGradient.addColorStop(
            0,
            COLORS.krungthaiBgTop
        );

        bgGradient.addColorStop(
            1,
            COLORS.krungthaiBgBottom
        );
    }

    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Brand logo
    if (isTrueMoney) {
        const tmW = 170;

        const img = await getCachedImage(
            'truemoney',
            TRUEMONEY_SVG,
            tmW,
            logoH
        );

        ctx.drawImage(
            img,
            (width - tmW) / 2,
            logoTopY,
            tmW,
            logoH
        );
    } else {
        ctx.fillStyle = '#0C3C78';
        ctx.font = `38px ${FONT_BOLD}`;
        ctx.textAlign = 'center';

        ctx.fillText(
            'krungthai',
            width / 2,
            logoTopY + 44
        );
    }

    // Subtitle
    ctx.fillStyle = isTrueMoney
        ? 'rgba(255,255,255,0.92)'
        : COLORS.textGray;

    ctx.font = `20px ${FONT_REGULAR}`;
    ctx.textAlign = 'center';

    ctx.fillText(
        t.subtitle,
        width / 2,
        subtitleY
    );

    // Card
    ctx.save();

    ctx.shadowColor = 'rgba(15, 30, 60, 0.25)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = COLORS.card;

    ctx.beginPath();
    ctx.roundRect(
        cardX,
        cardY,
        cardW,
        cardH,
        borderRadius
    );
    ctx.fill();

    ctx.restore();

    // Header
    ctx.save();

    ctx.beginPath();

    ctx.roundRect(
        cardX,
        cardY,
        cardW,
        cardH,
        borderRadius
    );

    ctx.clip();

    const headerGradient = ctx.createLinearGradient(
        cardX,
        cardY,
        cardX + cardW,
        cardY
    );

    headerGradient.addColorStop(
        0,
        COLORS.headerTop
    );

    headerGradient.addColorStop(
        1,
        COLORS.headerBottom
    );

    ctx.fillStyle = headerGradient;

    ctx.fillRect(
        cardX,
        cardY,
        cardW,
        headerH
    );

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `26px ${FONT_BOLD}`;
    ctx.textAlign = 'center';

    ctx.fillText(
        t.headerTitle,
        width / 2,
        cardY + 57
    );

    ctx.restore();

    // Target ID
    ctx.fillStyle = COLORS.textGray;
    ctx.font = `18px ${FONT_REGULAR}`;
    ctx.textAlign = 'center';

    ctx.fillText(
        maskId(targetId),
        width / 2,
        idLineY
    );

    // PromptPay header
    const ppX = (width - ppW) / 2;

    const ppImg = await getCachedImage(
        'promptpay-header',
        PROMPTPAY_HEADER_SVG,
        ppW,
        ppH
    );

    ctx.drawImage(
        ppImg,
        ppX,
        ppY,
        ppW,
        ppH
    );

    // QR box
    const qrBoxX = (width - qrBoxSize) / 2;

    ctx.save();

    ctx.shadowColor = 'rgba(15, 30, 60, 0.12)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#FFFFFF';

    ctx.beginPath();

    ctx.roundRect(
        qrBoxX,
        qrBoxY,
        qrBoxSize,
        qrBoxSize,
        20
    );

    ctx.fill();

    ctx.restore();

    ctx.strokeStyle = COLORS.divider;
    ctx.lineWidth = 1.5;

    ctx.beginPath();

    ctx.roundRect(
        qrBoxX,
        qrBoxY,
        qrBoxSize,
        qrBoxSize,
        20
    );

    ctx.stroke();

    const qrX = qrBoxX + qrPad;
    const qrY = qrBoxY + qrPad;

    const qrBuffer = await QRCode.toBuffer(
        payload,
        {
            errorCorrectionLevel: 'H',
            margin: 0,
            width: qrSize,
            color: {
                dark: '#0A1F33',
                light: '#FFFFFF'
            }
        }
    );

    const qrImage = await loadImage(qrBuffer);

    ctx.drawImage(
        qrImage,
        qrX,
        qrY,
        qrSize,
        qrSize
    );

    // PromptPay center icon
    const iconW = 52;
    const iconH = 33;

    const iconX = (width - iconW) / 2;
    const iconY = qrY + (qrSize - iconH) / 2;

    ctx.save();

    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFFFFF';

    ctx.beginPath();

    ctx.roundRect(
        iconX - 7,
        iconY - 7,
        iconW + 14,
        iconH + 14,
        9
    );

    ctx.fill();

    ctx.restore();

    const iconImg = await getCachedImage(
        'promptpay-icon',
        PROMPTPAY_ICON_SVG,
        iconW,
        iconH
    );

    ctx.drawImage(
        iconImg,
        iconX,
        iconY,
        iconW,
        iconH
    );

    // Amount
    if (hasAmount) {
        ctx.strokeStyle = COLORS.divider;
        ctx.lineWidth = 1.5;

        ctx.beginPath();

        ctx.moveTo(
            cardX + 60,
            dividerY
        );

        ctx.lineTo(
            cardX + cardW - 60,
            dividerY
        );

        ctx.stroke();

        ctx.fillStyle = COLORS.textLight;
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.textAlign = 'center';

        ctx.fillText(
            t.amountLabel,
            width / 2,
            amountLabelY
        );

        ctx.fillStyle = COLORS.textDark;
        ctx.font = `40px ${FONT_BOLD}`;

        const amountText =
            amount.toLocaleString(
                'en-US',
                {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                }
            );

        ctx.fillText(
            `฿ ${amountText}`,
            width / 2,
            amountValueY
        );
    }

    // Footer
    if (showFooter) {
        ctx.fillStyle = COLORS.textLight;
        ctx.font = `15px ${FONT_REGULAR}`;
        ctx.textAlign = 'center';

        const generatedAt =
            new Date().toLocaleString(
                t.dateLocale,
                {
                    timeZone: 'Asia/Bangkok',
                    dateStyle: 'medium',
                    timeStyle: 'short'
                }
            );

        ctx.fillText(
            t.footer(generatedAt),
            width / 2,
            footerY
        );
    }

    return canvas.toBuffer('image/png');
}

// =========================================================================
// Bare QR
// =========================================================================

async function createBareQR(payload) {
    const qrSize = 400;
    const pad = 24;
    const size = qrSize + pad * 2;

    const canvas = createCanvas(
        size,
        size
    );

    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';

    ctx.fillRect(
        0,
        0,
        size,
        size
    );

    const qrBuffer = await QRCode.toBuffer(
        payload,
        {
            errorCorrectionLevel: 'H',
            margin: 0,
            width: qrSize,
            color: {
                dark: '#0A1F33',
                light: '#FFFFFF'
            }
        }
    );

    const qrImage = await loadImage(
        qrBuffer
    );

    ctx.drawImage(
        qrImage,
        pad,
        pad,
        qrSize,
        qrSize
    );

    const iconW = 50;
    const iconH = 32;

    const iconX = (size - iconW) / 2;
    const iconY = (size - iconH) / 2;

    ctx.save();

    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFFFFF';

    ctx.beginPath();

    ctx.roundRect(
        iconX - 7,
        iconY - 7,
        iconW + 14,
        iconH + 14,
        9
    );

    ctx.fill();

    ctx.restore();

    const iconImg = await getCachedImage(
        'promptpay-icon',
        PROMPTPAY_ICON_SVG,
        iconW,
        iconH
    );

    ctx.drawImage(
        iconImg,
        iconX,
        iconY,
        iconW,
        iconH
    );

    return canvas.toBuffer(
        'image/png'
    );
}

// =========================================================================
// Payment Core
// =========================================================================

const PAYMENT_EXPIRY_MS =
    30 * 60 * 1000;

function ensurePaymentStorage() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(
            DATA_DIR,
            {
                recursive: true
            }
        );
    }

    if (!fs.existsSync(PAYMENTS_FILE)) {
        fs.writeFileSync(
            PAYMENTS_FILE,
            '[]\n',
            'utf8'
        );
    }
}

function readPayments() {
    ensurePaymentStorage();

    try {
        const raw =
            fs.readFileSync(
                PAYMENTS_FILE,
                'utf8'
            );

        const data =
            JSON.parse(raw);

        if (!Array.isArray(data)) {
            throw new Error(
                'payments.json ต้องเป็น array'
            );
        }

        return data;
    } catch (err) {
        logError(
            err,
            {
                route: 'payment-storage-read'
            }
        );

        throw new Error(
            'ไม่สามารถอ่านข้อมูลธุรกรรมได้'
        );
    }
}

function writePayments(payments) {
    ensurePaymentStorage();

    const tempFile =
        `${PAYMENTS_FILE}.${process.pid}.tmp`;

    try {
        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                payments,
                null,
                2
            ) + '\n',
            'utf8'
        );

        fs.renameSync(
            tempFile,
            PAYMENTS_FILE
        );
    } catch (err) {
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (_) {}

        logError(
            err,
            {
                route: 'payment-storage-write'
            }
        );

        throw new Error(
            'ไม่สามารถบันทึกข้อมูลธุรกรรมได้'
        );
    }
}

function createPaymentId() {
    return `pay_${Date.now().toString(36)}_${crypto
        .randomBytes(4)
        .toString('hex')}`;
}

function normalizeReference(rawReference) {
    if (
        rawReference === undefined ||
        rawReference === null ||
        rawReference === ''
    ) {
        return null;
    }

    const reference =
        String(rawReference).trim();

    if (!reference) {
        return null;
    }

    if (reference.length > 100) {
        throw new ValidationError(
            'reference ต้องมีความยาวไม่เกิน 100 ตัวอักษร'
        );
    }

    return reference;
}

function getPaymentPublic(payment) {
    return {
        id: payment.id,
        reference: payment.reference,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        targetId: maskId(payment.targetId),
        createdAt: payment.createdAt,
        expiresAt: payment.expiresAt,
        cancelledAt: payment.cancelledAt || null,
        paidAt: payment.paidAt || null
    };
}

function expirePaymentIfNeeded(payment) {
    if (
        payment.status === 'pending' &&
        Date.now() >=
            new Date(payment.expiresAt).getTime()
    ) {
        payment.status = 'expired';
        return true;
    }

    return false;
}

function findPayment(payments, id) {
    return payments.find(
        payment => payment.id === id
    );
}

// =========================================================================
// ORDER SYSTEM
// =========================================================================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

const PAYMENT_EXPIRY_MINUTES = 30;

const ORDER_STATUSES = [
    'pending',
    'paid',
    'expired',
    'cancelled'
];

const PAYMENT_STATUSES = [
    'pending',
    'paid',
    'expired',
    'cancelled'
];

function ensureDataDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(ORDERS_FILE)) {
        fs.writeFileSync(ORDERS_FILE, '[]\n', 'utf8');
    }

    if (!fs.existsSync(PAYMENTS_FILE)) {
        fs.writeFileSync(PAYMENTS_FILE, '[]\n', 'utf8');
    }
}

ensureDataDirectory();

function readJsonFile(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');

        if (!raw.trim()) {
            return [];
        }

        const data = JSON.parse(raw);

        return Array.isArray(data) ? data : [];
    } catch (err) {
        logError(err, {
            route: 'readJsonFile',
            file
        });

        return [];
    }
}

function writeJsonFile(file, data) {
    const tempFile = `${file}.${process.pid}.tmp`;

    fs.writeFileSync(
        tempFile,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    fs.renameSync(tempFile, file);
}

function readOrders() {
    return readJsonFile(ORDERS_FILE);
}

function saveOrders(orders) {
    writeJsonFile(ORDERS_FILE, orders);
}

function readPayments() {
    return readJsonFile(PAYMENTS_FILE);
}

function savePayments(payments) {
    writeJsonFile(PAYMENTS_FILE, payments);
}

function createOrderId() {
    return `ord_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function createPaymentId() {
    return `pay_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeReference(reference) {
    if (
        reference === undefined ||
        reference === null ||
        reference === ''
    ) {
        return null;
    }

    const value = String(reference)
        .trim()
        .replace(/\s+/g, ' ');

    if (!value) {
        return null;
    }

    if (value.length > 100) {
        throw new ValidationError(
            'reference ต้องมีความยาวไม่เกิน 100 ตัวอักษร'
        );
    }

    return value;
}

function validateCustomer(customer) {
    if (
        customer === undefined ||
        customer === null
    ) {
        return null;
    }

    if (
        typeof customer !== 'object' ||
        Array.isArray(customer)
    ) {
        throw new ValidationError(
            'customer ต้องเป็น object'
        );
    }

    const result = {};

    if (customer.name !== undefined) {
        result.name = String(customer.name)
            .trim()
            .slice(0, 150);
    }

    if (customer.email !== undefined) {
        result.email = String(customer.email)
            .trim()
            .slice(0, 254);
    }

    if (customer.phone !== undefined) {
        result.phone = String(customer.phone)
            .trim()
            .slice(0, 30);
    }

    return result;
}

function validateOrderItems(items) {
    if (!Array.isArray(items)) {
        throw new ValidationError(
            'items ต้องเป็น array'
        );
    }

    if (items.length === 0) {
        throw new ValidationError(
            'ต้องมีสินค้าอย่างน้อย 1 รายการ'
        );
    }

    if (items.length > 100) {
        throw new ValidationError(
            'จำนวนสินค้าใน order ต้องไม่เกิน 100 รายการ'
        );
    }

    let total = 0;

    const normalizedItems = items.map((item, index) => {
        if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item)
        ) {
            throw new ValidationError(
                `items[${index}] ไม่ถูกต้อง`
            );
        }

        const name = String(item.name || '').trim();

        if (!name) {
            throw new ValidationError(
                `items[${index}].name จำเป็นต้องระบุ`
            );
        }

        if (name.length > 200) {
            throw new ValidationError(
                `items[${index}].name ยาวเกินไป`
            );
        }

        const quantity = Number(item.quantity);

        if (
            !Number.isFinite(quantity) ||
            quantity <= 0 ||
            quantity > 100000
        ) {
            throw new ValidationError(
                `items[${index}].quantity ไม่ถูกต้อง`
            );
        }

        if (!Number.isInteger(quantity)) {
            throw new ValidationError(
                `items[${index}].quantity ต้องเป็นจำนวนเต็ม`
            );
        }

        const price = Number(item.price);

        if (
            !Number.isFinite(price) ||
            price < 0 ||
            price > 1000000
        ) {
            throw new ValidationError(
                `items[${index}].price ไม่ถูกต้อง`
            );
        }

        const normalizedPrice =
            Math.round(price * 100) / 100;

        const lineTotal =
            Math.round(
                normalizedPrice * quantity * 100
            ) / 100;

        total += lineTotal;

        return {
            name,
            quantity,
            price: normalizedPrice,
            lineTotal
        };
    });

    total = Math.round(total * 100) / 100;

    if (total <= 0) {
        throw new ValidationError(
            'ยอด Order ต้องมากกว่า 0 บาท'
        );
    }

    if (total > 1000000) {
        throw new ValidationError(
            'ยอด Order ต้องไม่เกิน 1,000,000 บาท'
        );
    }

    return {
        items: normalizedItems,
        total
    };
}

function expirePaymentIfNeeded(payment) {
    if (
        payment.status === 'pending' &&
        payment.expiresAt &&
        Date.now() >= new Date(payment.expiresAt).getTime()
    ) {
        payment.status = 'expired';
        return true;
    }

    return false;
}

function expireOrderIfNeeded(order, payments) {
    if (
        order.status !== 'pending' ||
        !order.expiresAt
    ) {
        return false;
    }

    if (
        Date.now() <
        new Date(order.expiresAt).getTime()
    ) {
        return false;
    }

    order.status = 'expired';

    const payment = payments.find(
        item => item.id === order.paymentId
    );

    if (payment) {
        expirePaymentIfNeeded(payment);

        if (payment.status === 'pending') {
            payment.status = 'expired';
        }
    }

    return true;
}

function getPaymentPublic(payment) {
    return {
        id: payment.id,
        reference: payment.reference,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        targetId: maskId(payment.targetId),
        createdAt: payment.createdAt,
        expiresAt: payment.expiresAt,
        cancelledAt: payment.cancelledAt || null,
        paidAt: payment.paidAt || null,
        expiredAt: payment.expiredAt || null,
        needsReview: Array.isArray(payment.reviewFlags) && payment.reviewFlags.length > 0,
        payload: payment.payload,
        qrEndpoint: payment.qrEndpoint
    };
}

function getOrderPublic(order, payment) {
    return {
        id: order.id,
        reference: order.reference,
        status: order.status,
        amount: order.amount,
        currency: order.currency,
        customer: order.customer,
        items: order.items,
        createdAt: order.createdAt,
        expiresAt: order.expiresAt,
        cancelledAt: order.cancelledAt || null,
        paidAt: order.paidAt || null,
        payment: payment
            ? getPaymentPublic(payment)
            : null
    };
}

// =========================================================================
// Routes
// =========================================================================

const DOCS_HTML = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Thai PromptPay QR API</title>

<meta
    name="description"
    content="สร้าง QR Code รับเงินผ่าน PromptPay ฟรี รองรับเบอร์โทร เลขบัตรประชาชน และ TrueMoney Wallet"
>

<meta
    property="og:title"
    content="Thai PromptPay QR API"
>

<meta
    property="og:description"
    content="สร้าง QR Code รับเงินผ่าน PromptPay ฟรี รองรับเบอร์โทร เลขบัตรประชาชน และ TrueMoney Wallet"
>

<meta
    property="og:type"
    content="website"
>

<link
    rel="icon"
    href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230C3C78'/%3E%3Ctext x='50' y='70' font-size='58' text-anchor='middle' fill='white' font-family='sans-serif' font-weight='bold'%3E%E0%B8%BF%3C/text%3E%3C/svg%3E"
>

<link
    rel="preconnect"
    href="https://fonts.googleapis.com"
>

<link
    href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap"
    rel="stylesheet"
>

<style>
:root {
    --navy: #0C3C78;
    --navy-dark: #002D63;
    --blue: #155AA8;
    --teal: #00A796;
    --bg: #F4F7FB;
    --card: #FFFFFF;
    --border: #E5EAF0;
    --text: #1A2B3C;
    --text-gray: #6B7280;
}

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    font-family: 'Sarabun', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
}

header {
    position: relative;
    background: linear-gradient(
        135deg,
        var(--navy) 0%,
        var(--blue) 100%
    );
    color: #fff;
    padding: 48px 24px 40px;
    text-align: center;
}

header h1 {
    margin: 0 0 8px;
    font-size: 32px;
    font-weight: 700;
}

header p {
    margin: 0;
    opacity: .9;
    font-size: 16px;
}

.wrap {
    max-width: 880px;
    margin: 28px auto 60px;
    padding: 0 20px;
}

.card {
    background: var(--card);
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 10px 30px rgba(15,30,60,.08);
    margin-bottom: 24px;
    border: 1px solid var(--border);
}

.card h2 {
    margin-top: 0;
    font-size: 20px;
    color: var(--navy-dark);
}

.card h3 {
    font-size: 16px;
    color: var(--navy);
    margin-bottom: 6px;
}

label {
    display: block;
    font-size: 14px;
    font-weight: 600;
    margin: 14px 0 6px;
    color: var(--text);
}

input,
select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-family: inherit;
    font-size: 15px;
    background: #fbfcfe;
}

input:focus,
select:focus {
    outline: 2px solid var(--blue);
    border-color: var(--blue);
}

.row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
}

.row > div {
    flex: 1;
    min-width: 140px;
}

.checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
}

.checkbox-row input {
    width: auto;
}

button {
    margin-top: 20px;
    width: 100%;
    padding: 13px;
    border: none;
    border-radius: 12px;
    background: var(--navy);
    color: #fff;
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
}

button:hover {
    background: var(--blue);
}

button:disabled {
    background: #B9C4D3;
    cursor: not-allowed;
}

button.loading {
    background: var(--navy);
    animation: pulseBtn 1.1s ease-in-out infinite;
    cursor: wait;
}

@keyframes pulseBtn {
    0%, 100% {
        opacity: 1;
    }

    50% {
        opacity: .55;
    }
}

.loading-note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin-top: 22px;
    padding: 14px;
    font-size: 13px;
    color: var(--text-gray);
    text-align: center;
}

.loading-note .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--teal);
    animation: pulseDot 1s ease-in-out infinite;
    flex-shrink: 0;
}

@keyframes pulseDot {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
    }

    50% {
        opacity: .3;
        transform: scale(1.4);
    }
}

#result {
    margin-top: 22px;
    text-align: center;
}

#result img {
    max-width: 100%;
    border-radius: 14px;
    box-shadow: 0 6px 20px rgba(15,30,60,.12);
}

#result pre {
    text-align: left;
    background: #0C1F33;
    color: #CFE7FF;
    padding: 16px;
    border-radius: 12px;
    overflow-x: auto;
    font-size: 13px;
}

#result .error {
    color: #C0392B;
    font-weight: 600;
}

table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    margin-top: 10px;
}

th,
td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
}

th {
    color: var(--text-gray);
    font-weight: 600;
    font-size: 13px;
}

code {
    background: #EEF2F8;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--navy-dark);
}

pre.example {
    background: #0C1F33;
    color: #CFE7FF;
    padding: 14px 16px;
    border-radius: 12px;
    overflow-x: auto;
    font-size: 13px;
    margin: 10px 0;
}

.badge {
    display: inline-block;
    background: var(--teal);
    color: #fff;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    margin-left: 6px;
    vertical-align: middle;
}

footer {
    text-align: center;
    color: var(--text-gray);
    font-size: 13px;
    padding: 20px;
}
</style>
</head>

<body>

<header>
    <h1>Thai PromptPay QR API</h1>

    <p>
        สร้าง QR Code รับเงินผ่าน PromptPay
        (เบอร์โทร / เลขบัตรประชาชน / TrueMoney Wallet)
    </p>
</header>

<div class="wrap">

<div class="card">

<h2>🔧 ลองใช้งานจริง</h2>

<div class="row">

<div>
<label>หมายเลขพร้อมเพย์</label>

<input
    id="f-id"
    type="text"
    placeholder="0891234567"
    value="0891234567"
>
</div>

<div>
<label>จำนวนเงิน (ไม่ใส่ก็ได้)</label>

<input
    id="f-amount"
    type="text"
    placeholder="259.50"
>
</div>

</div>

<div class="row">

<div>

<label>รูปแบบผลลัพธ์ (format)</label>

<select id="f-format">

<option value="card">
card — การ์ดเต็มพร้อมแบรนด์
</option>

<option value="qr">
qr — QR เปล่า ไม่มีการ์ด
</option>

<option value="payload">
payload — payload string (JSON)
</option>

</select>

</div>

<div>

<label>
ภาษา (lang) — ใช้กับ format=card
</label>

<select id="f-lang">

<option value="th">
th — ไทย
</option>

<option value="en">
en — English
</option>

</select>

</div>

</div>

<div class="checkbox-row">

<input
    id="f-footer"
    type="checkbox"
    checked
>

<label style="margin:0;">
แสดง footer เวลาที่สร้าง
(ใช้กับ format=card)
</label>

</div>

<button id="f-submit">
สร้าง QR Code
</button>

<div id="result"></div>

</div>

<div class="card">

<h2>📄 เอกสาร API</h2>

<h3>GET /qr/:id/:amount?</h3>

<p>
สร้าง QR Code พร้อมเพย์
ใส่ <code>:amount</code> หรือไม่ก็ได้
</p>

<table>

<tr>
<th>Path param</th>
<th>คำอธิบาย</th>
</tr>

<tr>
<td><code>id</code></td>
<td>
เบอร์โทร (10 หลัก),
เลขบัตรประชาชน (13 หลัก)
หรือ TrueMoney Wallet ID (15 หลัก)
</td>
</tr>

<tr>
<td><code>amount</code></td>
<td>
จำนวนเงิน (ไม่บังคับ, 0–1,000,000)
</td>
</tr>

</table>

<table>

<tr>
<th>Query param</th>
<th>ค่าที่รองรับ</th>
<th>ค่าเริ่มต้น</th>
</tr>

<tr>
<td><code>format</code></td>
<td>
<code>card</code> /
<code>qr</code> /
<code>payload</code>
</td>
<td><code>card</code></td>
</tr>

<tr>
<td><code>lang</code></td>
<td>
<code>th</code> / <code>en</code>
</td>
<td><code>th</code></td>
</tr>

<tr>
<td><code>footer</code></td>
<td>
<code>true</code> / <code>false</code>
</td>
<td><code>true</code></td>
</tr>

</table>

<h3>ตัวอย่าง</h3>

<pre class="example">GET /qr/0891234567/259.50
GET /qr/0891234567?format=qr
GET /qr/0891234567/100?lang=en&amp;footer=false
GET /qr/123456789012345?format=payload</pre>

<h3>
GET /health
<span class="badge">status check</span>
</h3>

<p>
คืน <code>{"status":"ok"}</code>
สำหรับเช็คว่า service ยังทำงานอยู่
</p>

</div>

</div>

<footer>
Thai PromptPay QR API
</footer>

<script>

const $ = (id) =>
    document.getElementById(id);

$('f-submit').addEventListener(
    'click',
    async () => {

        const id =
            $('f-id').value.trim();

        const amount =
            $('f-amount').value.trim();

        const format =
            $('f-format').value;

        const lang =
            $('f-lang').value;

        const footer =
            $('f-footer').checked;

        const resultEl =
            $('result');

        const btn =
            $('f-submit');

        if (!id) {
            resultEl.innerHTML =
                '<p class="error">กรุณากรอกหมายเลขพร้อมเพย์</p>';

            return;
        }

        let url =
            '/qr/' +
            encodeURIComponent(id);

        if (amount) {
            url += '/' +
                encodeURIComponent(amount);
        }

        const params =
            new URLSearchParams({
                format,
                lang,
                footer:
                    footer
                        ? 'true'
                        : 'false'
            });

        url += '?' +
            params.toString();

        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = 'กำลังสร้าง...';

        resultEl.innerHTML =
            '<div class="loading-note">' +
            '<span class="dot"></span>' +
            '<span>กำลังติดต่อเซิร์ฟเวอร์...</span>' +
            '</div>';

        const slowNoticeTimer =
            setTimeout(() => {

                resultEl.innerHTML =
                    '<div class="loading-note">' +
                    '<span class="dot"></span>' +
                    '<span>' +
                    'เซิร์ฟเวอร์กำลังปลุกตัวเอง ' +
                    '(ไม่มีคนใช้งานนานเกิน ~15 นาที) ' +
                    'รออีกสักครู่...' +
                    '</span>' +
                    '</div>';

            }, 3000);

        try {

            if (format === 'payload') {

                const res =
                    await fetch(url);

                const data =
                    await res.json();

                if (!res.ok) {

                    resultEl.innerHTML =
                        '<p class="error">' +
                        (
                            data.message ||
                            'เกิดข้อผิดพลาด'
                        ) +
                        '</p>';

                } else {

                    resultEl.innerHTML =
                        '<pre>' +
                        JSON.stringify(
                            data,
                            null,
                            2
                        ) +
                        '</pre>';
                }

            } else {

                const res =
                    await fetch(url);

                if (!res.ok) {

                    const data =
                        await res
                            .json()
                            .catch(() => ({}));

                    resultEl.innerHTML =
                        '<p class="error">' +
                        (
                            data.message ||
                            'เกิดข้อผิดพลาด'
                        ) +
                        '</p>';

                } else {

                    const blob =
                        await res.blob();

                    const imgUrl =
                        URL.createObjectURL(blob);

                    resultEl.innerHTML =
                        '<img src="' +
                        imgUrl +
                        '" alt="QR Code">';
                }
            }

        } catch (err) {

            resultEl.innerHTML =
                '<p class="error">' +
                'เรียก API ไม่สำเร็จ: ' +
                err.message +
                '</p>';

        } finally {

            clearTimeout(
                slowNoticeTimer
            );

            btn.disabled = false;

            btn.classList.remove(
                'loading'
            );

            btn.textContent =
                'สร้าง QR Code';
        }
    }
);

</script>

</body>
</html>`;

// =========================================================================
// POST /api/orders
// สร้าง Order + Payment พร้อมกัน
// =========================================================================

app.post('/api/orders', (req, res) => {
    try {
        const body = req.body || {};

        const targetId = validateTargetId(
            body.targetId
        );

        const reference =
            normalizeReference(body.reference);

        const customer =
            validateCustomer(body.customer);

        const result =
            validateOrderItems(body.items);

        const now = new Date();

        const expiresAt =
            new Date(
                now.getTime() +
                PAYMENT_EXPIRY_MINUTES * 60 * 1000
            );

        const orderId = createOrderId();
        const paymentId = createPaymentId();

        const payload = generatePayload(
            targetId,
            {
                amount: result.total
            }
        );

        const payment = {
            id: paymentId,
            orderId,
            reference,
            status: 'pending',
            amount: result.total,
            currency: 'THB',
            targetId,
            payload,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            cancelledAt: null,
            paidAt: null,
            qrEndpoint:
                `/qr/${encodeURIComponent(targetId)}/${encodeURIComponent(result.total)}?format=qr`
        };

        const order = {
            id: orderId,
            reference,
            status: 'pending',
            amount: result.total,
            currency: 'THB',
            customer,
            items: result.items,
            paymentId,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            cancelledAt: null,
            paidAt: null
        };

        const orders = readOrders();
        const payments = readPayments();

        payments.push(payment);
        orders.push(order);

        savePayments(payments);
        saveOrders(orders);

        return res.status(201).json(
            getOrderPublic(order, payment)
        );

    } catch (err) {
        if (err instanceof ValidationError) {
            return res.status(err.status).json({
                error: 'Invalid Parameters',
                message: err.message
            });
        }

        const errorId = logError(
            err,
            {
                route: 'POST /api/orders'
            }
        );

        return res.status(500).json({
            error: 'Internal Server Error',
            errorId
        });
    }
});


// =========================================================================
// GET /api/orders/:id
// =========================================================================

app.get('/api/orders/:id', (req, res) => {
    try {
        const orderId =
            String(req.params.id || '').trim();

        if (!orderId) {
            return res.status(400).json({
                error: 'Invalid Parameters',
                message: 'ไม่พบ order id'
            });
        }

        const orders = readOrders();
        const payments = readPayments();

        const order =
            orders.find(
                item => item.id === orderId
            );

        if (!order) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'ไม่พบ Order'
            });
        }

        let changed = false;

        if (
            expireOrderIfNeeded(
                order,
                payments
            )
        ) {
            changed = true;
        }

        const payment =
            payments.find(
                item => item.id === order.paymentId
            );

        if (payment) {
            if (
                expirePaymentIfNeeded(payment)
            ) {
                changed = true;
            }
        }

        if (changed) {
            saveOrders(orders);
            savePayments(payments);
        }

        return res.json(
            getOrderPublic(
                order,
                payment
            )
        );

    } catch (err) {
        const errorId = logError(
            err,
            {
                route: 'GET /api/orders/:id'
            }
        );

        return res.status(500).json({
            error: 'Internal Server Error',
            errorId
        });
    }
});


// =========================================================================
// GET /api/orders
// =========================================================================

app.get('/api/orders', (req, res) => {
    try {
        const limitRaw =
            Number(req.query.limit);

        const offsetRaw =
            Number(req.query.offset);

        const limit =
            Number.isFinite(limitRaw)
                ? Math.min(
                    Math.max(
                        Math.floor(limitRaw),
                        1
                    ),
                    100
                )
                : 20;

        const offset =
            Number.isFinite(offsetRaw)
                ? Math.max(
                    Math.floor(offsetRaw),
                    0
                )
                : 0;

        const requestedStatus =
            req.query.status
                ? String(req.query.status)
                : null;

        if (
            requestedStatus &&
            !ORDER_STATUSES.includes(
                requestedStatus
            )
        ) {
            return res.status(400).json({
                error: 'Invalid Parameters',
                message:
                    `status ต้องเป็น ${ORDER_STATUSES.join(', ')}`
            });
        }

        const orders = readOrders();
        const payments = readPayments();

        let changed = false;

        for (const order of orders) {
            if (
                expireOrderIfNeeded(
                    order,
                    payments
                )
            ) {
                changed = true;
            }

            const payment =
                payments.find(
                    item =>
                        item.id ===
                        order.paymentId
                );

            if (
                payment &&
                expirePaymentIfNeeded(payment)
            ) {
                changed = true;
            }
        }

        if (changed) {
            saveOrders(orders);
            savePayments(payments);
        }

        let filtered =
            requestedStatus
                ? orders.filter(
                    item =>
                        item.status ===
                        requestedStatus
                )
                : orders;

        filtered =
            filtered
                .slice()
                .sort(
                    (a, b) =>
                        new Date(b.createdAt) -
                        new Date(a.createdAt)
                );

        const total =
            filtered.length;

        const items =
            filtered
                .slice(
                    offset,
                    offset + limit
                )
                .map(order => {
                    const payment =
                        payments.find(
                            item =>
                                item.id ===
                                order.paymentId
                        );

                    return getOrderPublic(
                        order,
                        payment
                    );
                });

        return res.json({
            items,
            pagination: {
                limit,
                offset,
                total
            }
        });

    } catch (err) {
        const errorId = logError(
            err,
            {
                route: 'GET /api/orders'
            }
        );

        return res.status(500).json({
            error: 'Internal Server Error',
            errorId
        });
    }
});


// =========================================================================
// POST /api/orders/:id/cancel
// =========================================================================

app.post('/api/orders/:id/cancel', (req, res) => {
    try {
        const orderId =
            String(req.params.id || '').trim();

        const orders = readOrders();
        const payments = readPayments();

        const order =
            orders.find(
                item => item.id === orderId
            );

        if (!order) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'ไม่พบ Order'
            });
        }

        const payment =
            payments.find(
                item =>
                    item.id ===
                    order.paymentId
            );

        if (payment) {
            expirePaymentIfNeeded(payment);
        }

        expireOrderIfNeeded(
            order,
            payments
        );

        if (order.status === 'paid') {
            return res.status(409).json({
                error: 'Conflict',
                message:
                    'ไม่สามารถยกเลิก Order ที่ชำระเงินแล้ว'
            });
        }

        if (order.status === 'expired') {
            return res.status(409).json({
                error: 'Conflict',
                message:
                    'ไม่สามารถยกเลิก Order ที่หมดอายุแล้ว'
            });
        }

        if (order.status === 'cancelled') {
            return res.json(
                getOrderPublic(
                    order,
                    payment
                )
            );
        }

        const cancelledAt =
            new Date().toISOString();

        order.status = 'cancelled';
        order.cancelledAt = cancelledAt;

        if (payment) {
            payment.status = 'cancelled';
            payment.cancelledAt =
                cancelledAt;
        }

        saveOrders(orders);
        savePayments(payments);

        return res.json(
            getOrderPublic(
                order,
                payment
            )
        );

    } catch (err) {
        const errorId = logError(
            err,
            {
                route:
                    'POST /api/orders/:id/cancel'
            }
        );

        return res.status(500).json({
            error: 'Internal Server Error',
            errorId
        });
    }
});

app.get('/', (req, res) => {
    res.setHeader(
        'Content-Type',
        'text/html; charset=utf-8'
    );

    res.send(DOCS_HTML);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok'
    });
});

app.get(
    '/qr/:id/:amount?',
    qrLimiter,
    async (req, res) => {

        try {

            const targetId =
                validateTargetId(
                    req.params.id
                );

            const parsedAmount =
                validateAmount(
                    req.params.amount
                );

            const format =
                [
                    'card',
                    'qr',
                    'payload'
                ].includes(
                    req.query.format
                )
                    ? req.query.format
                    : 'card';

            const lang =
                TEXTS[req.query.lang]
                    ? req.query.lang
                    : 'th';

            const showFooter =
                req.query.footer !== 'false';

            const payload =
                generatePayload(
                    targetId,
                    {
                        amount:
                            parsedAmount ||
                            undefined
                    }
                );

            if (format === 'payload') {

                return res.json({
                    targetId:
                        maskId(targetId),

                    amount:
                        parsedAmount,

                    payload
                });
            }

            const imageBuffer =
                format === 'qr'
                    ? await createBareQR(
                        payload
                    )
                    : await createThaiQRCard(
                        payload,
                        targetId,
                        parsedAmount,
                        {
                            lang,
                            showFooter
                        }
                    );

            res.setHeader(
                'Content-Type',
                'image/png'
            );

            res.setHeader(
                'Cache-Control',
                'public, max-age=86400'
            );

            res.send(
                imageBuffer
            );

        } catch (err) {

            if (
                err instanceof ValidationError
            ) {

                return res.status(
                    err.status
                ).json({
                    error:
                        'Invalid Parameters',

                    message:
                        err.message
                });
            }

            const errorId =
                logError(
                    err,
                    {
                        route: '/qr'
                    }
                );

            res.status(500).json({
                error:
                    'Internal Server Error',

                message:
                    'เกิดข้อผิดพลาดระหว่างสร้าง QR Code กรุณาลองใหม่อีกครั้ง',

                errorId
            });
        }
    }
);

// =========================================================================
// Payment API
// =========================================================================

app.post(
    '/api/payments',
    async (req, res) => {

        try {

            const body =
                req.body &&
                typeof req.body === 'object'
                    ? req.body
                    : {};

            const targetId =
                validateTargetId(
                    body.targetId ??
                    body.promptpayId ??
                    body.id
                );

            const amount =
                validateAmount(
                    body.amount
                );

            if (amount <= 0) {

                throw new ValidationError(
                    'จำนวนเงินสำหรับการสร้าง payment ต้องมากกว่า 0 บาท'
                );
            }

            const reference =
                normalizeReference(
                    body.reference
                );

            const now =
                new Date();

            const expiresAt =
                new Date(
                    now.getTime() +
                    PAYMENT_EXPIRY_MS
                );

            const payload =
                generatePayload(
                    targetId,
                    {
                        amount
                    }
                );

            const payment = {
                id:
                    createPaymentId(),

                reference,

                status:
                    'pending',

                amount,

                currency:
                    'THB',

                targetId,

                payload,

                createdAt:
                    now.toISOString(),

                expiresAt:
                    expiresAt.toISOString(),

                cancelledAt:
                    null,

                paidAt:
                    null
            };

            const payments =
                readPayments();

            payments.push(
                payment
            );

            writePayments(
                payments
            );

            res.status(201).json({
                ...getPaymentPublic(
                    payment
                ),

                payload,

                qrEndpoint:
                    `/qr/${encodeURIComponent(
                        targetId
                    )}/${encodeURIComponent(
                        amount
                    )}?format=qr`
            });

        } catch (err) {

            if (
                err instanceof ValidationError
            ) {

                return res.status(
                    err.status
                ).json({
                    error:
                        'Invalid Parameters',

                    message:
                        err.message
                });
            }

            const errorId =
                logError(
                    err,
                    {
                        route:
                            'POST /api/payments'
                    }
                );

            res.status(500).json({
                error:
                    'Internal Server Error',

                message:
                    'ไม่สามารถสร้าง payment ได้ กรุณาลองใหม่อีกครั้ง',

                errorId
            });
        }
    }
);

app.get(
    '/api/payments/:id',
    (req, res) => {

        try {

            const payments =
                readPayments();

            const payment =
                findPayment(
                    payments,
                    req.params.id
                );

            if (!payment) {

                return res.status(
                    404
                ).json({
                    error:
                        'Not Found',

                    message:
                        'ไม่พบ payment ที่ระบุ'
                });
            }

            if (
                expirePaymentIfNeeded(
                    payment
                )
            ) {

                writePayments(
                    payments
                );
            }

            res.json({
                ...getPaymentPublic(
                    payment
                ),

                payload:
                    payment.payload,

                qrEndpoint:
                    `/qr/${encodeURIComponent(
                        payment.targetId
                    )}/${encodeURIComponent(
                        payment.amount
                    )}?format=qr`
            });

        } catch (err) {

            const errorId =
                logError(
                    err,
                    {
                        route:
                            'GET /api/payments/:id'
                    }
                );

            res.status(500).json({
                error:
                    'Internal Server Error',

                message:
                    'ไม่สามารถอ่าน payment ได้ กรุณาลองใหม่อีกครั้ง',

                errorId
            });
        }
    }
);

app.get(
    '/api/payments',
    (req, res) => {

        try {

            const payments =
                readPayments();

            let changed = false;

            for (
                const payment
                of payments
            ) {

                if (
                    expirePaymentIfNeeded(
                        payment
                    )
                ) {
                    changed = true;
                }
            }

            if (changed) {
                writePayments(
                    payments
                );
            }

            const limitRaw =
                Number.parseInt(
                    req.query.limit,
                    10
                );

            const limit =
                Number.isFinite(limitRaw)
                    ? Math.min(
                        Math.max(
                            limitRaw,
                            1
                        ),
                        100
                    )
                    : 20;

            const offsetRaw =
                Number.parseInt(
                    req.query.offset,
                    10
                );

            const offset =
                Number.isFinite(offsetRaw)
                    ? Math.max(
                        offsetRaw,
                        0
                    )
                    : 0;

            const status =
                req.query.status
                    ? String(
                        req.query.status
                    )
                    : null;

            const allowedStatuses = [
                'pending',
                'paid',
                'expired',
                'cancelled'
            ];

            if (
                status &&
                !allowedStatuses.includes(
                    status
                )
            ) {

                return res.status(
                    400
                ).json({
                    error:
                        'Invalid Parameters',

                    message:
                        'status ต้องเป็น pending, paid, expired หรือ cancelled'
                });
            }

            const filtered =
                status
                    ? payments.filter(
                        payment =>
                            payment.status ===
                            status
                    )
                    : payments;

            const items =
                filtered
                    .slice()
                    .sort(
                        (a, b) =>
                            new Date(
                                b.createdAt
                            ) -
                            new Date(
                                a.createdAt
                            )
                    )
                    .slice(
                        offset,
                        offset + limit
                    )
                    .map(
                        getPaymentPublic
                    );

            res.json({
                items,

                pagination: {
                    limit,
                    offset,
                    total:
                        filtered.length
                }
            });

        } catch (err) {

            const errorId =
                logError(
                    err,
                    {
                        route:
                            'GET /api/payments'
                    }
                );

            res.status(500).json({
                error:
                    'Internal Server Error',

                message:
                    'ไม่สามารถอ่านรายการ payment ได้ กรุณาลองใหม่อีกครั้ง',

                errorId
            });
        }
    }
);

app.post(
    '/api/payments/:id/cancel',
    (req, res) => {

        try {

            const payments =
                readPayments();

            const payment =
                findPayment(
                    payments,
                    req.params.id
                );

            if (!payment) {

                return res.status(
                    404
                ).json({
                    error:
                        'Not Found',

                    message:
                        'ไม่พบ payment ที่ระบุ'
                });
            }

            if (
                expirePaymentIfNeeded(
                    payment
                )
            ) {

                writePayments(
                    payments
                );
            }

            if (
                payment.status === 'paid'
            ) {

                return res.status(
                    409
                ).json({
                    error:
                        'Conflict',

                    message:
                        'payment ที่ชำระแล้วไม่สามารถยกเลิกด้วย endpoint นี้ได้'
                });
            }

            if (
                payment.status === 'expired'
            ) {

                return res.status(
                    409
                ).json({
                    error:
                        'Conflict',

                    message:
                        'payment หมดอายุแล้ว ไม่สามารถยกเลิกได้'
                });
            }

            if (
                payment.status === 'cancelled'
            ) {

                return res.json(
                    getPaymentPublic(
                        payment
                    )
                );
            }

            payment.status =
                'cancelled';

            payment.cancelledAt =
                new Date().toISOString();

            writePayments(
                payments
            );

            res.json(
                getPaymentPublic(
                    payment
                )
            );

        } catch (err) {

            const errorId =
                logError(
                    err,
                    {
                        route:
                            'POST /api/payments/:id/cancel'
                    }
                );

            res.status(500).json({
                error:
                    'Internal Server Error',

                message:
                    'ไม่สามารถยกเลิก payment ได้ กรุณาลองใหม่อีกครั้ง',

                errorId
            });
        }
    }
);

// =========================================================================
// Payment State Machine + Webhook Core
// =========================================================================

const WEBHOOK_EVENTS_FILE = path.join(DATA_DIR, 'webhook-events.json');
const WEBHOOK_TOLERANCE_SECONDS = 300;
const WEBHOOK_EVENT_RETENTION = 5000;
const WEBHOOK_SUCCESS_EVENT = 'payment.succeeded';
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

// expired -> paid is the only non-terminal-looking edge: the sweeper can expire a
// payment before a legitimate webhook lands. processPaymentWebhook guards it by
// comparing the provider's signed paidAt against expiresAt.
const PAYMENT_TRANSITIONS = {
    pending: ['paid', 'expired', 'cancelled'],
    expired: ['paid'],
    paid: [],
    cancelled: []
};

class InvalidTransitionError extends Error {
    constructor(from, to) {
        super(`ไม่สามารถเปลี่ยนสถานะจาก ${from} เป็น ${to}`);
        this.name = 'InvalidTransitionError';
        this.from = from;
        this.to = to;
        this.status = 409;
    }
}

function canTransition(from, to) {
    return (PAYMENT_TRANSITIONS[from] || []).includes(to);
}

function transitionPayment(payment, order, to, meta = {}) {
    const from = payment.status;

    if (!canTransition(from, to)) {
        throw new InvalidTransitionError(from, to);
    }

    const at = meta.at || new Date().toISOString();

    payment.status = to;

    if (to === 'paid') {
        payment.paidAt = at;
    }

    if (to === 'cancelled') {
        payment.cancelledAt = at;
    }

    if (to === 'expired') {
        payment.expiredAt = at;
    }

    if (!Array.isArray(payment.history)) {
        payment.history = [];
    }

    payment.history.push({
        from,
        to,
        at,
        reason: meta.reason || null,
        eventId: meta.eventId || null
    });

    if (order) {
        order.status = to;

        if (to === 'paid') {
            order.paidAt = at;
        }

        if (to === 'cancelled') {
            order.cancelledAt = at;
        }

        if (to === 'expired') {
            order.expiredAt = at;
        }
    }

    return payment;
}

function flagForReview(payment, type, meta = {}) {
    if (!Array.isArray(payment.reviewFlags)) {
        payment.reviewFlags = [];
    }

    payment.reviewFlags.push({
        type,
        at: new Date().toISOString(),
        eventId: meta.eventId || null,
        detail: meta.detail || null
    });
}

function toSatang(value) {
    return Math.round(Number(value) * 100);
}

// -------------------------------------------------------------------------
// Signature verification: header "t=<unix seconds>,v1=<hex hmac-sha256>"
// signed string is `${t}.${rawBody}`
// -------------------------------------------------------------------------

function parseSignatureHeader(header) {
    const parsed = {};

    for (const part of String(header || '').split(',')) {
        const index = part.indexOf('=');

        if (index > 0) {
            parsed[part.slice(0, index).trim()] =
                part.slice(index + 1).trim();
        }
    }

    return parsed;
}

function computeWebhookSignature(secret, timestamp, rawBody) {
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest('hex');
}

function verifyWebhookSignature({
    secret,
    header,
    rawBody,
    nowMs = Date.now()
}) {
    const { t, v1 } = parseSignatureHeader(header);

    if (
        !t ||
        !v1 ||
        !/^\d{9,12}$/.test(t) ||
        !/^[0-9a-fA-F]{64}$/.test(v1)
    ) {
        return { ok: false, reason: 'malformed_signature' };
    }

    if (
        Math.abs(nowMs / 1000 - Number(t)) >
        WEBHOOK_TOLERANCE_SECONDS
    ) {
        return { ok: false, reason: 'timestamp_out_of_tolerance' };
    }

    const expected = Buffer.from(
        computeWebhookSignature(secret, t, rawBody),
        'hex'
    );

    const provided = Buffer.from(v1, 'hex');

    if (!crypto.timingSafeEqual(expected, provided)) {
        return { ok: false, reason: 'signature_mismatch' };
    }

    return { ok: true };
}

// -------------------------------------------------------------------------
// Event store (idempotency ledger)
// -------------------------------------------------------------------------

function readWebhookEvents() {
    if (!fs.existsSync(WEBHOOK_EVENTS_FILE)) {
        return [];
    }

    return readJsonFile(WEBHOOK_EVENTS_FILE);
}

function saveWebhookEvents(events) {
    writeJsonFile(
        WEBHOOK_EVENTS_FILE,
        events.slice(-WEBHOOK_EVENT_RETENTION)
    );
}

function validateWebhookEvent(event) {
    if (
        !event ||
        typeof event !== 'object' ||
        Array.isArray(event)
    ) {
        throw new ValidationError('webhook body ต้องเป็น object');
    }

    const eventId = String(event.eventId || '').trim();

    if (!eventId || eventId.length > 100) {
        throw new ValidationError('eventId จำเป็นต้องระบุ (ไม่เกิน 100 ตัวอักษร)');
    }

    const type = String(event.type || '').trim();

    if (!type || type.length > 60) {
        throw new ValidationError('type จำเป็นต้องระบุ');
    }

    if (type !== WEBHOOK_SUCCESS_EVENT) {
        return { eventId, type };
    }

    const paymentId = String(event.paymentId || '').trim();

    if (!paymentId || paymentId.length > 100) {
        throw new ValidationError('paymentId จำเป็นต้องระบุ');
    }

    const amount = Number(event.amount);

    if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 1000000
    ) {
        throw new ValidationError('amount ไม่ถูกต้อง');
    }

    const currency = String(event.currency || 'THB')
        .trim()
        .toUpperCase();

    let paidAtMs = null;

    if (event.paidAt !== undefined && event.paidAt !== null) {
        paidAtMs = new Date(event.paidAt).getTime();

        if (Number.isNaN(paidAtMs)) {
            throw new ValidationError('paidAt ไม่ถูกต้อง (ต้องเป็น ISO 8601)');
        }
    }

    const providerRef =
        event.providerRef === undefined ||
        event.providerRef === null
            ? null
            : String(event.providerRef).trim().slice(0, 100);

    return {
        eventId,
        type,
        paymentId,
        amount,
        currency,
        paidAtMs,
        providerRef
    };
}

// -------------------------------------------------------------------------
// Core processor. Returns { outcome }. Never throws on business conflicts,
// so the provider gets a 200 and stops retrying; only ValidationError escapes.
// -------------------------------------------------------------------------

function processPaymentWebhook(rawEvent, nowMs = Date.now()) {
    const event = validateWebhookEvent(rawEvent);

    const events = readWebhookEvents();
    const seen = events.find(item => item.eventId === event.eventId);

    if (seen) {
        return {
            outcome: 'duplicate',
            previousOutcome: seen.outcome
        };
    }

    const record = outcome => {
        events.push({
            eventId: event.eventId,
            type: event.type,
            paymentId: event.paymentId || null,
            outcome,
            receivedAt: new Date(nowMs).toISOString()
        });

        saveWebhookEvents(events);

        return { outcome };
    };

    if (event.type !== WEBHOOK_SUCCESS_EVENT) {
        return record('ignored_event_type');
    }

    const orders = readOrders();
    const payments = readPayments();

    const payment = payments.find(
        item => item.id === event.paymentId
    );

    if (!payment) {
        return record('unknown_payment');
    }

    const order = payment.orderId
        ? orders.find(item => item.id === payment.orderId)
        : null;

    const flagMeta = detail => ({
        eventId: event.eventId,
        detail
    });

    const persist = () => {
        savePayments(payments);

        if (order) {
            saveOrders(orders);
        }
    };

    if (
        toSatang(event.amount) !== toSatang(payment.amount) ||
        event.currency !== payment.currency
    ) {
        flagForReview(
            payment,
            'amount_mismatch',
            flagMeta(
                `expected ${payment.amount} ${payment.currency}, got ${event.amount} ${event.currency}`
            )
        );

        persist();

        return record('amount_mismatch');
    }

    const paidAtMs = event.paidAtMs ?? nowMs;
    const expiresAtMs = new Date(payment.expiresAt).getTime();
    const paidInWindow = paidAtMs <= expiresAtMs;

    if (payment.status === 'paid') {
        if (
            event.providerRef &&
            payment.providerRef &&
            event.providerRef !== payment.providerRef
        ) {
            flagForReview(
                payment,
                'duplicate_payment',
                flagMeta(`second transfer ${event.providerRef}`)
            );

            persist();

            return record('duplicate_payment');
        }

        return record('already_paid');
    }

    if (payment.status === 'cancelled') {
        flagForReview(
            payment,
            'paid_after_cancel',
            flagMeta(event.providerRef)
        );

        persist();

        return record('review_required');
    }

    if (payment.status === 'pending' && !paidInWindow) {
        transitionPayment(payment, order, 'expired', {
            reason: 'timeout',
            eventId: event.eventId,
            at: new Date(nowMs).toISOString()
        });
    }

    if (payment.status === 'expired' && !paidInWindow) {
        flagForReview(
            payment,
            'paid_after_expiry',
            flagMeta(event.providerRef)
        );

        persist();

        return record('late_payment_review');
    }

    const recovered = payment.status === 'expired';

    payment.providerRef = event.providerRef;
    payment.providerEventId = event.eventId;

    transitionPayment(payment, order, 'paid', {
        reason: recovered
            ? 'recovered_after_expiry'
            : 'provider_confirmed',
        eventId: event.eventId,
        at: new Date(paidAtMs).toISOString()
    });

    persist();

    return record(recovered ? 'paid_recovered' : 'paid');
}

// -------------------------------------------------------------------------
// Expiry sweeper
// -------------------------------------------------------------------------

function sweepExpiredPayments(nowMs = Date.now()) {
    const orders = readOrders();
    const payments = readPayments();

    let swept = 0;

    for (const payment of payments) {
        if (
            payment.status !== 'pending' ||
            !payment.expiresAt ||
            nowMs < new Date(payment.expiresAt).getTime()
        ) {
            continue;
        }

        const order = payment.orderId
            ? orders.find(item => item.id === payment.orderId)
            : null;

        transitionPayment(payment, order, 'expired', {
            reason: 'sweeper',
            at: new Date(nowMs).toISOString()
        });

        swept += 1;
    }

    if (swept > 0) {
        savePayments(payments);
        saveOrders(orders);
    }

    return swept;
}

// -------------------------------------------------------------------------
// POST /api/webhooks/payment
// -------------------------------------------------------------------------

app.post('/api/webhooks/payment', (req, res) => {
    try {
        const secret = process.env.PAYMENT_WEBHOOK_SECRET;

        if (!secret) {
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'ยังไม่ได้ตั้งค่า PAYMENT_WEBHOOK_SECRET'
            });
        }

        if (!Buffer.isBuffer(req.rawBody)) {
            return res.status(400).json({
                error: 'Invalid Parameters',
                message: 'ต้องส่ง body เป็น application/json'
            });
        }

        const verification = verifyWebhookSignature({
            secret,
            header: req.get('X-Signature'),
            rawBody: req.rawBody
        });

        if (!verification.ok) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'ลายเซ็น webhook ไม่ถูกต้อง',
                reason: verification.reason
            });
        }

        const result = processPaymentWebhook(req.body);

        return res.json({
            received: true,
            outcome: result.outcome
        });

    } catch (err) {
        if (err instanceof ValidationError) {
            return res.status(err.status).json({
                error: 'Invalid Parameters',
                message: err.message
            });
        }

        const errorId = logError(err, {
            route: 'POST /api/webhooks/payment'
        });

        return res.status(500).json({
            error: 'Internal Server Error',
            errorId
        });
    }
});

app.use(
    (req, res) => {
        res.status(404).json({
            error:
                'Not Found',

            message:
                'ไม่พบ endpoint ที่ร้องขอ'
        });
    }
);

ensurePaymentStorage();

const PORT =
    process.env.PORT || 3000;

if (require.main === module) {

    setInterval(
        () => {
            try {
                sweepExpiredPayments();
            } catch (err) {
                logError(err, { route: 'expiry-sweeper' });
            }
        },
        EXPIRY_SWEEP_INTERVAL_MS
    ).unref();

    app.listen(
        PORT,
        () => {
            console.log(
                `Server running on port ${PORT}`
            );
        }
    );
}

module.exports = app;

module.exports.validateTargetId =
    validateTargetId;

module.exports.validateAmount =
    validateAmount;

module.exports.maskId =
    maskId;

module.exports.ValidationError =
    ValidationError;
module.exports.transitionPayment =
    transitionPayment;

module.exports.canTransition =
    canTransition;

module.exports.InvalidTransitionError =
    InvalidTransitionError;

module.exports.computeWebhookSignature =
    computeWebhookSignature;

module.exports.verifyWebhookSignature =
    verifyWebhookSignature;

module.exports.processPaymentWebhook =
    processPaymentWebhook;

module.exports.sweepExpiredPayments =
    sweepExpiredPayments;