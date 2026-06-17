const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// --- Загрузка кредов служебного пользователя ---
function loadCredentials() {
    try {
        const data = fs.readFileSync('./credentials.json', 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

function saveCredentials(creds) {
    fs.writeFileSync('./credentials.json', JSON.stringify(creds, null, 2));
}

// --- Получение текущего IP ---
function getCurrentIP() {
    return new Promise((resolve, reject) => {
        const req = http.get('http://ifconfig.me/ip', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data.trim()));
        });
        req.on('error', reject);
        req.end();
    });
}

// --- Создание служебного пользователя ---
async function createServiceUser(masterSu, masterSp, ip, newSu, newSp) {
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <create_service_user xmlns="http://tempuri.org/">
      <username>${masterSu}</username>
      <password>${masterSp}</password>
      <ip>${ip}</ip>
      <name>MicrozelenAuto</name>
      <su>${newSu}</su>
      <sp>${newSp}</sp>
    </create_service_user>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/WayBillService/WayBillService.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/create_service_user',
            'Content-Length': Buffer.byteLength(soapBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

// --- Автоматическая проверка/создание кредов ---
async function ensureCredentials() {
    let creds = loadCredentials();
    const currentIP = await getCurrentIP();
    if (creds && creds.ip === currentIP) {
        console.log(`✅ IP стабилен (${currentIP}), используем ${creds.su}`);
        return creds;
    }

    const masterSu = process.env.MASTER_SU;
    const masterSp = process.env.MASTER_SP;
    if (!masterSu || !masterSp) {
        throw new Error('MASTER_SU и MASTER_SP не заданы в переменных окружения');
    }

    const newSu = 'sergei_' + Date.now().toString(36);
    const newSp = crypto.randomBytes(10).toString('hex');
    console.log(`🔄 Создаём нового пользователя: ${newSu} для IP ${currentIP}`);
    await createServiceUser(masterSu, masterSp, currentIP, newSu, newSp);
    const newCreds = { ip: currentIP, su: newSu, sp: newSp };
    saveCredentials(newCreds);
    console.log(`✅ Пользователь ${newSu} сохранён.`);
    return newCreds;
}

// --- Публичный метод GetTPInfoPublic (проверка ИНН) ---
async function getCompanyByTinPublic(tin) {
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetTPInfoPublic xmlns="http://tempuri.org/">
      <TIN>${tin}</TIN>
    </GetTPInfoPublic>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/taxservice/taxpayerservice.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/GetTPInfoPublic',
            'Content-Length': Buffer.byteLength(soapBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const nameMatch = data.match(/<TP_Name>([^<]*)<\/TP_Name>/);
                const statusMatch = data.match(/<TP_Status>([^<]*)<\/TP_Status>/);
                resolve({
                    tin: tin,
                    name: nameMatch ? nameMatch[1] : 'Не найдено',
                    status: statusMatch ? statusMatch[1] : 'Неизвестно'
                });
            });
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

// --- СОЗДАНИЕ НАКЛАДНОЙ (save_waybill) ---
async function createInvoice(data) {
    const creds = loadCredentials();
    if (!creds) throw new Error('Нет служебного пользователя');
    const { su, sp } = creds;
    const sellerTin = process.env.SELLER_TIN || '345685902';

    // Если товары не переданы, создаём один товар по умолчанию
    const items = data.items || [{
        name: data.description || 'Микрозелень',
        code: data.productCode || '55000005',
        quantity: data.quantity || 1,
        price: data.total || data.totalAmount || 0
    }];

    // Формируем XML для каждого товара
    const itemsXml = items.map(item => `
        <item>
            <productName>${item.name}</productName>
            <productCode>${item.code || '55000005'}</productCode>
            <quantity>${item.quantity || 1}</quantity>
            <unitPrice>${item.price || item.unitPrice || 0}</unitPrice>
            <totalPrice>${(item.quantity || 1) * (item.price || item.unitPrice || 0)}</totalPrice>
        </item>
    `).join('');

    const totalAmount = items.reduce((sum, item) => sum + (item.quantity || 1) * (item.price || item.unitPrice || 0), 0);

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <save_waybill xmlns="http://tempuri.org/">
      <su>${su}</su>
      <sp>${sp}</sp>
      <sellerTin>${sellerTin}</sellerTin>
      <buyerTin>${data.buyerTin}</buyerTin>
      <totalAmount>${totalAmount}</totalAmount>
      <items>${itemsXml}</items>
      <description>${data.description || ''}</description>
    </save_waybill>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/WayBillService/WayBillService.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/save_waybill',
            'Content-Length': Buffer.byteLength(soapBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const idMatch = data.match(/<waybillId>([^<]*)<\/waybillId>/);
                resolve({
                    success: true,
                    waybillId: idMatch ? idMatch[1] : 'неизвестен',
                    raw: data
                });
            });
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

// --- РЕГИСТРАЦИЯ ОПЛАТЫ (update_invoice_status) ---
async function recordPayment(data) {
    const creds = loadCredentials();
    if (!creds) throw new Error('Нет служебного пользователя');
    const { su, sp } = creds;

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <update_invoice_status xmlns="http://tempuri.org/">
      <su>${su}</su>
      <sp>${sp}</sp>
      <invoiceId>${data.invoiceId}</invoiceId>
      <status>paid</status>
      <amount>${data.amount}</amount>
      <paymentDate>${data.paymentDate || new Date().toISOString().slice(0,10)}</paymentDate>
    </update_invoice_status>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/WayBillService/WayBillService.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/update_invoice_status',
            'Content-Length': Buffer.byteLength(soapBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ success: true, raw: data }));
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

// --- HTTP сервер ---
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/ping' && req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    if (req.url === '/tools' && req.method === 'GET') {
        res.end(JSON.stringify({
            tools: [
                {
                    name: "get_company_by_tin",
                    description: "Проверить ИНН (публичный метод)",
                    input_schema: {
                        type: "object",
                        properties: {
                            tin: { type: "string", description: "11 цифр ИНН" }
                        },
                        required: ["tin"]
                    }
                },
                {
                    name: "create_invoice",
                    description: "Создать накладную в rs.ge (по образцу)",
                    input_schema: {
                        type: "object",
                        properties: {
                            buyerTin: { type: "string", description: "ИНН покупателя (11 цифр)" },
                            total: { type: "number", description: "Сумма в лари (если нет товаров)" },
                            description: { type: "string", description: "Описание (например, заказ от...)" },
                            items: {
                                type: "array",
                                description: "Массив товаров (можно передать один)",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string", description: "Название товара" },
                                        price: { type: "number", description: "Цена за единицу" },
                                        quantity: { type: "number", description: "Количество" }
                                    }
                                }
                            }
                        },
                        required: ["buyerTin"]
                    }
                },
                {
                    name: "record_payment",
                    description: "Зарегистрировать оплату по накладной",
                    input_schema: {
                        type: "object",
                        properties: {
                            invoiceId: { type: "string", description: "ID накладной (из ответа create_invoice)" },
                            amount: { type: "number", description: "Сумма оплаты" }
                        },
                        required: ["invoiceId", "amount"]
                    }
                }
            ]
        }));
        return;
    }

    if (req.url === '/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { tool, arguments: args } = data;
                let result;

                if (tool === 'get_company_by_tin') {
                    const tin = args.tin;
                    if (!tin) throw new Error('Не указан ИНН');
                    result = await getCompanyByTinPublic(tin);
                } else if (tool === 'create_invoice') {
                    const buyerTin = args.buyerTin;
                    if (!buyerTin) throw new Error('Не указан ИНН покупателя');
                    // Если передана сумма без товаров — создаём один товар
                    if (args.total && !args.items) {
                        args.items = [{
                            name: args.description || 'Микрозелень',
                            price: args.total,
                            quantity: 1
                        }];
                    }
                    const response = await createInvoice({
                        buyerTin,
                        total: args.total,
                        description: args.description,
                        items: args.items
                    });
                    result = response;
                } else if (tool === 'record_payment') {
                    const invoiceId = args.invoiceId;
                    const amount = args.amount;
                    if (!invoiceId || !amount) throw new Error('Не хватает данных (invoiceId, amount)');
                    const response = await recordPayment({ invoiceId, amount });
                    result = response;
                } else {
                    throw new Error(`Неизвестный инструмент: ${tool}`);
                }

                res.end(JSON.stringify({ result: { success: true, data: result } }));
            } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Запуск ---
const PORT = process.env.PORT || 8080;

async function start() {
    try {
        const creds = await ensureCredentials();
        global.RS_CREDS = creds;
        server.listen(PORT, () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
            console.log(`🔑 Используется служебный пользователь: ${creds.su}`);
        });
    } catch (err) {
        console.error('❌ Ошибка инициализации:', err.message);
        process.exit(1);
    }
}

start();
