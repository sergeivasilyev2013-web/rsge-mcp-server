const http = require('http');

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/ping' && req.method === 'GET') {
        res.end(JSON.stringify({ status: 'ok', message: 'Сервер работает!' }));
        return;
    }

    if (req.url === '/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                res.end(JSON.stringify({ result: 'заглушка', received: data }));
            } catch (e) {
                res.end(JSON.stringify({ error: 'невалидный JSON' }));
            }
        });
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});
