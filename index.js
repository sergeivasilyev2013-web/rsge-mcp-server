const http = require('http');

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Эндпоинт /ping
    if (req.url === '/ping' && req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok', message: 'Сервер работает' }));
        return;
    }

    // Эндпоинт /tools
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

    // Эндпоинт /execute (заглушка, чтобы не падал)
    if (req.url === '/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                // Пока просто отвечаем, что запрос принят
                res.end(JSON.stringify({ result: 'заглушка', received: data }));
            } catch (e) {
                res.end(JSON.stringify({ error: 'невалидный JSON' }));
            }
        });
        return;
    }

    // Все остальные запросы — 404
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});
