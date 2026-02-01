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
    archivedOrders: [],
    operators: ['Niklas Jalvemyr', 'Olle Ljungberg'] // Default
};

// Load Data
// Load Data with Cleanup
const loadData = () => {
    try {
        if (fs.existsSync(ORDERS_FILE)) {
            const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
            state = JSON.parse(raw);

            // CLEANUP: Remove duplicates
            const uniqueActive = [];
            const activeIds = new Set();
            for (const o of state.activeOrders) {
                if (!activeIds.has(o.id)) {
                    activeIds.add(o.id);
                    uniqueActive.push(o);
                }
            }

            const uniqueArchive = [];
            const archiveIds = new Set();
            for (const o of state.archivedOrders) {
                if (!archiveIds.has(o.id)) {
                    archiveIds.add(o.id);
                    uniqueArchive.push(o);
                }
            }

            // CONFLICT RESOLUTION: Archive wins over Active
            state.activeOrders = uniqueActive.filter(o => !archiveIds.has(o.id));
            state.archivedOrders = uniqueArchive;

            // Ensure operators exist
            if (!state.operators || !Array.isArray(state.operators)) {
                state.operators = ['Niklas Jalvemyr', 'Olle Ljungberg'];
            }

            // Save clean state immediately if changed
            if (
                state.activeOrders.length !== uniqueActive.length ||
                state.archivedOrders.length !== uniqueArchive.length
            ) {
                console.log("🧹 Cleaned up duplicates/conflicts in orders.json");
                saveData();
            }

            console.log(`📦 Loaded ${state.activeOrders.length} active, ${state.archivedOrders.length} archived orders, ${state.operators.length} operators.`);
        } else {
            console.log("🆕 No previous data found. Starting fresh.");
        }
    } catch (err) {
        console.error("❌ Failed to load data:", err);
        // Fallback to empty
        state = { activeOrders: [], archivedOrders: [], operators: ['Niklas Jalvemyr', 'Olle Ljungberg'] };
    }
};

// Save Data (Direct write for safety)
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
    socket.emit('init_state', state);

    // 2. Handle New Order (From SYNK)
    socket.on('create_order', (order) => {
        console.log(`📝 New Order: ${order.articleNumber}`);

        // Add ID if missing (fail-safe)
        if (!order.id) order.id = `O-${Date.now()}`;

        // Deduplicate: Check Active AND Archive
        const existsActive = state.activeOrders.some(o => o.id === order.id);
        const existsArchive = state.archivedOrders.some(o => o.id === order.id);

        if (existsActive || existsArchive) {
            console.warn(`⚠️ Duplicate Order ID blocked: ${order.id}`);
            return;
        }

        // Add to Active
        state.activeOrders.unshift(order); // Newest first
        saveData();

        // Broadcast to EVERYONE (Mobile gets it instantly)
        io.emit('order_created', order);
        io.emit('active_orders_update', state.activeOrders);
    });

    // 3. Handle Measurement Submission (From Mobile)
    socket.on('submit_measurement', (paymentPayload) => {
        const { id, results, controller, xml } = paymentPayload; // Extract XML
        console.log(`✅ Measurement received for: ${id}`);

        // Find Order
        const orderIndex = state.activeOrders.findIndex(o => o.id === id);
        if (orderIndex === -1) {
            console.error("⚠️ Order not found in active list!");
            return;
        }

        const order = state.activeOrders[orderIndex];

        // Generate Serial Number (M-[Drawing]-[Count])
        // Count existing APPROVED/COMPLETED in archive for this drawing
        const existingCount = state.archivedOrders.filter(o => o.drawingNumber === order.drawingNumber).length;
        const serialNumber = `M-${order.drawingNumber || 'GEN'}-${(existingCount + 1).toString().padStart(3, '0')}`;

        // Move to Archive
        const completedOrder = {
            ...order,
            status: 'COMPLETED',
            completedAt: new Date().toISOString(),
            results: results,
            controller: controller,
            serialNumber: serialNumber,
            xml: xml // Persist XML for report card fallback
        };

        // Check Status (Generic OK/FAIL check)
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

    // 4. Handle Reset (Clear all orders)
    socket.on('reset_state', () => {
        console.log("⚠️ RESET command received. Clearing all orders.");
        state.activeOrders = [];
        state.archivedOrders = [];
        saveData();
        io.emit('init_state', state); // Broadcast empty state to all clients
    });

    socket.on('disconnect', () => {
        // console.log(`🔌 Client disconnected: ${socket.id}`);
    });

    // 5. Handle Operator Updates (Centralized List)
    socket.on('update_operators', (newOperatorList) => {
        console.log(`busts Updating Operator List: ${newOperatorList.length} operators`);
        state.operators = newOperatorList;
        saveData();
        io.emit('operators_updated', state.operators); // Broadcast new list to all (Desktop & Mobile)
    });
});

// --- SERVER START ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 JSON Server running on port ${PORT}`);
    console.log(`📂 Persistence: ${ORDERS_FILE}`);
});
