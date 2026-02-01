const express = require('express');
const cors = require('cors');
const http = require('http'); // Required for Socket.io + Express
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// --- EXPRESS SETUP ---
const app = express();
app.use(cors()); // Allow all
app.use(express.json());

// --- HTTP SERVER & SOCKET.IO ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow Mobile & SYNK from anywhere
        methods: ["GET", "POST"]
    }
});

// --- PERSISTENCE LAYER ---
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-Memory State (Loaded from file)
let state = {
    activeOrders: [],
    archivedOrders: []
};

// Load Data
const loadData = () => {
    try {
        if (fs.existsSync(ORDERS_FILE)) {
            const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
            state = JSON.parse(raw);
            console.log(`📦 Loaded ${state.activeOrders.length} active, ${state.archivedOrders.length} archived orders.`);
        } else {
            console.log("🆕 No previous data found. Starting fresh.");
        }
    } catch (err) {
        console.error("❌ Failed to load data:", err);
    }
};

// Save Data (Debounced could be better, but direct is safer for now)
const saveData = () => {
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(state, null, 2));
        console.log("💾 Data Saved.");
    } catch (err) {
        console.error("❌ Failed to save data:", err);
    }
};

// Initial Load
loadData();

// --- SOCKET.IO EVENTS ---
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // 1. Send Full State immediately (Active + History)
    // This fixes "Archive missing in app"
    socket.emit('init_state', state);

    // 2. Handle New Order (From SYNK)
    socket.on('create_order', (order) => {
        console.log(`📝 New Order: ${order.articleNumber}`);

        // Add ID if missing (fail-safe)
        if (!order.id) order.id = `O-${Date.now()}`;

        // Add to Active
        state.activeOrders.unshift(order); // Newest first
        saveData();

        // Broadcast to EVERYONE (Mobile gets it instantly)
        io.emit('order_created', order);
        io.emit('active_orders_update', state.activeOrders); // Force list update
    });

    // 3. Handle Measurement Submission (From Mobile)
    socket.on('submit_measurement', (paymentPayload) => {
        const { id, results, controller } = paymentPayload;
        console.log(`✅ Measurement received for: ${id}`);

        // Find Order
        const orderIndex = state.activeOrders.findIndex(o => o.id === id);
        if (orderIndex === -1) {
            console.error("⚠️ Order not found in active list!");
            return;
        }

        const order = state.activeOrders[orderIndex];

        // Generate Serial Number (M-[Drawing]-[Count])
        const existingCount = state.archivedOrders.filter(o => o.drawingNumber === order.drawingNumber).length;
        const serialNumber = `M-${order.drawingNumber || 'GEN'}-${(existingCount + 1).toString().padStart(3, '0')}`;

        // Move to Archive
        const completedOrder = {
            ...order,
            status: 'COMPLETED',
            completedAt: new Date().toISOString(),
            results: results,
            controller: controller,
            serialNumber: serialNumber // Add Serial
        };

        // Check Status
        const isOk = results.every(r => r.status === 'OK');
        completedOrder.status = isOk ? 'OK' : 'FAIL';

        // Update State
        state.activeOrders.splice(orderIndex, 1);
        state.archivedOrders.unshift(completedOrder);
        saveData();

        // Broadcast Completion
        io.emit('order_completed', completedOrder);
        io.emit('active_orders_update', state.activeOrders);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// --- REST API FALLBACK (Optional, for debugging) ---
app.get('/api/state', (req, res) => {
    res.json(state);
});

// --- START SERVER ---
// Important: Listen on 'server' (HTTP+Socket), not just 'app'
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Real-Time Server running on port ${PORT}`);
    console.log(`📂 Data Persisted in: ${ORDERS_FILE}`);
});
