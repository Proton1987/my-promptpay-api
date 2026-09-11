const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const app = express();
app.set('trust proxy', 1);

// =========================================================================
// Security headers — helmet ตั้งค่า header มาตรฐาน (กัน clickjacking,
// บังคับ browser ไม่เดา content-type, ปิด referrer leak, ปิด X-Powered-By
// ที่บอกใบ้ว่า backend เป็น Express ฯลฯ) CSP กำหนดกว้างพอให้หน้า docs/demo
// ที่มี inline <script>/<style> + Google Fonts ยังทำงานได้ปกติ
// =========================================================================
app.use(helmet({
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

// CORS — เปิดกว้างทุก origin ได้ เพราะเป็น public GET API ล้วน ไม่มี
// cookie/session ให้ต้องป้องกันข้ามโดเมน
app.use(cors());

// Rate limit เบา ๆ ครอบทุก route (กันบอทถล่มหน้า docs/demo) — endpoint
// /qr ที่หนักกว่าจะมี limiter เข้มกว่านี้ซ้อนอีกชั้นด้านล่าง
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too Many Requests', message: 'เรียก API บ่อยเกินไป กรุณาลองใหม่อีกครั้งในอีกสักครู่' }
});
app.use(globalLimiter);

// =========================================================================
// ลงทะเบียนฟอนต์ไทย (Sarabun) — แคนวาสไม่มีฟอนต์ระบบที่รองรับภาษาไทย
// ถ้าไม่ register ตัวอักษรไทยจะเพี้ยนเป็นสี่เหลี่ยม (missing glyph)
// =========================================================================
// fontsource แยกไฟล์ตาม subset (thai / latin) คนละไฟล์กัน ข้อความที่มีทั้งไทย+อังกฤษ
// ในสตริงเดียว (เช่น "สแกน PromptPay") ต้อง register เป็นคนละ family แล้วใช้
// รายชื่อ fallback คั่นด้วย comma ใน ctx.font เพื่อให้ engine เลือก glyph จากไฟล์ที่มี
try {
    GlobalFonts.registerFromPath(require.resolve('@fontsource/sarabun/files/sarabun-thai-400-normal.woff2'), 'SarabunThai');
    GlobalFonts.registerFromPath(require.resolve('@fontsource/sarabun/files/sarabun-latin-400-normal.woff2'), 'SarabunLatin');
    GlobalFonts.registerFromPath(require.resolve('@fontsource/sarabun/files/sarabun-thai-700-normal.woff2'), 'SarabunThaiBold');
    GlobalFonts.registerFromPath(require.resolve('@fontsource/sarabun/files/sarabun-latin-700-normal.woff2'), 'SarabunLatinBold');
} catch (err) {
    console.error('ไม่สามารถโหลดฟอนต์ Sarabun ได้ ตัวอักษรไทยบนภาพอาจแสดงผลผิดพลาด:', err.message);
}
const FONT_REGULAR = '"SarabunThai", "SarabunLatin"';
const FONT_BOLD = '"SarabunThaiBold", "SarabunLatinBold"';

// =========================================================================
// Error logging — ใช้ console.error เฉย ๆ (Render มีหน้า Logs ให้ดูอยู่แล้ว
// ไม่ต้องผูก external service เพิ่ม) แต่ละ error จะมี errorId สั้น ๆ
// ติดไปกับ response ที่ตอบกลับผู้เรียก API ด้วย เพื่อให้ผู้เรียกเอา ID
// ไปบอกเรา แล้วเราไปค้นใน Render log เจอเฉพาะของเขา — ไม่มี endpoint
// ที่เปิดให้ใครดึง log ของคนอื่นออกมาดูได้ทั้งหมด
// =========================================================================
function logError(err, context = {}) {
    const errorId = Math.random().toString(36).slice(2, 8).toUpperCase();
    console.error(`[${errorId}] [${context.route || 'unknown'}]`, err);
    return errorId;
}

// =========================================================================
// Rate limiting — กันการยิง request รัว ๆ ใส่ endpoint ที่ต้อง render ภาพ
// =========================================================================
const qrLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too Many Requests', message: 'เรียก API บ่อยเกินไป กรุณาลองใหม่อีกครั้งในอีกสักครู่' }
});

// =========================================================================
// Validation — ตรวจ id / amount ก่อนสร้าง payload เพื่อคืน error ที่ชัดเจน
// =========================================================================
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

function validateTargetId(rawId) {
    const id = String(rawId || '').replace(/[^0-9]/g, '').trim();

    if (!id) {
        throw new ValidationError('กรุณาระบุหมายเลขพร้อมเพย์ (เบอร์โทร, เลขบัตรประชาชน หรือ TrueMoney Wallet ID)');
    }
    if (![10, 13, 15].includes(id.length)) {
        throw new ValidationError('รูปแบบหมายเลขไม่ถูกต้อง ต้องเป็นเบอร์โทร (10 หลัก), เลขบัตรประชาชน (13 หลัก) หรือ TrueMoney Wallet ID (15 หลัก)');
    }
    if (id.length === 10 && !/^0[1-9]\d{8}$/.test(id)) {
        throw new ValidationError('รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง');
    }
    return id;
}

function validateAmount(rawAmount) {
    if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
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
        throw new ValidationError('จำนวนเงินต้องไม่เกิน 1,000,000 บาท');
    }
    // ปัดเป็นทศนิยม 2 ตำแหน่งกันปัญหา floating point / ทศนิยมยาวเกินสเปก
    return Math.round(amount * 100) / 100;
}

function maskId(id) {
    if (id.length <= 7) return id;
    return `${id.slice(0, 3)}-xxx-${id.slice(-4)}`;
}

