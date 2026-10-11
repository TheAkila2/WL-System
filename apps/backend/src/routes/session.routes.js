import express from 'express';
import { body } from 'express-validator';
import {
  getSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  startSession,
  endSession,
  clearSessionAttempts,
  getSessionAthletes,
  callAthleteToStage,
  clearAthleteCall,
  startIntervalTimer,
  stopIntervalTimer,
  startDefaultScreen,
  stopDefaultScreen,
} from '../controllers/session.controller.js';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validator.js';

const router = express.Router();

router.get('/', getSessions);
router.get('/:id', getSession);
router.get('/:id/athletes', getSessionAthletes);

router.post(
  '/',
  protect,
  authorize('admin', 'technical'),
  [
    body('competition_id').optional().isUUID(),
    body('name').trim().notEmpty(),
    body('weight_category').notEmpty(),
    body('gender').isIn(['male', 'female']),
  ],
  validate,
  createSession
);

router.put('/:id', protect, authorize('admin', 'technical'), updateSession);
router.delete('/:id', protect, authorize('admin'), deleteSession);

router.post('/:id/start', protect, authorize('admin', 'technical'), startSession);
router.post('/:id/end', protect, authorize('admin', 'technical'), endSession);
router.delete('/:id/attempts/clear', protect, authorize('admin', 'technical'), clearSessionAttempts);

router.post('/:id/call-athlete', protect, authorize('admin', 'technical'), callAthleteToStage);
router.post('/:id/clear-call', protect, authorize('admin', 'technical'), clearAthleteCall);
router.post('/:id/interval-timer/start', protect, authorize('admin', 'technical'), startIntervalTimer);
router.post('/:id/interval-timer/stop', protect, authorize('admin', 'technical'), stopIntervalTimer);
router.post('/:id/default-screen/start', protect, authorize('admin', 'technical'), startDefaultScreen);
router.post('/:id/default-screen/stop', protect, authorize('admin', 'technical'), stopDefaultScreen);

export default router;
