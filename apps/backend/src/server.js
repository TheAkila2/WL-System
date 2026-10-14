import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { errorHandler } from './middleware/errorHandler.js';
import { setupMiddleware } from './middleware/index.js';
import { setupRoutes } from './routes/index.js';
import { setupSocketIO } from './socket/index.js';
import logger from './utils/logger.js';
import seedDefaultUsers from './utils/seedUsers.js';
import initializeStorageBuckets from './services/storageSetup.js';

dotenv.config();

// Safety net for live competition use: a single unexpected rejection in a
// fire-and-forget realtime handler (e.g. a transient network blip talking to
// Supabase) must never take down the whole server mid-event. Log and keep
// running instead of crashing — a stuck screen is recoverable, a dead
// process serving every connected display is not.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (server stays up):', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (server stays up):', err);
});

const app = express();
const httpServer = createServer(app);

// Add root route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Admin Backend is running', version: '1.0.0' });
});

// Setup allowed origins for Socket.IO
const allowedOrigins = process.env.SOCKET_IO_CORS_ORIGIN?.split(',') || ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];

const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      // Allow requests with no origin
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes('*') || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 5000;

// Configure HTTP server timeouts for file uploads
// Increased significantly to handle slow connections
httpServer.setTimeout(30 * 60 * 1000); // 30 minutes
httpServer.keepAliveTimeout = 31 * 60 * 1000; // 31 minutes
httpServer.headersTimeout = 32 * 60 * 1000; // 32 minutes

// Supabase is initialized in services/database.js - no need to connect here
logger.info('📊 Using Supabase PostgreSQL database');
logger.info('⏱️  Server timeout: 30 minutes for uploads');

// Setup middleware
try {
  setupMiddleware(app);
} catch (err) {
  logger.error('Failed to setup middleware:', err);
}

// Make io accessible to routes
app.set('io', io);

// Setup routes
try {
  setupRoutes(app);
} catch (err) {
  logger.error('Failed to setup routes:', err);
  // Add fallback health route for Vercel
  app.get('/health', (req, res) => {
    res.json({ ok: true, now: Date.now() });
  });
}

// Setup Socket.IO
try {
  setupSocketIO(io);
} catch (err) {
  logger.error('Failed to setup Socket.IO:', err);
}

// Error handler (must be last)
app.use(errorHandler);

// Start server (only in local/development, not on Vercel)
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV === 'production';

if (!isVercel && process.env.NODE_ENV !== 'production') {
  httpServer.listen(PORT, async () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📡 Socket.IO server ready`);
    logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Initialize storage buckets
    try {
      await initializeStorageBuckets();
    } catch (error) {
      logger.error('Failed to initialize storage buckets:', error);
    }
    
    // Seed default users on startup (development only)
    if (process.env.NODE_ENV !== 'production') {
      seedDefaultUsers().catch(err => logger.error('Seed failed:', err));
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server gracefully');
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  });
} else {
  // Vercel serverless - initialize storage and seed on cold start
  logger.info('🚀 Running on Vercel (serverless)');
  initializeStorageBuckets().catch(err => logger.error('Storage init failed:', err));
}

export default app;
export { app, httpServer, io };
