import express from 'express';
import { body, param } from 'express-validator';
import {
  getCurrentCompetition,
  updateCurrentCompetition,
  initializeCompetition,
  deleteCompetition,
  setActiveSession,
} from '../controllers/competition.controller.js';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validator.js';

const router = express.Router();

/**
 * SINGLE COMPETITION ROUTES
 * The system manages only one competition at a time
 */

// Get current competition (public)
router.get('/current', getCurrentCompetition);

// Update current competition (admin/technical only)
router.put(
  '/current',
  protect,
  authorize('admin', 'technical'),
  [
    body('name').optional().trim().notEmpty(),
    body('date').optional().custom((value) => {
      if (!value) return true; // Allow empty/undefined for optional fields
      // Accept both ISO8601 and YYYY-MM-DD formats
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}(T|$)/;
      if (!iso8601Regex.test(value)) {
        throw new Error('Date must be in YYYY-MM-DD or ISO8601 format');
      }
      return true;
    }),
    body('location').optional().trim().notEmpty(),
  ],
  validate,
  updateCurrentCompetition
);

// Set which session the venue display screens currently follow
router.post(
  '/current/active-session',
  protect,
  authorize('admin', 'technical'),
  [body('sessionId').isUUID()],
  validate,
  setActiveSession
);

// Initialize competition (admin only - one-time setup)
router.post(
  '/initialize',
  protect,
  authorize('admin'),
  [
    body('name').trim().notEmpty(),
    body('date').custom((value) => {
      if (!value) throw new Error('Date is required');
      // Accept both ISO8601 and YYYY-MM-DD formats
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}(T|$)/;
      if (!iso8601Regex.test(value)) {
        throw new Error('Date must be in YYYY-MM-DD or ISO8601 format');
      }
      return true;
    }),
    body('location').trim().notEmpty(),
  ],
  validate,
  initializeCompetition
);

// Delete competition (admin only - deletes all associated data)
router.delete(
  '/:competitionId',
  protect,
  authorize('admin'),
  [param('competitionId').isUUID()],
  validate,
  deleteCompetition
);

export default router;