// =========================================================================
// โลโก้ SVG — parse และ rasterize แค่ครั้งเดียวแล้ว cache ไว้ (เดิม parse
// ใหม่ทุก request ซึ่งกิน CPU/latency โดยไม่จำเป็น เพราะขนาดคงที่เสมอ)
// =========================================================================
const TRUEMONEY_SVG = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 120 80" fill="none">
  <g clip-path="url(#A)">
    <g fill="#f38020">
      <path d="M94.726 54.131s.344-2.501 2.557-2.501c2.156 0 2.525 2.501 2.525 2.501h-5.082zm7.583.333c-.301-2.648-1.868-5.395-5.268-5.395 0 0-4.575-.002-4.942 6.202-.007.123 0 .248.005.371.013.321.046.642.094.96a8.57 8.57 0 0 0 .303 1.31 6.74 6.74 0 0 0 .632 1.419 5.16 5.16 0 0 0 1.08 1.289 4.95 4.95 0 0 0 1.647.919c.375.124.771.219 1.165.257.54.053 1.085-.022 1.609-.151.844-.209 1.626-.616 2.278-1.192.271-.239.536-.508.736-.811 0 0 .423-.64.188-1.28-.149-.405-.453-.775-.909-.816-.521-.046-.818.355-1.142.688 0 0-.803 1.002-2.377 1.002-.979 0-1.709-.455-2.181-1.202-.311-.493-.499-1.136-.534-1.716h5.846l.527.007c.174.01.355.011.524-.037.211-.059.44-.231.557-.413.268-.418.215-.936.161-1.412zm-.024-2.849l.121.34c0 .137.125.344.173.474l.183.499.365.999.72 1.946.831 2.184.432 1.11.32.816c.018.045.124.231.108.272-.212.535-.442 1.068-.742 1.561-.374.614-.89 1.154-1.444 1.609l-.656.493c-.281.175-.573.294-.796.549a1.36 1.36 0 0 0-.34.899c0 .274.064.547.213.779.123.192.29.352.491.46.208.112.477.078.695.007.209-.067.401-.178.587-.293.818-.506 1.578-1.116 2.221-1.832l.184-.217.201-.263s1.032-1.345 1.643-2.921l1.359-3.627 1.559-4.134.562-1.471c.198-.518.399-1.084.238-1.615-.217-.717-1.206-1.206-1.786-.587-.217.232-.334.537-.446.834l-2.157 5.768c-.044.117-.322.616-.276.739l-2.607-6.852c-.11-.272-.306-.515-.564-.659-.385-.213-.907-.114-1.215.192-.286.284-.388.713-.361 1.115.019.282.093.556.184.825zm-48.184-1.123a4.13 4.13 0 0 0-.015.485l.005 1.394.001 7.091.018.937c.04.333.153.661.379.915a1.12 1.12 0 0 0 .748.37l.121.005a1.11 1.11 0 0 0 .925-.491c.184-.262.279-.57.321-.884.044-.331.032-.666.029-.999l-.001-4.924c0-.337-.009-.666.067-.997.1-.439.301-.884.64-1.19.316-.284.726-.42 1.147-.438l.109-.002c.422 0 .838.121 1.16.402.28.244.458.576.58.922.172.488.171 1.015.17 1.526l-.002 5.695s.111 1.38 1.249 1.38 1.239-1.269 1.239-1.269v-6.09s.027-2.569 2.146-2.569c1.966-.006 1.789 2.513 1.789 2.513v6.179s.162 1.236 1.245 1.236 1.234-1.212 1.234-1.212v-6.764s-.142-4.642-3.695-4.642c-2.582 0-3.462 2.064-3.487 2.059-.008-.002-.02-.035-.024-.041l-.06-.111-.098-.168-.138-.211-.179-.239-.222-.253-.268-.254a3.43 3.43 0 0 0-.314-.24c-.116-.078-.237-.149-.363-.212a3.12 3.12 0 0 0-1.207-.319l-.323-.011c-.266.002-.525.053-.774.149a2.72 2.72 0 0 0-.414.203 3.21 3.21 0 0 0-.372.26c-.138.111-.267.233-.388.362a4.76 4.76 0 0 0-.393.479l-.047.066s-.148-1.431-1.254-1.431c-.447 0-.813.246-1.037.623a1.92 1.92 0 0 0-.198.45 1.6 1.6 0 0 0-.049.261zm21.398 8.642c-1.551 0-2.808-1.658-2.808-3.703s1.257-3.703 2.808-3.703 2.808 1.658 2.808 3.703-1.257 3.703-2.808 3.703zm0-10.082c-2.904 0-5.258 2.852-5.258 6.37s2.354 6.37 5.258 6.37 5.258-2.852 5.258-6.37-2.354-6.37-5.258-6.37zm8.579 1.567a1.51 1.51 0 0 0-.188-.741c-.182-.325-.522-.699-1.124-.698-.365 0-.678.188-.885.483a1.82 1.82 0 0 0-.204.386 1.6 1.6 0 0 0-.106.609v.023l.002 1.404v7.79c0 .272-.025.539.051.806.162.565.624 1.014 1.231 1.014 1.067 0 1.2-1.194 1.2-1.194v-5.754a3.41 3.41 0 0 1 .124-.917c.222-.796.765-2.098 2.305-2.098.508 0 .999.164 1.375.51.312.287.527.666.672 1.061.275.749.248 1.532.241 2.315l-.004.695v3.236c0 .398-.062.804.074 1.188.186.528.649.957 1.229.957.419 0 .765-.223.969-.582.212-.373.228-.756.229-1.177l-.004-5.069c0-.964-.103-1.906-.425-2.824-.227-.645-.542-1.27-.992-1.788-.495-.571-1.15-.974-1.895-1.119-.236-.046-.477-.067-.718-.067-1.957 0-2.956 1.33-3.12 1.561-.008.011-.038.001-.038-.011z"/>
    </g>
    <g fill="#808083">
      <path d="M63.179 77.916c-.016-.112-.004-.239-.004-.348v-12.28a.85.85 0 0 1 .236-.579c.151-.156.359-.228.573-.236l.041-.001a.83.83 0 0 1 .591.224.94.94 0 0 1 .276.683l-.001.705v11.294c0 .19.022.396-.023.579a.84.84 0 0 1-.836.656c-.384 0-.733-.253-.84-.627a.5.5 0 0 1-.015-.071zm3.756 0c-.016-.112-.004-.239-.004-.348v-12.28a.85.85 0 0 1 .236-.579c.151-.156.36-.228.573-.236l.041-.001a.83.83 0 0 1 .591.224.94.94 0 0 1 .276.683l-.001.705v11.294c0 .19.022.396-.023.579a.84.84 0 0 1-.836.656c-.384 0-.733-.253-.84-.627a.5.5 0 0 1-.015-.071zm-17.554-2.317l-.061-.255-.121-.511-.24-1.021-.549-2.355-.555-2.351-.04-.14c-.059-.198-.142-.391-.301-.531-.235-.208-.623-.239-.934-.196-.224.031-.454.105-.61.27-.161.171-.218.413-.269.642L44.22 75.84l-1.596-6.413c-.107-.431-.252-.912-.644-1.12-.352-.187-.83-.04-1.047.286-.306.461-.163 1.034-.022 1.526l2.161 7.558c.08.281.173.581.404.761.188.147.438.188.678.199.284.013.594-.02.803-.213.187-.173.252-.438.309-.686l1.452-6.375c.004-.019.029-.017.034.001l1.356 5.63.184.783c.048.206.101.422.241.581.187.213.491.281.775.287.224.005.458-.023.65-.139.297-.179.443-.53.521-.868l.801-2.931 1.324-4.622.108-.435a2.75 2.75 0 0 0 .083-.489.89.89 0 0 0-.208-.662.81.81 0 0 0-.665-.274c-.686.046-.843.828-.962 1.362l-1.52 6.258m9.991-.731c-.06.47-.297.902-.64 1.226-.164.155-.351.285-.554.382-.596.284-1.333.348-1.973.187-.612-.153-.924-.646-.898-1.266a1.48 1.48 0 0 1 .721-1.219c.407-.252.876-.367 1.342-.45.607-.108 1.241-.182 1.819-.41l.191-.084.001.845c.001.261.024.528-.009.787zm2.297 1.912c-.155-.07-.354-.049-.467-.176-.104-.117-.108-.315-.107-.472l.031-4.495c.004-.576.007-1.158-.124-1.719s-.413-1.106-.878-1.446c-.368-.268-.822-.389-1.27-.47-.917-.166-1.881-.186-2.764.112-.662.224-1.274.641-1.677 1.217-.265.379-.511.919-.459 1.406a1.02 1.02 0 0 0 .198.514c.276.368.875.481 1.212.168.305-.282.306-.761.507-1.124.28-.506.908-.715 1.486-.746.57-.031 1.178.083 1.602.465s.591 1.08.257 1.543c-.224.309-.608.455-.977.552-.753.198-1.536.265-2.288.464s-1.503.557-1.953 1.192c-.432.61-.532 1.401-.457 2.145.057.561.214 1.129.563 1.572.44.559 1.145.862 1.85.954a4.09 4.09 0 0 0 3.532-1.327 1.45 1.45 0 0 0 .509 1.044c.305.257.72.372 1.115.318s.808-.284.92-.666c.108-.367.002-.865-.361-1.027zm18.415-8.663v-.182l-.004-2.036c0-.099.003-.19.033-.283a.9.9 0 0 1 .083-.185c.096-.161.246-.281.424-.34a1.06 1.06 0 0 1 .333-.049c.21 0 .418.063.568.215.253.255.266.624.259.962l-.002.727v1.178h.894c.114 0 .226-.009.335.033.32.122.52.406.542.745l.002.075c0 .296-.124.573-.376.736a1.1 1.1 0 0 1-.129.069c-.094.044-.183.052-.286.051l-.976-.001v6.14s.023.727.819.727 1.21-.056 1.21.816c0 .243-.066.463-.256.625-.204.174-.48.236-.738.229-.311-.008-.611.011-.92-.039-.281-.046-.55-.153-.797-.292-.421-.237-.764-.6-.919-1.063-.072-.213-.103-.439-.103-.664v-6.449l-.464.004c-.151 0-.304.014-.452-.024a.91.91 0 0 1-.562-.479c-.053-.116-.076-.244-.076-.371 0-.306.137-.585.395-.752.127-.082.255-.111.406-.117l.757-.004zm-8.266 3.973s.244-2.491 2.437-2.491c2.339 0 2.303 2.491 2.303 2.491h-4.74zm6.519.274c-.244-2.198-1.129-4.477-4.279-4.477-2.604 0-4.52 3.218-3.891 6.565.304 1.617 1.023 3.177 2.868 3.828.303.107.69.137 1.01.169a3.99 3.99 0 0 0 2.788-.826c.577-.459 1.423-1.572 1.127-2.392-.121-.336-.361-.504-.732-.538-.423-.038-.686.42-.786.622-.243.491-.429 1.427-2.189 1.427-1.063 0-1.663-.692-2.046-1.311-.253-.409-.367-1.184-.395-1.665h5.091l.428.006a1.3 1.3 0 0 0 .426-.03.87.87 0 0 0 .452-.343c.218-.347.17-.64.126-1.035z"/>
    </g>
    <g fill="#ed1c24">
      <path d="M14.344 46.405l-3.629.014.007 2.991-1.714.014L9 52.681h1.729V57.3c.007.208.057 1.514 1.435 2.797 1.592 1.571 3.493 1.542 3.493 1.542l2.725-.007v-3.099H16.13c-1.521 0-1.786-1.836-1.786-1.836l.007-4.002 2.46-.014c1.32-.007 1.571-1.456 1.571-1.456v-1.808l-4.038.007v-3.02zm9.629 3.02c-.559 0-1.56.032-2.98 1.227s-1.664 2.883-1.657 3.296l.004 7.692 3.522.004.004-7.19c0-1.029 1.549-1.764 1.972-1.764l2.069.004-.018-3.267h-2.916zm14.89 0l-3.69.011.011 7.391c0 .603-.57 1.807-1.958 1.807s-1.84-1.495-1.84-1.818l.011-5.831c0-1.226-1.216-1.571-1.506-1.571l-2.109.021-.011 7.553c0 .624.086 1.829 1.259 3.152s2.593 1.678 4.282 1.657 2.711-.312 4.078-1.399 1.496-3.228 1.485-3.862l-.011-7.111zm4.127 4.831c.193-.735.879-2.195 2.618-2.078 2.066.14 2.281 2.087 2.281 2.087l-4.899-.01zm8.138-.787c-.441-1.409-.905-2.054-1.678-2.84-1.237-1.259-3.088-1.549-3.959-1.549s-2.367.215-3.905 1.485-2.076 3.421-2.119 5.121.85 3.604 2.055 4.723 2.711 1.409 4.067 1.399 2.163-.29 3.314-.979 1.958-2.184 1.958-2.184l-3.357-.861c-.269.398-1.022 1.044-2.162 1.011s-1.808-.882-2.098-1.312c-.088-.13-.154-.408-.203-.743l8.304-.01c.016-1.533.054-2.195-.215-3.26z"/>
    </g>
    <path d="M88.96 4.527H73.293c-1.023 0-1.934.647-2.27 1.613l-9.806 28.133c-.032.082-.186.476-.47.864l-.145.182c-.082.098-.186.214-.339.333l-.026.019c-.053.041-.112.083-.18.125-.167.102-.309.154-.364.174l-.023.008-.029.01a2.08 2.08 0 0 1-.536.104h18.832a1.45 1.45 0 0 0 .361-.044c.458-.118 1.437-.542 1.849-2.055L89.929 5.89c.232-.667-.263-1.363-.969-1.363z" fill="#ff7b00"/>
    <path d="M42.595 30.757l.012-.035 7.158-20.345.002-.003.003-.003c.013-.026.018-.048.033-.073.13-.285.472-.594.611-.637l-2.121-7.13C48.029 1.624 47.158 1 46.251 1H31.286c-.704 0-1.21.678-1.009 1.353l8.425 28.313c.348 1.005 1.103 1.527 1.875 1.565.804.034 1.623-.455 2.019-1.475z" fill="#ff000f"/>
    <g fill="#aa0017">
      <path d="M50.413 9.663l-.005.003z"/>
      <path d="M56.258 32.112l-.158-.533-6.135-20.612c-.094-.316-.063-.633.071-.893.032-.062.071-.121.114-.176l.015-.02a1.06 1.06 0 0 1 .215-.195l.028-.018.007-.004c-.139.044-.481.352-.611.637l-.041.076c-.072.147-.117.293-.166.435l-7.001 19.948c-.395 1.02-1.214 1.509-2.017 1.475l-.045.003h15.762l-.036-.122z"/>
    </g>
    <path d="M68.567 13.189l-.397-1.462c-.106-.402-.231-.79-.448-1.148-.212-.35-.5-.653-.86-.853-.1-.056-.205-.104-.313-.142-.17-.06-.459-.104-.639-.104H51.073c-.259 0-.481.068-.66.182l-.033.02c-.082.056-.153.121-.215.195-.006.007-.01.014-.015.02-.044.055-.082.114-.114.176-.134.259-.165.576-.071.892l6.316 21.219.686 2.39c.044.127.408 1.113 1.408 1.425.491.153.923.077 1.144.021l.122-.034.029-.01.023-.008c.055-.019.197-.072.364-.174a1.93 1.93 0 0 0 .18-.125 2.44 2.44 0 0 0 .248-.224l.117-.128.145-.182c.283-.388.438-.781.47-.864l.457-1.315.198-.596 6.695-19.173" fill="#ffcd00"/>
  </g>
  <defs>
    <clipPath id="A">
      <path fill="#fff" d="M0 0h120v80H0z"/>
    </clipPath>
  </defs>
