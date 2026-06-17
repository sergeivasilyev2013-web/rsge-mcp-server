const http = require('http');
const fs = require('fs');

// --- Загрузка кредов служебного пользователя ---
function loadCredentials() {
    try {
        const data = fs.readFileSync('./credentials.json', 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // --- /ping ---
    if (req.url === '/ping' && req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    // --- /tools ---
    if (req.url === '/tools' && req.method === 'GET') {
        res.end(JSON.stringify({
            tools: [
                {
                    name: "get_company_by_tin",
                    description: "Найти компанию по ИНН (публичный метод)",
                    input_schema: {
                        type: "object",
                        properties: {
                            tin: { type: "string", description: "11 цифр ИНН" }
                        },
                        required: ["tin"]
                    }
                },
                {
                    name: "get_name_from_tin",
                    description: "Получить название компании по ИНН (авторизованный метод)",
                    input_schema: {
                        type: "object",
                        properties: {
                            tin: { type: "string", description: "11 цифр ИНН" }
                        },
                        required: ["tin"]
                    }
                }
            ]
        }));
        return;
    }

    // --- /execute ---
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
                } else if (tool === 'get_name_from_tin') {
                    const tin = args.tin;
                    if (!tin) throw new Error('Не указан ИНН');
                    const creds = loadCredentials();
                    if (!creds) throw new Error('Нет сохранённых кредов');
                    result = await getCompanyNameByTin(tin, creds.su, creds.sp);
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

// --- Публичный метод GetTPInfoPublic ---
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

// --- Авторизованный метод get_name_from_tin ---
async function getCompanyNameByTin(tin, su, sp) {
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <get_name_from_tin xmlns="http://tempuri.org/">
      <su>${su}</su>
      <sp>${sp}</sp>
      <tin>${tin}</tin>
    </get_name_from_tin>
  </soap:Body>
</soap:Envelope>`;

    const options = {
        hostname: 'services.rs.ge',
        path: '/WayBillService/WayBillService.asmx',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/get_name_from_tin',
            'Content-Length': Buffer.byteLength(soapBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const nameMatch = data.match(/<get_name_from_tinResult>([^<]*)<\/get_name_from_tinResult>/);
                resolve({
                    tin: tin,
                    name: nameMatch ? nameMatch[1] : 'Не найдено'
                });
            });
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});
