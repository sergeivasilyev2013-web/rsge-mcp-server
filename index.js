const express = require('express');
const fs = require('fs');
const axios = require('axios');
const soap = require('soap');

const app = express();
app.use(express.json());
const CRED_FILE = './credentials.json';

// --- IP и создание пользователя ---
async function getCurrentIP() {
    const resp = await axios.get('https://ifconfig.me/ip', { timeout: 5000 });
    return resp.data.trim();
}

async function createServiceUser(masterSu, masterSp, ip, newSu, newSp) {
    const wsdl = 'https://services.rs.ge/WayBillService/WayBillService.asmx?wsdl';
    const client = await soap.createClientAsync(wsdl);
    return client.create_service_userAsync({
        username: masterSu,
        password: masterSp,
        ip: ip,
        name: 'MicrozelenAuto',
        su: newSu,
        sp: newSp
    });
}

async function ensureCredentials() {
    let creds = {};
    if (fs.existsSync(CRED_FILE)) creds = JSON.parse(fs.readFileSync(CRED_FILE));
    const currentIP = await getCurrentIP();
    if (creds.ip === currentIP && creds.su && creds.sp) {
        console.log(`✅ IP стабилен (${currentIP}), используем ${creds.su}`);
        return creds;
    }
    const masterSu = process.env.MASTER_SU;
    const masterSp = process.env.MASTER_SP;
    if (!masterSu || !masterSp) throw new Error('MASTER_SU/MASTER_SP не заданы');
    const newSu = 'sergei_' + Date.now().toString(36);
    const newSp = require('crypto').randomBytes(10).toString('hex');
    console.log(`🔄 Создаём ${newSu} для IP ${currentIP}`);
    await createServiceUser(masterSu, masterSp, currentIP, newSu, newSp);
    const newCreds = { ip: currentIP, su: newSu, sp: newSp };
    fs.writeFileSync(CRED_FILE, JSON.stringify(newCreds, null, 2));
    console.log(`✅ ${newSu} сохранён`);
    return newCreds;
}

// --- get_company_by_tin (публичный SOAP) ---
async function getCompanyByTin(tin) {
    const wsdl = 'https://services.rs.ge/taxservice/taxpayerservice.asmx?wsdl';
    const client = await soap.createClientAsync(wsdl);
    const result = await client.GetTPInfoPublicAsync({ TIN: tin });
    return result;
}

// --- Эндпоинты ---
app.get('/ping', (req, res) => res.json({ status: 'ok' }));

app.get('/tools', (req, res) => {
    res.json({
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
    });
});

app.post('/execute', async (req, res) => {
    const { tool, arguments: args } = req.body;
    try {
        let result;
        if (tool === 'get_company_by_tin') {
            const tin = args.tin;
            if (!tin) throw new Error('Нет ИНН');
            const data = await getCompanyByTin(tin);
            result = { success: true, data };
        } else {
            result = { error: `Неизвестный инструмент: ${tool}` };
        }
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Запуск ---
const PORT = process.env.PORT || 8080;
async function start() {
    try {
        const creds = await ensureCredentials();
        global.RS_CREDS = creds;
        app.listen(PORT, () => {
            console.log(`🚀 Сервер на порту ${PORT}, пользователь ${creds.su}`);
        });
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    }
}
start();
