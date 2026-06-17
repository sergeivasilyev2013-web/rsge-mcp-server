const http = require('http');
const querystring = require('querystring');

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // --- /ping ---
    if (req.url === '/ping' && req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok', message: 'Сервер работает' }));
        return;
    }

    // --- /tools ---
    if (req.url === '/tools' && req.method === 'GET') {
        res.end(JSON.stringify({
            tools: [{
                name: "get_company_by_tin",
                description: "Найти компанию по ИНН",
                input_schema: {
                    type: "object",
                    properties: {
                        tin: { type: "string", description: "11 цифр ИНН" }
                    },
                    required: ["tin"]
                }
            }]
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

                if (tool === 'get_company_by_tin') {
                    const tin = args.tin;
                    if (!tin) throw new Error('Не указан ИНН');

                    // Делаем реальный запрос к rs.ge (публичный метод)
                    const result = await getCompanyByTin(tin);
                    res.end(JSON.stringify({ result: { success: true, data: result } }));
                } else {
                    res.end(JSON.stringify({ result: { error: `Неизвестный инструмент: ${tool}` } }));
                }
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

// --- Функция запроса к rs.ge (публичный метод GetTPInfoPublic) ---
async function getCompanyByTin(tin) {
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
                // Парсим XML ответ (очень упрощённо — извлекаем название компании)
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});
