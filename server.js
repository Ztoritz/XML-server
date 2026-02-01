const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const DATABASE_URL = process.env.DATABASE_URL;

// --- DATABASE SETUP (PostgreSQL) ---
let pool = null;
let useDb = false;

if (DATABASE_URL) {
    console.log("🐘 Database URL found. Connecting to PostgreSQL...");
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false } // Required for many hosted PG (like Coolify/Render)
    });
    useDb = true;
} else {
    console.log("📂 No DATABASE_URL. Using local JSON file storage.");
}

// --- EXPRESS SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// --- HTTP SERVER & SOCKET.IO ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- PERSISTENCE HELPERS ---

// Init DB
const initDb = async () => {
    if (!useDb) {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        return;
    }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                status TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            );
        `);
        console.log("✅ Database Table 'orders' ready.");
    } catch (err) {
        console.error("❌ DB Init Failed:", err);
        useDb = false; // Fallback
    }
};

// Fetch All State
const getState = async () => {
    if (useDb) {
        try {
            const res = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
            const all = res.rows.map(row => row.data);
            return {
                activeOrders: all.filter(o => o.status !== 'COMPLETED' && o.status !== 'OK' && o.status !== 'FAIL'),
                archivedOrders: all.filter(o => o.status === 'COMPLETED' || o.status === 'OK' || o.status === 'FAIL')
            };
        } catch (err) {
            console.error("DB Read Error:", err);
            return { activeOrders: [], archivedOrders: [] };
        }
    } else {
        // File Fallback
        try {
            if (fs.existsSync(ORDERS_FILE)) {
                return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
            }
        } catch (e) {
            // File might not exist yet
        }
        return { activeOrders: [], archivedOrders: [] };
    }
};

// Save Order (Insert/Update)
const saveOrder = async (order) => {
    if (useDb) {
        try {
            await pool.query(`
                INSERT INTO orders (id, data, status, completed_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO UPDATE 
                SET data = $2, status = $3, completed_at = $4
            `, [
                order.id,
                order,
                order.status,
                order.completedAt || null
            ]);
        } catch (err) { console.error("DB Write Error:", err); }
    } else {
        // File Fallback (Full Rewrite)
        const state = await getState(); // This is inefficient for file but safe
        // Update in memory lists (simplified for file logic)
        const isArchive = ['OK', 'FAIL', 'COMPLETED'].includes(order.status);

        // Remove existing
        state.activeOrders = state.activeOrders.filter(o => o.id !== order.id);
        state.archivedOrders = state.archivedOrders.filter(o => o.id !== order.id);

        if (isArchive) state.archivedOrders.unshift(order);
        else state.activeOrders.unshift(order);

        try {
            fs.writeFileSync(ORDERS_FILE, JSON.stringify(state, null, 2));
        } catch (e) { console.error("File Write Error", e); }
    }
};


// --- INITIALIZATION ---
initDb();

// --- SOCKET.IO EVENTS ---
io.on('connection', async (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Send State ASAP
    setTimeout(async () => {
        const currentState = await getState();
        socket.emit('init_state', currentState);
    }, 100);

    // 1. New Order
    socket.on('create_order', async (order) => {
        console.log(`📝 New Order: ${order.articleNumber}`);
        if (!order.id) order.id = `O-${Date.now()}`;

        // Save
        await saveOrder(order);

        // Broadcast
        io.emit('order_created', order);

        // Refresh Lists
        const newState = await getState();
        io.emit('active_orders_update', newState.activeOrders);
    });

    // 2. Submit Measurement
    socket.on('submit_measurement', async (payload) => {
        const { id, results, controller } = payload;
        console.log(`✅ Measurement for: ${id}`);

        // Get Current Order Data
        let order = null;
        if (useDb) {
            const res = await pool.query('SELECT data FROM orders WHERE id = $1', [id]);
            order = res.rows[0]?.data;
        } else {
            const s = await getState();
            order = s.activeOrders.find(o => o.id === id);
        }

        if (!order) {
            console.error("Order not found!");
            return;
        }

        // Generate Serial
        // Count archives with same drawing number for serial
        let existingCount = 0;
        if (useDb) {
            const res = await pool.query(`
                SELECT COUNT(*) FROM orders 
                WHERE data->>'drawingNumber' = $1 
                AND (status = 'OK' OR status = 'FAIL' OR status = 'COMPLETED')
             `, [order.drawingNumber]);
            existingCount = parseInt(res.rows[0].count);
        } else {
            const s = await getState();
            existingCount = s.archivedOrders.filter(o => o.drawingNumber === order.drawingNumber).length;
        }

        const serialNumber = `M-${order.drawingNumber || 'GEN'}-${(existingCount + 1).toString().padStart(3, '0')}`;

        // Create Completed Object
        const completedOrder = {
            ...order,
            status: results.every(r => r.status === 'OK') ? 'OK' : 'FAIL',
            completedAt: new Date().toISOString(),
            results,
            controller,
            serialNumber
        };

        // Save
        await saveOrder(completedOrder);

        // Broadcast
        io.emit('order_completed', completedOrder);

        const newState = await getState();
        io.emit('active_orders_update', newState.activeOrders);
    });

    socket.on('disconnect', () => {
        // console.log('Client disconnected', socket.id);
    });
});

// --- REST API (Optional) ---
app.get('/', (req, res) => res.send('XML/Socket Server Running'));

// --- START SERVER ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    if (useDb) console.log("💾 Storage: PostgreSQL");
    else console.log(`📂 Storage: Local File (${ORDERS_FILE})`);
});