</svg>`;

const PROMPTPAY_HEADER_SVG = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 644.45 215.15" width="${w}" height="${h}">
  <g id="bf137c09-dfa1-40b5-8dc3-d0a51e5d08fb" data-name="Layer 2">
    <g id="afc82774-a91f-4c0a-8442-16c01336e268" data-name="Layer 1">
      <path fill="#003d6b" d="M413,39.5a4,4,0,0,1-2.73-.92A3.19,3.19,0,0,1,409.23,36a3.32,3.32,0,0,1,1.13-2.69,4.94,4.94,0,0,1,3.28-1,5.59,5.59,0,0,1,4,1.19,4.27,4.27,0,0,1,1.25,3.25v8.59l3.69-10h2.61l3.65,10V32.76h5.84V53.58h-5.88V53l-4.95-13.29-5,13.33v.56H413Zm1.67-2a2.62,2.62,0,0,0,0-3.13,1.75,1.75,0,0,0-1.32-.54,1.83,1.83,0,0,0-1.35.54,2.54,2.54,0,0,0,0,3.13,1.83,1.83,0,0,0,1.35.54A1.75,1.75,0,0,0,414.7,37.53Z"/>
      <path fill="#003d6b" d="M451.07,53A3.36,3.36,0,0,1,450,50.31a3.13,3.13,0,0,1,1.09-2.47,4,4,0,0,1,2.71-1V43.83a5,5,0,0,0-.29-1.92A1.63,1.63,0,0,0,452.4,41a8.3,8.3,0,0,0-2.37-.25c-1,0-2.16,0-3.47.12s-2.41.17-3.25.3V39.39a7.05,7.05,0,0,1,1.84-5.18c1.23-1.24,3.3-1.86,6.19-1.86a8.49,8.49,0,0,1,1.54.13c.48.09.93.18,1.34.28a8.29,8.29,0,0,0,2.23.34,4.81,4.81,0,0,0,1.61-.26,4.92,4.92,0,0,0,1.54-1l1.58,2.45a5.39,5.39,0,0,1-3.62,1.39,9.25,9.25,0,0,1-1.51-.11c-.43-.08-.91-.19-1.44-.34a8.89,8.89,0,0,0-2.66-.42,3.71,3.71,0,0,0-3.72,4c1.43,0,2.47-.08,3.11-.08a21,21,0,0,1,4.73.42,4.42,4.42,0,0,1,2.63,1.61,5.83,5.83,0,0,1,.9,3.51v5.27q0,4.44-5.22,4.44A5,5,0,0,1,451.07,53Zm4.4-1.09a2.25,2.25,0,0,0,.52-1.58,2.11,2.11,0,0,0-.52-1.55,1.78,1.78,0,0,0-1.32-.53,1.86,1.86,0,0,0-1.35.53,2.07,2.07,0,0,0-.54,1.55,2.21,2.21,0,0,0,.54,1.58,1.81,1.81,0,0,0,1.35.56A1.73,1.73,0,0,0,455.47,51.93Z"/>
      <path fill="#003d6b" d="M448.17,26.57a5.47,5.47,0,0,0,1.4-.66,5.76,5.76,0,0,0,1.29-1,3.1,3.1,0,0,1-2.43-1,3.33,3.33,0,0,1-.76-2.15,3.23,3.23,0,0,1,.92-2.3,3.68,3.68,0,0,1,2.8-1,4.37,4.37,0,0,1,3,1,3.13,3.13,0,0,1,1.07,2.41,3.85,3.85,0,0,1-.76,2.54,5.55,5.55,0,0,1-1.85,1.45c2.38-.15,4.07-.71,5.05-1.69a6.55,6.55,0,0,0,1.71-4.29h4.15a7.49,7.49,0,0,1-3.2,6,12.91,12.91,0,0,1-7.52,2h-4.91Zm4.3-3.48a2,2,0,0,0,.46-1.38,2,2,0,0,0-.46-1.37,1.58,1.58,0,0,0-1.23-.51,1.51,1.51,0,0,0-1.19.53,2.23,2.23,0,0,0,0,2.71,1.51,1.51,0,0,0,1.19.53A1.58,1.58,0,0,0,452.47,23.09Z"/>
      <path fill="#003d6b" d="M472.87,44.13a3.84,3.84,0,0,1,1.29-2.9A5.42,5.42,0,0,1,478,40a5.22,5.22,0,0,1,3.35,1,3.62,3.62,0,0,1,.17,5.2,3.9,3.9,0,0,1-2.78,1v4.48h4.38a2.12,2.12,0,0,0,2.38-2.41V38.94a4.63,4.63,0,0,0-1.35-3.37,5.16,5.16,0,0,0-3.88-1.38,7.8,7.8,0,0,0-4,1,5.21,5.21,0,0,0-2.34,2.9h-2.11a7,7,0,0,1,3.24-4.18,12.32,12.32,0,0,1,6.52-1.54,13.42,13.42,0,0,1,7,1.64,5.45,5.45,0,0,1,2.71,5V49.1a4.28,4.28,0,0,1-1.23,3.45,5.69,5.69,0,0,1-3.73,1H472.87Zm6.84,1.08a2.15,2.15,0,0,0,.54-1.57,2.21,2.21,0,0,0-.54-1.58,1.77,1.77,0,0,0-1.34-.56,1.75,1.75,0,0,0-1.33.56,2.29,2.29,0,0,0-.51,1.58,2.23,2.23,0,0,0,.51,1.57,1.77,1.77,0,0,0,1.33.54A1.79,1.79,0,0,0,479.71,45.21Z"/>
      <path fill="#003d6b" d="M522,32.76V53.58h-5.3a19.57,19.57,0,0,0-2.52-3.2,12.7,12.7,0,0,0-3.86-2.78v1.5A4.83,4.83,0,0,1,509,52.74,5.93,5.93,0,0,1,504.84,54a4.05,4.05,0,0,1-4.65-4.33,4.55,4.55,0,0,1,1-2.86,5,5,0,0,1,3.31-1.62V39.5a4,4,0,0,1-2.73-.92A3.19,3.19,0,0,1,500.66,36a3.32,3.32,0,0,1,1.13-2.69,4.94,4.94,0,0,1,3.28-1,5.59,5.59,0,0,1,4,1.19,4.27,4.27,0,0,1,1.25,3.25v8.92a14.38,14.38,0,0,1,3.54,1.87,10.58,10.58,0,0,1,2.3,2.13v-17Zm-17.81,19a2.56,2.56,0,0,0,.29-1.41V46.73a2.75,2.75,0,0,0-2.54,2.86,3.87,3.87,0,0,0,.39,1.83,1.13,1.13,0,0,0,1,.73A1,1,0,0,0,504.17,51.76Zm-.71-14.23a1.83,1.83,0,0,0,1.35.54,1.75,1.75,0,0,0,1.32-.54,2.62,2.62,0,0,0,0-3.13,1.75,1.75,0,0,0-1.32-.54,1.83,1.83,0,0,0-1.35.54,2.54,2.54,0,0,0,0,3.13Z"/>
      <path fill="#003d6b" d="M535.49,52.7a5,5,0,0,1-1.19-3.52V32.76h5.84V47a4.3,4.3,0,0,1,2.75.84,3,3,0,0,1,1.05,2.47A3.36,3.36,0,0,1,542.79,53a5,5,0,0,1-3.3,1C537.62,54,536.28,53.54,535.49,52.7Zm5.61-.77a2.21,2.21,0,0,0,.54-1.58,2.07,2.07,0,0,0-.54-1.55,1.86,1.86,0,0,0-1.34-.53,1.8,1.8,0,0,0-1.33.53,2.11,2.11,0,0,0-.52,1.55,2.25,2.25,0,0,0,.52,1.58,1.75,1.75,0,0,0,1.33.56A1.8,1.8,0,0,0,541.1,51.93Z"/>
      <path fill="#003d6b" d="M556.2,39.5a4,4,0,0,1-2.72-.92A3.2,3.2,0,0,1,552.4,36a3.35,3.35,0,0,1,1.13-2.69,5,5,0,0,1,3.29-1,5.61,5.61,0,0,1,4,1.19A4.27,4.27,0,0,1,562,36.79v8.59l3.69-10h2.62l3.65,10V32.76h5.84V53.58H572V53l-5-13.29L562,53v.56H556.2Zm1.68-2a2.66,2.66,0,0,0,0-3.13,1.77,1.77,0,0,0-1.33-.54,1.79,1.79,0,0,0-1.34.54,2.54,2.54,0,0,0,0,3.13,1.79,1.79,0,0,0,1.34.54A1.77,1.77,0,0,0,557.88,37.53Z"/>
      <path fill="#003d6b" d="M587.14,46.73q0-2.86,3.53-4a6.41,6.41,0,0,1-2.78-2,5.25,5.25,0,0,1-1.1-3.37,4.54,4.54,0,0,1,1.54-3.79,6.77,6.77,0,0,1,4.3-1.22,5.78,5.78,0,0,1,3.44.9,2.89,2.89,0,0,1,1.25,2.45,3.41,3.41,0,0,1-1,2.6,4.09,4.09,0,0,1-2.92,1,6.83,6.83,0,0,1-.77-.08,1.94,1.94,0,0,0,1.17,1.71,5.45,5.45,0,0,0,2.48.55h2.23v2.45H596a2.75,2.75,0,0,0-2.26.88A3.27,3.27,0,0,0,593,47v4.67h5.07a2.53,2.53,0,0,0,2-.68,2.94,2.94,0,0,0,.61-2V32.76h5.85V49.29a5,5,0,0,1-.54,2.54,3.07,3.07,0,0,1-1.75,1.34,10.86,10.86,0,0,1-3.4.41H587.14Zm7-9.35a2.15,2.15,0,0,0,.54-1.57,2.21,2.21,0,0,0-.54-1.58,1.9,1.9,0,0,0-2.69,0,2.21,2.21,0,0,0-.54,1.58,2.15,2.15,0,0,0,.54,1.57,1.95,1.95,0,0,0,2.69,0Z"/>
      <path fill="#003d6b" d="M598.66,27.81a3.88,3.88,0,0,1-1.11-3,3.62,3.62,0,0,1,1.34-3A12.51,12.51,0,0,1,602.7,20l1.34-.41a2.34,2.34,0,0,0,1.15-.77,1.71,1.71,0,0,0,.39-1h3.26c-.05,1.71-.73,2.78-2,3.2l-3.62,1.17a8.37,8.37,0,0,0-1,.45q-.48.27-.45.45a2.39,2.39,0,0,1,.85-.19,1.49,1.49,0,0,1,.38,0,2.44,2.44,0,0,1,1.73.92,3.15,3.15,0,0,1,.58,1.94A2.73,2.73,0,0,1,604.19,28a4,4,0,0,1-2.61.85A4.12,4.12,0,0,1,598.66,27.81Zm4.27-.92a1.81,1.81,0,0,0,.42-1.28,1.65,1.65,0,0,0-.42-1.19,1.49,1.49,0,0,0-1.08-.43,1.37,1.37,0,0,0-1,.43,1.68,1.68,0,0,0-.4,1.19,1.85,1.85,0,0,0,.4,1.28,1.31,1.31,0,0,0,1,.45A1.43,1.43,0,0,0,602.93,26.89Z"/>
      <path fill="#003d6b" d="M463.18,115.29q-8.79,7-25.11,7H417.21V159.5H396.42V60.92h43q14.86,0,23.71,7.42t8.84,23Q472,108.27,463.18,115.29Zm-16-34.53q-4-3.2-11.14-3.19H417.21v28.22h18.86q7.17,0,11.14-3.44t4-10.93Q451.19,83.95,447.21,80.76Z"/>
      <path fill="#003d6b" d="M511.76,102.61A31,31,0,0,0,519.4,101q4.13-1.69,4.12-5.27c0-2.91-1-4.91-3.16-6s-5.2-1.65-9.28-1.65q-6.87,0-9.73,3.25a13.24,13.24,0,0,0-2.72,6.5H480.19q.6-9.3,5.39-15.28,7.6-9.36,26.14-9.37a47.78,47.78,0,0,1,21.42,4.62q9.38,4.62,9.37,17.43v32.51q0,3.39.13,8.19.21,3.65,1.14,4.95A6.89,6.89,0,0,0,546.6,143v2.73H525.8a19.89,19.89,0,0,1-1.2-4q-.35-1.89-.54-4.29a38.94,38.94,0,0,1-9.18,7.09,28.48,28.48,0,0,1-14,3.44q-10,0-16.5-5.49t-6.51-15.57q0-13.08,10.47-18.93,5.74-3.18,16.9-4.55Zm11.69,8.65a21.28,21.28,0,0,1-3.7,1.79,32.74,32.74,0,0,1-5.14,1.27l-4.35.78a29.43,29.43,0,0,0-8.79,2.53A8.42,8.42,0,0,0,497,125.5c0,3.17.92,5.45,2.76,6.86a10.69,10.69,0,0,0,6.71,2.11A20.43,20.43,0,0,0,518,131q5.28-3.51,5.48-12.81Z"/>
      <path fill="#003d6b" d="M606.32,72.78l-23.77,86.78H563.06l5.36-24.81-19-62h20.81l9,26.26L586,72.73Z"/>
      <path fill="#003d6b" d="M637.45,7V208.15H7V7H637.45m7-7H0V215.15H644.45V0Z"/>
      <path fill="#003d6b" d="M173.65,98.23q-7.83,0-11.38,5.93a27.31,27.31,0,0,0-3.55,14.3q0,8,3.55,13.41t11.29,5.36q8.48,0,11.63-6.37a31.47,31.47,0,0,0,3.16-14.19q0-7-2.28-11.47Q182.47,98.23,173.65,98.23Z"/>
      <path fill="#003d6b" d="M313.4,98.52q-9,0-12.32,8.8a34.18,34.18,0,0,0-1.78,12,24.8,24.8,0,0,0,1.78,9.93q3.36,7.83,12.32,7.82a12.4,12.4,0,0,0,10.07-5q4-5,4-14.86a27.14,27.14,0,0,0-1.78-10.36Q322.35,98.51,313.4,98.52Z"/>
      <path fill="#003d6b" d="M36.68,60.92v98.64h351V60.92Zm65.8,46.57q-5.13,6-15.7,6h-22v29.25H55.25V86.64h9.54v18.94H83.64q6.38,0,10.35-2.68t4-9.47q0-7.64-5.72-10.36a20.67,20.67,0,0,0-8.61-1.46H55.25V73.55H86.76q9.36,0,15.1,5.21t5.75,14.62A21.06,21.06,0,0,1,102.48,107.49Zm42.4-7.14c-.51-.09-1-.15-1.41-.19s-.9,0-1.41,0q-6.52,0-10,4.12a14.25,14.25,0,0,0-3.5,9.49v29H119.9V92.3h8.2V101c.67-1.69,2.32-3.76,4.94-6.19a12.93,12.93,0,0,1,9.06-3.65c.16,0,.43,0,.82,0l2,.18Zm46.48,36.23q-6,7.95-18.61,7.95-10.53,0-16.72-7t-6.18-18.9q0-12.7,6.52-20.23t17.52-7.53a23.22,23.22,0,0,1,16.66,6.49q6.81,6.49,6.81,19.11Q197.36,128.62,191.36,136.58ZM278,142.74h-9v-35q0-5-2.57-6.92a10.24,10.24,0,0,0-6.25-1.89,12.53,12.53,0,0,0-8.75,3.35q-3.67,3.35-3.67,11.16v29.34h-8.78V109.82q0-5.13-1.24-7.49c-1.32-2.35-3.76-3.53-7.34-3.53a12.75,12.75,0,0,0-8.89,3.72q-4,3.72-4,13.47v26.75h-8.63V92.3h8.54v7.16A28.39,28.39,0,0,1,223,94a17,17,0,0,1,9.68-2.87q6.15,0,9.88,3a15.45,15.45,0,0,1,3.84,5,18.55,18.55,0,0,1,6.76-6,19.15,19.15,0,0,1,8.72-2q10.36,0,14.1,7.35,2,3.95,2,10.64ZM327.55,140a20.18,20.18,0,0,1-13,4.48,18,18,0,0,1-9.77-2.5,22.46,22.46,0,0,1-5.16-4.85v18.22H291V92.53h8.44v6.69a20.8,20.8,0,0,1,5.68-5.32,18.54,18.54,0,0,1,10.28-2.83,19.52,19.52,0,0,1,14.86,6.57q6.11,6.57,6.1,18.77Q336.36,132.9,327.55,140ZM366,99.22h-8.2v32.92c0,1.76.61,2.94,1.82,3.54a8,8,0,0,0,3.36.51l1.34,0q.72,0,1.68-.15v6.73a19.2,19.2,0,0,1-3.09.61,29,29,0,0,1-3.48.19q-6,0-8.2-3a13.29,13.29,0,0,1-2.15-7.89V99.22h-7V92.3h7V78.22h8.72V92.3H366Z"/>
    </g>
  </g>
</svg>`;

