import express from 'express';
import * as liftingOrderService from '../services/liftingOrder.service.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * @route   GET /api/sessions/:sessionId/lifting-order
 * @desc    Get lifting order for a session
 * @query   liftType - 'snatch' or 'clean_jerk' (default: 'snatch')
 * @access  Private
 */
router.get(
  '/:sessionId/lifting-order',
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { liftType = 'snatch' } = req.query;

      if (!['snatch', 'clean_and_jerk'].includes(liftType)) {
        throw new AppError('Invalid lift type. Must be "snatch" or "clean_and_jerk"', 400);
      }

      const positions = await liftingOrderService.getCurrentLiftingPositions(
        sessionId,
        liftType
      );

      res.json({
        success: true,
        data: positions
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/sessions/:sessionId/lifting-order/full
 * @desc    Get full lifting order list (all athletes)
 * @query   liftType - 'snatch' or 'clean_jerk' (default: 'snatch')
 * @access  Private
 */
router.get(
  '/:sessionId/lifting-order/full',
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { liftType = 'snatch' } = req.query;

      if (!['snatch', 'clean_and_jerk'].includes(liftType)) {
        throw new AppError('Invalid lift type. Must be "snatch" or "clean_and_jerk"', 400);
      }

      const order = await liftingOrderService.calculateLiftingOrder(
        sessionId,
        liftType
      );

      res.json({
        success: true,
        data: order
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/sessions/:sessionId/current-lifter
 * @desc    Check if specific athlete is current lifter
 * @query   athleteId, liftType
 * @access  Private
 */
router.get(
  '/:sessionId/current-lifter',
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { athleteId, liftType = 'snatch' } = req.query;

      if (!athleteId) {
        throw new AppError('athleteId query parameter is required', 400);
      }

      const isCurrent = await liftingOrderService.isAthleteCurrentLifter(
        sessionId,
        athleteId,
        liftType
      );

      res.json({
        success: true,
        data: { isCurrent }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
