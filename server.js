const fastify = require('fastify')({ logger: true });
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

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

        // Mät prestanda
        const endObj = process.hrtime(startObj);
        const ms = (endObj[0] * 1000 + endObj[1] / 1e6).toFixed(2);

        return {
            success: true,
            processingTime: `${ms}ms`,
            data: result
        };

    } catch (err) {
        request.log.error(err);
        reply.code(400).send({ success: false, error: "XML Parsing Failed: " + err.message });
    }
});

// 2. Generera XML (Server -> System)
fastify.post('/api/generate', async (request, reply) => {
    try {
        const jsonData = request.body; // Förväntar sig JSON
        const xml = builder.build(jsonData);

        reply.type('application/xml');
        return xml;
    } catch (err) {
        reply.code(500).send({ error: "XML Generation Failed" });
    }
});

// Starta servern
const start = async () => {
    try {
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log(`🚀 XML Server optimerad och körs på port 3000`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
