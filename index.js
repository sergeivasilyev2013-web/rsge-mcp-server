const http = require('http');
const fs = require('fs');
const querystring = require('querystring');

// --- Загрузка кредов служебного пользователя ---
function loadCredentials() {
    try {
        const data = fs.readFileSync('./credentials.json', 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

// --- Сохранение кредов (если нужно) ---
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

// --- Создание служебного пользователя (SOAP) ---
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
    const newSp = require('crypto').randomBytes(10).toString('hex');
    console.log(`🔄 Создаём нового пользователя: ${newSu} для IP ${currentIP}`);
    await createServiceUser(masterSu, masterSp, currentIP, newSu, newSp);
    const newCreds = { ip: currentIP, su: newSu, sp: newSp };
    saveCredentials(newCreds);
    console.log(`✅ Пользователь ${newSu} сохранён.`);
    return newCreds;
}

// --- Публичный метод GetTPInfoPublic (для проверки ИНН) ---
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

// --- СОЗДАНИЕ НАКЛАДНОЙ (метод add_invoice или save_waybill) ---
async function createInvoice(data) {
    const creds = loadCredentials();
    if (!creds) throw new Error('Нет служебного пользователя');
    const { su, sp } = creds;

    // data должен содержать: buyerTin, total, description (опционально), items (массив)
    // Для простоты используем базовый запрос
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <add_invoice xmlns="http://tempuri.org/">
      <su>${su}</su>
      <sp>${sp}</sp>
      <buyerTin>${data.buyerTin}</buyerTin>
      <total>${data.total}</total>
      <description>${data.description || ''}</description>
      <items>${data.items ? JSON.stringify(data.items) : ''}</items>
    </add_invoice>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/WayBillService/WayBillService.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/add_invoice',
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

// --- РЕГИСТРАЦИЯ ОПЛАТЫ (метод update_invoice_status или add_payment) ---
async function recordPayment(data) {
    const creds = loadCredentials();
    if (!creds) throw new Error('Нет служебного пользователя');
    const { su, sp } = creds;

    // data: invoiceId, amount, paymentDate
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
            res.on('end', () => resolve(data));
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
                    description: "Создать накладную в rs.ge",
                    input_schema: {
                        type: "object",
                        properties: {
                            buyerTin: { type: "string", description: "ИНН покупателя" },
                            total: { type: "number", description: "Сумма в лари" },
                            description: { type: "string", description: "Описание (необязательно)" }
                        },
                        required: ["buyerTin", "total"]
                    }
                },
                {
                    name: "record_payment",
                    description: "Зарегистрировать оплату по накладной",
                    input_schema: {
                        type: "object",
                        properties: {
                            invoiceId: { type: "string", description: "ID накладной" },
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
                    const total = args.total;
                    if (!buyerTin || !total) throw new Error('Не хватает данных (buyerTin, total)');
                    const response = await createInvoice({ buyerTin, total, description: args.description });
                    result = { success: true, raw: response };
                } else if (tool === 'record_payment') {
                    const invoiceId = args.invoiceId;
                    const amount = args.amount;
                    if (!invoiceId || !amount) throw new Error('Не хватает данных (invoiceId, amount)');
                    const response = await recordPayment({ invoiceId, amount });
                    result = { success: true, raw: response };
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
