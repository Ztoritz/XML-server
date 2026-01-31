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

    let archivedOrders = [];

    // Helper: Generate XML for ERP/Vault Simulation
    const generateXmlReport = (order) => {
        const timestamp = new Date().toISOString();
        let xml = `<MeasurementReport timestamp="${timestamp}">
  <RequestId>${order.id}</RequestId>
  <ArticleNumber>${order.articleNumber}</ArticleNumber>
  <DrawingNumber>${order.drawingNumber}</DrawingNumber>
  <Controller>${order.controller || 'Unknown'}</Controller>
  <Results>
`;
        if (order.results) {
            order.results.forEach(r => {
                xml += `    <Parameter id="${r.id}">
      <Description>${r.def?.gdtType || 'DIM'}</Description>
      <Nominal>${r.def?.nominal}</Nominal>
      <Measured>${r.measured}</Measured>
      <Status>${r.status}</Status>
    </Parameter>
`;
            });
        }
        xml += `  </Results>
</MeasurementReport>`;
        return xml;
    };

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);

        // Send current state immediately on connection
        socket.emit('init_state', { activeOrders, archivedOrders });

        // 1. New Order from SYNK
        socket.on('create_order', (orderData) => {
            console.log('Received Order:', orderData.articleNumber);

            const newOrder = {
                ...orderData,
                status: 'PENDING',
                receivedAt: new Date().toISOString()
            };

            // Add to state
            activeOrders.push(newOrder);
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