const PROMPTPAY_ICON_SVG = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1221.86 782.42" width="${w}" height="${h}">
  <g id="BorderBox">
    <path fill="#002D63" d="M974.41,653.58V273.49a152.7,152.7,0,0,0-152.7-152.7h-477A152.69,152.69,0,0,0,192,273.49v477a152.69,152.69,0,0,0,152.69,152.7h477A153.77,153.77,0,0,0,840.78,902H1216ZM533,820H398.32A124.23,124.23,0,0,1,274.08,695.77v-139H419.63v75.89a41.59,41.59,0,0,0,41.58,41.59H533Zm0-471.17H461.21a41.59,41.59,0,0,0-41.58,41.59v69.65H274.08V324.4A124.23,124.23,0,0,1,398.32,200.17H533Zm361,111.24H745V390.42a41.58,41.58,0,0,0-41.58-41.59H630.67V200.17h139A124.23,124.23,0,0,1,893.92,324.4Z" transform="translate(5.88 -120.79)"/>
  </g>
  <g id="TailBox">
    <path fill="#00A796" d="M745.9,537.17V635a38.17,38.17,0,0,1-38.17,38.17H630.67V818h386.06Z" transform="translate(5.88 -120.79)"/>
  </g>
</svg>`;

// cache: โหลด/rasterize รูปแค่ครั้งแรก แล้วใช้ซ้ำทุก request ถัดไป
const imageCache = new Map();
function getCachedImage(key, svgFactory, w, h) {
    const cacheKey = `${key}:${w}x${h}`;
    if (!imageCache.has(cacheKey)) {
        imageCache.set(cacheKey, loadImage(Buffer.from(svgFactory(w, h))));
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
// ข้อความหลายภาษา — ใช้ตอน generate การ์ด (query param ?lang=th|en)
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

async function createThaiQRCard(payload, targetId, amount = 0, options = {}) {
    const { lang = 'th', showFooter = true } = options;
    const t = TEXTS[lang] || TEXTS.th;
    const isTrueMoney = targetId.length === 15;
    const hasAmount = amount > 0;

    const width = 750;

    // ------- คำนวณ layout ตามลำดับก่อน สร้าง canvas -------
    // เพื่อให้ความสูงของภาพขยับตามเนื้อหาจริงเสมอ ไม่ทับกันเหมือนตอนใช้ค่าคงที่ตายตัว
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

    // 1. พื้นหลังไล่สีตามแบรนด์
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    if (isTrueMoney) {
        bgGradient.addColorStop(0, COLORS.trueMoneyBgTop);
        bgGradient.addColorStop(1, COLORS.trueMoneyBgBottom);
    } else {
        bgGradient.addColorStop(0, COLORS.krungthaiBgTop);
        bgGradient.addColorStop(1, COLORS.krungthaiBgBottom);
    }
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // 2. โลโก้แบรนด์ด้านบนสุด
    if (isTrueMoney) {
        const tmW = 170;
        const img = await getCachedImage('truemoney', TRUEMONEY_SVG, tmW, logoH);
        ctx.drawImage(img, (width - tmW) / 2, logoTopY, tmW, logoH);
    } else {
        ctx.fillStyle = '#0C3C78';
        ctx.font = `38px ${FONT_BOLD}`;
        ctx.textAlign = 'center';
        ctx.fillText('krungthai', width / 2, logoTopY + 44);
    }

    // 3. subtitle ใต้โลโก้
    ctx.fillStyle = isTrueMoney ? 'rgba(255,255,255,0.92)' : COLORS.textGray;
    ctx.font = `20px ${FONT_REGULAR}`;
    ctx.textAlign = 'center';
    ctx.fillText(t.subtitle, width / 2, subtitleY);

    // 4. การ์ดขาวตรงกลาง พร้อมเงา
    ctx.save();
    ctx.shadowColor = 'rgba(15, 30, 60, 0.25)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = COLORS.card;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, borderRadius);
    ctx.fill();
    ctx.restore();

    // 5. Header สีน้ำเงินไล่สี ด้านในการ์ด (bo clip มุมโค้งของการ์ด)
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, borderRadius);
    ctx.clip();

    const headerGradient = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY);
    headerGradient.addColorStop(0, COLORS.headerTop);
    headerGradient.addColorStop(1, COLORS.headerBottom);
    ctx.fillStyle = headerGradient;
    ctx.fillRect(cardX, cardY, cardW, headerH);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `26px ${FONT_BOLD}`;
    ctx.textAlign = 'center';
    ctx.fillText(t.headerTitle, width / 2, cardY + 57);
    ctx.restore();

    // 6. หมายเลขปลายทาง (มาสก์บางส่วนเพื่อความเป็นส่วนตัว)
    ctx.fillStyle = COLORS.textGray;
    ctx.font = `18px ${FONT_REGULAR}`;
    ctx.textAlign = 'center';
    ctx.fillText(maskId(targetId), width / 2, idLineY);

    // 7. โลโก้ PromptPay ตรงกลางระหว่าง header กับ QR
    const ppX = (width - ppW) / 2;
    const ppImg = await getCachedImage('promptpay-header', PROMPTPAY_HEADER_SVG, ppW, ppH);
    ctx.drawImage(ppImg, ppX, ppY, ppW, ppH);

    // 8. กรอบขาวรอบ QR Code พร้อมเงาบาง ๆ และเส้นขอบอ่อน
    const qrBoxX = (width - qrBoxSize) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 30, 60, 0.12)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 20);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = COLORS.divider;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 20);
    ctx.stroke();

    const qrX = qrBoxX + qrPad;
    const qrY = qrBoxY + qrPad;

    const qrBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'H',
        margin: 0,
        width: qrSize,
        color: { dark: '#0A1F33', light: '#FFFFFF' }
    });
    const qrImage = await loadImage(qrBuffer);
    ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

    // 9. ไอคอน PromptPay สีจริงตรงกลาง QR Code
    const iconW = 52;
    const iconH = 33;
    const iconX = (width - iconW) / 2;
    const iconY = qrY + (qrSize - iconH) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(iconX - 7, iconY - 7, iconW + 14, iconH + 14, 9);
    ctx.fill();
    ctx.restore();

    const iconImg = await getCachedImage('promptpay-icon', PROMPTPAY_ICON_SVG, iconW, iconH);
    ctx.drawImage(iconImg, iconX, iconY, iconW, iconH);

    // 10. ยอดชำระ (ถ้ามีการระบุ)
    if (hasAmount) {
        ctx.strokeStyle = COLORS.divider;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cardX + 60, dividerY);
        ctx.lineTo(cardX + cardW - 60, dividerY);
        ctx.stroke();

        ctx.fillStyle = COLORS.textLight;
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.textAlign = 'center';
        ctx.fillText(t.amountLabel, width / 2, amountLabelY);

        ctx.fillStyle = COLORS.textDark;
        ctx.font = `40px ${FONT_BOLD}`;
        ctx.textAlign = 'center';
        const amountText = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        ctx.fillText(`฿ ${amountText}`, width / 2, amountValueY);
    }

    // 11. footer เวลาที่สร้าง (ปิดได้ด้วย ?footer=false)
    if (showFooter) {
        ctx.fillStyle = COLORS.textLight;
        ctx.font = `15px ${FONT_REGULAR}`;
        ctx.textAlign = 'center';
        const generatedAt = new Date().toLocaleString(t.dateLocale, {
            timeZone: 'Asia/Bangkok',
            dateStyle: 'medium',
            timeStyle: 'short'
        });
        ctx.fillText(t.footer(generatedAt), width / 2, footerY);
    }

    return canvas.toBuffer('image/png');
}

// =========================================================================
// QR เปล่า ไม่มีการ์ด/แบรนด์ — สำหรับฝังใน UI อื่น (?format=qr)
// =========================================================================
async function createBareQR(payload) {
    const qrSize = 400;
    const pad = 24;
    const size = qrSize + pad * 2;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    const qrBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'H',
        margin: 0,
        width: qrSize,
        color: { dark: '#0A1F33', light: '#FFFFFF' }
    });
    const qrImage = await loadImage(qrBuffer);
    ctx.drawImage(qrImage, pad, pad, qrSize, qrSize);

    const iconW = 50;
    const iconH = 32;
    const iconX = (size - iconW) / 2;
    const iconY = (size - iconH) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(iconX - 7, iconY - 7, iconW + 14, iconH + 14, 9);
    ctx.fill();
    ctx.restore();

    const iconImg = await getCachedImage('promptpay-icon', PROMPTPAY_ICON_SVG, iconW, iconH);
    ctx.drawImage(iconImg, iconX, iconY, iconW, iconH);

    return canvas.toBuffer('image/png');
}

// =========================================================================
// Routes
// =========================================================================
// =========================================================================
// หน้าเว็บ: เอกสาร API + ฟอร์ม demo ทดลองยิงจริง (route "/")
// =========================================================================
const DOCS_HTML = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thai PromptPay QR API</title>
<meta name="description" content="สร้าง QR Code รับเงินผ่าน PromptPay ฟรี รองรับเบอร์โทร เลขบัตรประชาชน และ TrueMoney Wallet">
<meta property="og:title" content="Thai PromptPay QR API">
<meta property="og:description" content="สร้าง QR Code รับเงินผ่าน PromptPay ฟรี รองรับเบอร์โทร เลขบัตรประชาชน และ TrueMoney Wallet">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230C3C78'/%3E%3Ctext x='50' y='70' font-size='58' text-anchor='middle' fill='white' font-family='sans-serif' font-weight='bold'%3E%E0%B8%BF%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
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
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Sarabun', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
  }
  header {
    background: linear-gradient(135deg, var(--navy) 0%, var(--blue) 100%);
    color: #fff;
    padding: 48px 24px 64px;
    text-align: center;
  }
  header h1 { margin: 0 0 8px; font-size: 32px; font-weight: 700; }
  header p { margin: 0; opacity: .9; font-size: 16px; }
  .wrap { max-width: 880px; margin: -36px auto 60px; padding: 0 20px; }
  .card {
    background: var(--card);
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 10px 30px rgba(15,30,60,.08);
    margin-bottom: 24px;
    border: 1px solid var(--border);
  }
  .card h2 { margin-top: 0; font-size: 20px; color: var(--navy-dark); }
  .card h3 { font-size: 16px; color: var(--navy); margin-bottom: 6px; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; color: var(--text); }
  input, select {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
    font-family: inherit; font-size: 15px; background: #fbfcfe;
  }
  input:focus, select:focus { outline: 2px solid var(--blue); border-color: var(--blue); }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 140px; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .checkbox-row input { width: auto; }
  button {
    margin-top: 20px; width: 100%; padding: 13px; border: none; border-radius: 12px;
    background: var(--navy); color: #fff; font-family: inherit; font-size: 16px; font-weight: 600;
    cursor: pointer; transition: background .15s;
  }
  button:hover { background: var(--blue); }
  button:disabled { background: #B9C4D3; cursor: not-allowed; }
  #result { margin-top: 22px; text-align: center; }
  #result img { max-width: 100%; border-radius: 14px; box-shadow: 0 6px 20px rgba(15,30,60,.12); }
  #result pre {
    text-align: left; background: #0C1F33; color: #CFE7FF; padding: 16px; border-radius: 12px;
    overflow-x: auto; font-size: 13px;
  }
  #result .error { color: #C0392B; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 10px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text-gray); font-weight: 600; font-size: 13px; }
  code {
    background: #EEF2F8; padding: 2px 6px; border-radius: 6px; font-size: 13px;
    color: var(--navy-dark);
  }
  pre.example {
    background: #0C1F33; color: #CFE7FF; padding: 14px 16px; border-radius: 12px;
    overflow-x: auto; font-size: 13px; margin: 10px 0;
  }
  .badge {
    display: inline-block; background: var(--teal); color: #fff; font-size: 11px;
    padding: 2px 8px; border-radius: 999px; margin-left: 6px; vertical-align: middle;
  }
  footer { text-align: center; color: var(--text-gray); font-size: 13px; padding: 20px; }
  .notice {
    max-width: 880px; margin: 16px auto 0; padding: 10px 18px; font-size: 13px;
    background: #FFF6E5; color: #7A5B00; border: 1px solid #F0DCA0; border-radius: 10px;
  }
</style>
</head>
<body>

<header>
  <h1>Thai PromptPay QR API</h1>
  <p>สร้าง QR Code รับเงินผ่าน PromptPay (เบอร์โทร / เลขบัตรประชาชน / TrueMoney Wallet)</p>
</header>

<div class="notice">⏳ ถ้าไม่มีคนใช้งานนานเกิน ~15 นาที เซิร์ฟเวอร์จะพักตัวเอง คำขอแรกหลังจากนั้นอาจช้ากว่าปกติ 10-20 วินาที ครั้งถัดไปจะเร็วปกติ</div>

<div class="wrap">

  <div class="card">
    <h2>🔧 ลองใช้งานจริง</h2>
    <div class="row">
      <div>
        <label>หมายเลขพร้อมเพย์</label>
        <input id="f-id" type="text" placeholder="0891234567" value="0891234567">
      </div>
      <div>
        <label>จำนวนเงิน (ไม่ใส่ก็ได้)</label>
        <input id="f-amount" type="text" placeholder="259.50">
      </div>
    </div>
    <div class="row">
      <div>
        <label>รูปแบบผลลัพธ์ (format)</label>
        <select id="f-format">
          <option value="card">card — การ์ดเต็มพร้อมแบรนด์</option>
          <option value="qr">qr — QR เปล่า ไม่มีการ์ด</option>
          <option value="payload">payload — payload string (JSON)</option>
        </select>
      </div>
      <div>
        <label>ภาษา (lang) — ใช้กับ format=card</label>
        <select id="f-lang">
          <option value="th">th — ไทย</option>
          <option value="en">en — English</option>
        </select>
      </div>
    </div>
    <div class="checkbox-row">
      <input id="f-footer" type="checkbox" checked>
      <label style="margin:0;">แสดง footer เวลาที่สร้าง (ใช้กับ format=card)</label>
    </div>
    <button id="f-submit">สร้าง QR Code</button>
    <div id="result"></div>
  </div>

  <div class="card">
    <h2>📄 เอกสาร API</h2>

    <h3>GET /qr/:id/:amount?</h3>
    <p>สร้าง QR Code พร้อมเพย์ ใส่ <code>:amount</code> หรือไม่ก็ได้ (ไม่ใส่ = ไม่ระบุยอด สแกนแล้วกรอกเองที่แอปธนาคาร)</p>
    <table>
      <tr><th>Path param</th><th>คำอธิบาย</th></tr>
      <tr><td><code>id</code></td><td>เบอร์โทร (10 หลัก), เลขบัตรประชาชน (13 หลัก) หรือ TrueMoney Wallet ID (15 หลัก)</td></tr>
      <tr><td><code>amount</code></td><td>จำนวนเงิน (ไม่บังคับ, 0–1,000,000)</td></tr>
    </table>
    <table>
      <tr><th>Query param</th><th>ค่าที่รองรับ</th><th>ค่าเริ่มต้น</th></tr>
      <tr><td><code>format</code></td><td><code>card</code> / <code>qr</code> / <code>payload</code></td><td><code>card</code></td></tr>
      <tr><td><code>lang</code></td><td><code>th</code> / <code>en</code></td><td><code>th</code></td></tr>
      <tr><td><code>footer</code></td><td><code>true</code> / <code>false</code></td><td><code>true</code></td></tr>
    </table>

    <h3>ตัวอย่าง</h3>
    <pre class="example">GET /qr/0891234567/259.50
GET /qr/0891234567?format=qr
GET /qr/0891234567/100?lang=en&footer=false
GET /qr/123456789012345?format=payload</pre>

    <h3>GET /health <span class="badge">status check</span></h3>
    <p>คืน <code>{"status":"ok"}</code> สำหรับเช็คว่า service ยังทำงานอยู่</p>
  </div>

</div>

<footer>Thai PromptPay QR API</footer>

<script>
const $ = (id) => document.getElementById(id);

$('f-submit').addEventListener('click', async () => {
  const id = $('f-id').value.trim();
  const amount = $('f-amount').value.trim();
  const format = $('f-format').value;
  const lang = $('f-lang').value;
  const footer = $('f-footer').checked;
  const resultEl = $('result');
  const btn = $('f-submit');

  if (!id) {
    resultEl.innerHTML = '<p class="error">กรุณากรอกหมายเลขพร้อมเพย์</p>';
    return;
  }

  let url = '/qr/' + encodeURIComponent(id);
  if (amount) url += '/' + encodeURIComponent(amount);
  const params = new URLSearchParams({ format, lang, footer: footer ? 'true' : 'false' });
  url += '?' + params.toString();

  btn.disabled = true;
  btn.textContent = 'กำลังสร้าง...';
  resultEl.innerHTML = '';

  try {
    if (format === 'payload') {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        resultEl.innerHTML = '<p class="error">' + (data.message || 'เกิดข้อผิดพลาด') + '</p>';
      } else {
        resultEl.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
      }
    } else {
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        resultEl.innerHTML = '<p class="error">' + (data.message || 'เกิดข้อผิดพลาด') + '</p>';
      } else {
        const blob = await res.blob();
        const imgUrl = URL.createObjectURL(blob);
        resultEl.innerHTML = '<img src="' + imgUrl + '" alt="QR Code">';
      }
    }
  } catch (err) {
    resultEl.innerHTML = '<p class="error">เรียก API ไม่สำเร็จ: ' + err.message + '</p>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'สร้าง QR Code';
  }
});
</script>

</body>
</html>`;

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DOCS_HTML);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/qr/:id/:amount?', qrLimiter, async (req, res) => {
    try {
        const targetId = validateTargetId(req.params.id);
        const parsedAmount = validateAmount(req.params.amount);

        const format = ['card', 'qr', 'payload'].includes(req.query.format) ? req.query.format : 'card';
        const lang = TEXTS[req.query.lang] ? req.query.lang : 'th';
        const showFooter = req.query.footer !== 'false';

        const payload = generatePayload(targetId, { amount: parsedAmount || undefined });

        // ?format=payload — คืน payload string ดิบเป็น JSON เผื่อฝั่ง frontend อยาก render เอง
        if (format === 'payload') {
            return res.json({
                targetId: maskId(targetId),
                amount: parsedAmount,
                payload
            });
        }

        // ?format=qr — QR เปล่า ไม่มีการ์ด/แบรนด์ สำหรับฝังใน UI อื่น
        const imageBuffer = format === 'qr'
            ? await createBareQR(payload)
            : await createThaiQRCard(payload, targetId, parsedAmount, { lang, showFooter });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(imageBuffer);

    } catch (err) {
        if (err instanceof ValidationError) {
            return res.status(err.status).json({ error: 'Invalid Parameters', message: err.message });
        }
        // ไม่ leak รายละเอียด internal error กลับไปให้ client — ให้แค่ errorId
        // ไปเทียบกับ log ฝั่ง server (Render → Logs) เอาเอง
        const errorId = logError(err, { route: '/qr' });
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'เกิดข้อผิดพลาดระหว่างสร้าง QR Code กรุณาลองใหม่อีกครั้ง',
            errorId
        });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: 'ไม่พบ endpoint ที่ร้องขอ' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
// export ฟังก์ชัน pure function ไว้ให้ test เรียกตรงๆ ได้ โดยไม่ต้องเปิด
// HTTP server จริง — ไม่กระทบการทำงานปกติของแอป (app ยังใช้เป็น Express
// app ได้เหมือนเดิมทุกอย่าง แค่แปะ property เพิ่มไว้)
module.exports.validateTargetId = validateTargetId;
module.exports.validateAmount = validateAmount;
module.exports.maskId = maskId;
module.exports.ValidationError = ValidationError;