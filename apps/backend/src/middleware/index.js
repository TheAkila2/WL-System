import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import logger from '../utils/logger.js';

export const setupMiddleware = (app) => {
  // Security headers
  app.use(helmet());

  // CORS
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || ['*'];
  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes('*') || allowedOrigins.indexOf(origin) !== -1) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    })
  );

  // Body parsing with increased limits for uploads
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Compression
  app.use(compression());

  // HTTP request logging
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  } else {
    app.use(
      morgan('combined', {
        stream: { write: (message) => logger.info(message.trim()) },
      })
    );
  }

  // Rate limiting. The Technical Panel, Scoreboard, and Intro screens all
  // poll every few seconds simultaneously during a live competition (session
  // sheet, call clock, interval timer, active-session follow, etc.), which
  // adds up to well over 1000 requests per 15 minutes from a single machine
  // under completely normal use — that's not abuse, it's the app working.
  // A tripped limiter here fails silently (no error log, since express-rate-
  // limit responds before reaching our error handler) and looks like random
  // "call athlete failed" / "weight update didn't save" bugs mid-event.
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 1000, // per IP, per minute — generous since this is an internal LAN tool, not public-facing
    message: 'Too many requests from this IP, please try again later.',
    skip: (req) => {
      // Skip rate limit for uploads and health checks
      // Check both originalUrl (full path) and path (route path)
      const fullUrl = req.originalUrl || '';
      const path = req.path || '';
      return fullUrl.includes('/uploads') || path.includes('/uploads') || path === '/health';
    },
    standardHeaders: false, // Don't return rate limit info in headers
    legacyHeaders: false, // Don't return RateLimit-* headers
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded: ${req.method} ${req.originalUrl}`);
      res.status(429).json({ success: false, error: { message: 'Too many requests from this IP, please try again later.' } });
    },
  });
  app.use('/api/', limiter);

  // Health check
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
};
