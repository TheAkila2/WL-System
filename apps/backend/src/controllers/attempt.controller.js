import db, { supabase } from '../services/database.js';
import { AppError } from '../middleware/errorHandler.js';

export const getAttempts = async (req, res, next) => {
  try {
    const { sessionId, athleteId, liftType, limit = 50, offset = 0 } = req.query;

    // Use database service with pagination and relations
    const attempts = await db.getAttempts({
      sessionId,
      athleteId,
      liftType,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.status(200).json({
      success: true,
      count: attempts.length,
      data: attempts,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
      }
    });
  } catch (error) {
    next(error);
  }
};

export const createAttempt = async (req, res, next) => {
  try {
    const attempt = await db.createAttempt(req.body);

    // Emit socket event
    req.app.get('io').emit('attempt:created', attempt);

    res.status(201).json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    next(error);
  }
};

export const updateAttempt = async (req, res, next) => {
  try {
    const attempt = await db.updateAttempt(req.params.id, req.body);

    if (!attempt) {
      throw new AppError('Attempt not found', 404);
    }

    // Emit socket event
    req.app.get('io').emit('attempt:updated', attempt);

    res.status(200).json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    next(error);
  }
};

export const validateAttempt = async (req, res, next) => {
  try {
    const { result } = req.body;
    const { referee } = req.query; // 'left', 'center', or 'right'

    if (!referee || !['left', 'center', 'right'].includes(referee)) {
      throw new AppError('Invalid referee position', 400);
    }

    const attempt = await db.recordRefereeDecision(req.params.id, referee, result);

    if (!attempt) {
      throw new AppError('Attempt not found', 404);
    }

    // Emit socket event
    req.app.get('io').emit('attempt:validated', attempt);

    // If this attempt belonged to the athlete currently "called to platform",
    // clear the call so the live display drops back to the scoreboard view.
    if (attempt.session_id && attempt.athlete_id) {
      const { data: clearedSession, error: clearError } = await supabase
        .from('sessions')
        .update({
          current_call_athlete_id: null,
          current_call_lift_type: null,
          current_call_attempt_number: null,
          current_call_weight: null,
          current_call_at: null,
        })
        .eq('id', attempt.session_id)
        .eq('current_call_athlete_id', attempt.athlete_id)
        .select()
        .maybeSingle();

      if (!clearError && clearedSession) {
        req.app.get('io').emit('athlete:call:cleared', { session_id: attempt.session_id });
      }
    }

    res.status(200).json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    next(error);
  }
};
