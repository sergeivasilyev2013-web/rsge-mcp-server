const express = require('express');
const fs = require('fs');
const axios = require('axios');
const soap = require('soap');

const app = express();
app.use(express.json());

const CRED_FILE = './credentials.json'; // файл для хранения пары su/sp

// Функция для получения текущего публичного IP сервера
async function getCurrentIP() {
    const resp = await axios.get('https://ifconfig.me/ip', { timeout: 5000 });
    return resp.data.trim();
}

// Функция для создания служебного пользователя в rs.ge
async function createServiceUser(masterSu, masterSp, ip, newSu, newSp) {
    const wsdl = 'https://services.rs.ge/WayBillService/WayBillService.asmx?wsdl';
    const client = await soap.createClientAsync(wsdl);
    // Имя метода: create_service_user (из WSDL)
    const result = await client.create_service_userAsync({
        username: masterSu,
        password: masterSp,
        ip: ip,
        name: 'MicrozelenAuto',
        su: newSu,
        sp: newSp
    });
    return result;
}

// Функция, которая проверяет IP и создает/обновляет учётку
async function ensureCredentials() {
    let creds = {};
    if (fs.existsSync(CRED_FILE)) {
        creds = JSON.parse(fs.readFileSync(CRED_FILE));
    }
    const currentIP = await getCurrentIP();

    // Если IP совпадает и есть креды — используем их
    if (creds.ip === currentIP && creds.su && creds.sp) {
        console.log(`✅ IP не изменился (${currentIP}), используем существующего пользователя: ${creds.su}`);
        return creds;
    }

    // Иначе создаём нового пользователя
    console.log(`🔄 IP изменился или креды отсутствуют. Старый IP: ${creds.ip || 'нет'}, новый: ${currentIP}`);
    const masterSu = process.env.MASTER_SU;
    const masterSp = process.env.MASTER_SP;
    if (!masterSu || !masterSp) {
        throw new Error('MASTER_SU и MASTER_SP не заданы в переменных окружения!');
    }

    // Генерируем уникальный логин и пароль
    const newSu = 'sergei_' + Date.now().toString(36);
    const newSp = require('crypto').randomBytes(10).toString('hex');

    console.log(`👤 Создаём нового пользователя: ${newSu}`);
    await createServiceUser(masterSu, masterSp, currentIP, newSu, newSp);

    const newCreds = { ip: currentIP, su: newSu, sp: newSp };
    fs.writeFileSync(CRED_FILE, JSON.stringify(newCreds, null, 2));
    console.log(`✅ Пользователь ${newSu} успешно создан и сохранён.`);
    return newCreds;
}

// --- Middleware для обработки запросов ---

// Эндпоинт для проверки работоспособности
app.get('/ping', (req, res) => {
    res.json({ status: 'ok' });
});

// Эндпоинт для выполнения инструментов (упрощённая заглушка)
app.post('/execute', async (req, res) => {
    const { tool, arguments: args } = req.body;
    // Здесь позже добавим логику для get_company_by_tin и других
    // Сейчас просто возвращаем информацию о полученных данных
    res.json({
        result: `Инструмент "${tool}" вызван с аргументами: ${JSON.stringify(args)}`,
        // Для отладки покажем, какие креды используются (но не пароль!)
        used_su: global.RS_CREDS ? global.RS_CREDS.su : 'не задан'
    });
});

// --- Запуск сервера ---
const PORT = process.env.PORT || 8080;

async function start() {
    try {
        const creds = await ensureCredentials();
        global.RS_CREDS = creds; // сохраняем креды в глобальную переменную для использования в других функциях

        app.listen(PORT, () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
            console.log(`🔑 Используется служебный пользователь: ${creds.su}`);
        });
    } catch (err) {
        console.error('❌ Ошибка инициализации:', err.message);
        process.exit(1);
    }
}

start();
