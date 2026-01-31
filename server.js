const fastify = require('fastify')({ logger: true });
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

// Enable CORS explicitly
// Enable CORS explicitly - Relaxed for debugging
fastify.register(require('@fastify/cors'), {
    origin: '*', // Allow ALL origins explicitly
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
});

// Ensure storage directory exists
const STORAGE_DIR = path.join(__dirname, 'xml-storage');
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR);
}

// Global In-Memory Store
let activeOrders = [];

// --- OPTIMERAD XML KONFIGURATION ---
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "", // Enklare JSON-struktur
    parseAttributeValue: true,
    trimValues: true
});

const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true
});

// Tillåt XML som body
fastify.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'string' }, (req, body, done) => {
    done(null, body);
});

// Health Check
fastify.get('/', async () => {
    return { service: 'XML Exchange Server', status: 'Healthy', version: '1.0.0' };
});

// --- CORE LOGIC ---

// 1. Processa Mätorder (Vault -> Server -> Mätstation)
fastify.post('/api/parse', async (request, reply) => {
    const startObj = process.hrtime();

    try {
        const xmlData = request.body;
        if (!xmlData) throw new Error('Ingen XML-data mottagen');

        // Snabb parsing till JSON
        const result = parser.parse(xmlData);

        // Store in memory
        // Map XML structure to App expectation if possible, or store raw
        // Expecting XML like: <Order><Id>123</Id><Article>...</Article></Order>
        // Parser with 'ignoreAttributes: false' might put attributes in different places
        // We'll wrap it in a normalized structure
        const timestamp = new Date().toISOString();
        const orderId = result.Id || result.Order?.Id || `REQ-${Date.now()}`;

        const newOrder = {
            id: orderId,
            article: result.Article || result.Order?.Article || "Unknown",
            drawing: result.Drawing || result.Order?.Drawing || "Unknown",
            status: 'WAITING',
            rawData: result,
            receivedAt: timestamp
        };

        activeOrders.push(newOrder);
        console.log("New Order Received:", newOrder);

        // Mät prestanda
        const endObj = process.hrtime(startObj);
        const ms = (endObj[0] * 1000 + endObj[1] / 1e6).toFixed(2);

        return {
            success: true,
            processingTime: `${ms}ms`,
            message: "Order queued",
            orderId: orderId,
            data: result
        };

    } catch (err) {
        request.log.error(err);
        reply.code(400).send({ success: false, error: "XML Parsing Failed: " + err.message });
    }
});

// 1b. Hämta aktiva ordrar (Mätstation -> Server)
fastify.get('/api/orders', async (request, reply) => {
    return activeOrders;
});

// 2. Generera XML (Server -> System)
fastify.post('/api/generate', async (request, reply) => {
    try {
        const jsonData = request.body; // Förväntar sig JSON
        const xml = builder.build(jsonData);

        // Save to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `measurement-${timestamp}.xml`;
        const filepath = path.join(STORAGE_DIR, filename);

        fs.writeFileSync(filepath, xml);
        console.log(`Saved XML to: ${filepath}`);

        reply.type('application/xml');
        return xml;
    } catch (err) {
        reply.code(500).send({ error: "XML Generation Failed" });
    }
});

// Starta servern
const start = async () => {
    try {
        const PORT = process.env.PORT || 3000;
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 XML Server optimerad och körs på port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
