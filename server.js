const express = require('express');
const cors = require('cors');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const STORAGE_DIR = path.join(__dirname, 'xml-storage');

// Config options
const PARSER_OPTIONS = {
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: true,
    trimValues: true
};

const BUILDER_OPTIONS = {
    ignoreAttributes: false,
    format: true
};

// --- MIDDLEWARE ---

// 1. Logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// 2. CORS (Allow All)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// 3. XML Body Parser
// Express doesn't parse XML body by default, we read it as string
app.use(express.text({ type: ['text/xml', 'application/xml'], limit: '10mb' }));
// Also parse JSON for generation endpoint
app.use(express.json());

// --- STORAGE ---
if (!fs.existsSync(STORAGE_DIR)) {
    try {
        fs.mkdirSync(STORAGE_DIR);
    } catch (err) {
        console.error("Failed to create storage dir:", err);
    }
}

// In-Memory Store
let activeOrders = [];

// --- ROUTES ---

// Health Check
app.get('/', (req, res) => {
    res.json({ service: 'XML Exchange Server', status: 'Healthy', version: '2.0.0 (Express)' });
});

// 1. Process Order (Receive XML)
app.post('/api/parse', (req, res) => {
    const start = process.hrtime();

    try {
        const xmlData = req.body;
        if (!xmlData || typeof xmlData !== 'string') {
            return res.status(400).json({ success: false, error: "No XML body received" });
        }

        const parser = new XMLParser(PARSER_OPTIONS);
        const result = parser.parse(xmlData);

        // Normalized Order Structure
        const timestamp = new Date().toISOString();
        // Handle various potential XML structures (nested or flat)
        const orderId = result.Id || result.Order?.Id || result.order?.id || `REQ-${Date.now()}`;

        const newOrder = {
            id: String(orderId),
            article: result.Article || result.Order?.Article || result.order?.article || "Unknown",
            drawing: result.Drawing || result.Order?.Drawing || result.order?.drawing || "Unknown",
            status: 'WAITING',
            rawData: result,
            receivedAt: timestamp
        };

        activeOrders.push(newOrder);
        console.log("New Order Queued:", newOrder.id);

        const end = process.hrtime(start);
        const ms = (end[0] * 1000 + end[1] / 1e6).toFixed(2);

        res.json({
            success: true,
            processingTime: `${ms}ms`,
            message: "Order queued",
            orderId: orderId,
            data: result
        });

    } catch (err) {
        console.error("XML Parse Error:", err);
        res.status(400).json({ success: false, error: "XML Parsing Failed: " + err.message });
    }
});

// 1b. Get Orders
app.get('/api/orders', (req, res) => {
    res.json(activeOrders);
});

// 2. Generate XML
app.post('/api/generate', (req, res) => {
    try {
        const jsonData = req.body;
        const builder = new XMLBuilder(BUILDER_OPTIONS);
        const xml = builder.build(jsonData);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `measurement-${timestamp}.xml`;

        // Try saving, but don't fail request if FS fails (e.g. permission issues)
        try {
            const filepath = path.join(STORAGE_DIR, filename);
            fs.writeFileSync(filepath, xml);
            console.log(`Saved XML to: ${filepath}`);
        } catch (fsErr) {
            console.error("Failed to save XML file (Permissions?):", fsErr.message);
        }

        res.type('application/xml').send(xml);
    } catch (err) {
        console.error("XML Gen Error:", err);
        res.status(500).json({ error: "XML Generation Failed" });
    }
});

// Error Handling
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
});

// --- SERVER START ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 XML Server (Express) running on port ${PORT}`);
    console.log(`📂 Storage: ${STORAGE_DIR}`);
});
