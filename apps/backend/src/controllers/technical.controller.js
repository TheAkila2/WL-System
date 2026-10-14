import db from '../services/database.js';
import { AppError } from '../middleware/errorHandler.js';
import timerService from '../services/timerService.js';
import {
  syncCompetitionStatusBySession,
  syncLiveStateFromSession,
  syncLiveResult,
  syncAthleteStatus,
} from '../services/liftingSocialSync.service.js';

// Get session sheet with athletes and their attempts
// Auto-creates first attempts from opening declarations if they don't exist
export const getSessionSheet = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    // Get all athletes in the session
    const { data: athletes, error: athletesError } = await db.supabase
      .from('athletes')
      .select('*, team:teams(*)')
      .eq('session_id', sessionId)
      .order('start_number', { ascending: true });

    if (athletesError) throw new AppError(athletesError.message, 400);

    // Fetch every attempt for the whole session in one query instead of two
    // queries per athlete (snatch + clean & jerk) — the previous N+1 pattern
    // meant a 20-athlete sheet fired 40+ queries on every 3s poll, which is
    // what caused response times to balloon over the course of a long event.
    const { data: allAttempts, error: attemptsError } = await db.supabase
      .from('attempts')
      .select('*')
      .eq('session_id', sessionId)
      .order('attempt_number', { ascending: true });

    if (attemptsError) throw new AppError(attemptsError.message, 400);

    const attemptsByAthlete = new Map();
    for (const attempt of allAttempts || []) {
      if (!attemptsByAthlete.has(attempt.athlete_id)) {
        attemptsByAthlete.set(attempt.athlete_id, { snatch: [], clean_jerk: [] });
      }
      const bucket = attemptsByAthlete.get(attempt.athlete_id);
      if (attempt.lift_type === 'snatch') bucket.snatch.push(attempt);
      else if (attempt.lift_type === 'clean_and_jerk') bucket.clean_jerk.push(attempt);
    }

    // For each athlete, get their snatch and clean_and_jerk attempts
    // Also auto-create first attempts from opening declarations
    const athletesWithAttempts = await Promise.all(
      athletes.map(async (athlete) => {
        const bucket = attemptsByAthlete.get(athlete.id) || { snatch: [], clean_jerk: [] };
        let finalSnatchAttempts = bucket.snatch;
        let finalCleanJerkAttempts = bucket.clean_jerk;

        // Auto-create first snatch attempt from opening_snatch if it doesn't exist and opening_snatch is set
        if (
          athlete.opening_snatch &&
          !finalSnatchAttempts.some(a => a.attempt_number === 1)
        ) {
          const { data: newAttempt, error: createError } = await db.supabase
            .from('attempts')
            .insert({
              athlete_id: athlete.id,
              session_id: sessionId,
              lift_type: 'snatch',
              attempt_number: 1,
              weight: athlete.opening_snatch,
              result: 'pending',
            })
            .select()
            .single();

          if (createError) {
            console.warn(`⚠️ Failed to auto-create snatch attempt for athlete ${athlete.id}:`, createError.message);
          } else {
            console.log(`✅ Auto-created snatch 1st attempt for athlete ${athlete.id}: ${athlete.opening_snatch}kg`);
            finalSnatchAttempts = [newAttempt, ...finalSnatchAttempts];
          }
        }

        // Auto-create first clean & jerk attempt from opening_clean_jerk if it doesn't exist and opening_clean_jerk is set
        if (
          athlete.opening_clean_jerk &&
          !finalCleanJerkAttempts.some(a => a.attempt_number === 1)
        ) {
          const { data: newAttempt, error: createError } = await db.supabase
            .from('attempts')
            .insert({
              athlete_id: athlete.id,
              session_id: sessionId,
              lift_type: 'clean_and_jerk',
              attempt_number: 1,
              weight: athlete.opening_clean_jerk,
              result: 'pending',
            })
            .select()
            .single();

          if (createError) {
            console.warn(`⚠️ Failed to auto-create clean & jerk attempt for athlete ${athlete.id}:`, createError.message);
          } else {
            console.log(`✅ Auto-created clean & jerk 1st attempt for athlete ${athlete.id}: ${athlete.opening_clean_jerk}kg`);
            finalCleanJerkAttempts = [newAttempt, ...finalCleanJerkAttempts];
          }
        }

        return {
          ...athlete,
          snatch_attempts: finalSnatchAttempts,
          clean_jerk_attempts: finalCleanJerkAttempts,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: athletesWithAttempts,
    });
  } catch (error) {
    next(error);
  }
};

// Get all active sessions
export const getActiveSessions = async (req, res, next) => {
  try {
    const { data, error } = await db.supabase
      .from('sessions')
      .select('*, competition:competitions(*)')
      .in('status', ['scheduled', 'in-progress'])
      .order('start_time', { ascending: true });

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
};

// Get lifting order for a session
export const getLiftingOrder = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { liftType } = req.query; // snatch or clean_and_jerk

    console.log('📋 getLiftingOrder called:', { sessionId, liftType });

    const { data, error } = await db.supabase.rpc('get_lifting_order', {
      p_session_id: sessionId,
    });

    if (error) {
      console.error('❌ Error calling get_lifting_order RPC:', error);
      throw new AppError(error.message, 400);
    }

    console.log('📊 Lifting order data received:', data?.length, 'athletes');

    // Filter by lift type if specified
    let filteredData = data || [];
    if (liftType) {
      filteredData = filteredData.filter(athlete => {
        if (liftType === 'snatch') {
          return !athlete.best_clean_and_jerk || athlete.best_snatch === 0;
        } else if (liftType === 'clean_and_jerk') {
          return athlete.best_snatch > 0;
        }
        return true;
      });
    }

    console.log('✅ Filtered lifting order:', filteredData.length, 'athletes');

    res.status(200).json({
      success: true,
      data: filteredData,
    });
  } catch (error) {
    console.error('🔴 getLiftingOrder error:', error.message);
    next(error);
  }
};

// Declare an attempt for an athlete
export const declareAttempt = async (req, res, next) => {
  try {
    const { athleteId, weight, liftType } = req.body;

    if (!athleteId || !weight) {
      throw new AppError('Athlete ID and weight are required', 400);
    }

    // Determine lift type if not provided
    let determinedLiftType = liftType || 'snatch';

    // Get athlete's previous attempts to determine attempt number
    const { data: previousAttempts, error: attemptsError } = await db.supabase
      .from('attempts')
      .select('attempt_number')
      .eq('athlete_id', athleteId)
      .eq('lift_type', determinedLiftType)
      .order('attempt_number', { ascending: false })
      .limit(1);

    if (attemptsError) throw new AppError(attemptsError.message, 400);

    const attemptNumber = previousAttempts && previousAttempts.length > 0 
      ? previousAttempts[0].attempt_number + 1 
      : 1;

    // Use the stored procedure to create attempt
    const { data: attemptId, error: rpcError } = await db.supabase.rpc(
      'declare_attempt',
      {
        p_athlete_id: athleteId,
        p_weight: weight,
        p_lift_type: determinedLiftType,
      }
    );

    if (rpcError) throw new AppError(rpcError.message, 400);

    // Get the full attempt details
    const { data: attempt, error } = await db.supabase
      .from('attempts')
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .eq('id', attemptId)
      .single();

    if (error) throw new AppError(error.message, 400);

    // Auto-start timer based on IWF rules
    const io = req.app.get('io');
    const sessionId = attempt.session_id;
    
    // Check if this is a consecutive attempt by the same athlete (IWF Rule 6.6.4)
    const { data: lastAttempt } = await db.supabase
      .from('attempts')
      .select('athlete_id')
      .eq('session_id', sessionId)
      .eq('lift_type', determinedLiftType)
      .neq('result', 'pending')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();
    
    const isConsecutiveAttempt = lastAttempt && lastAttempt.athlete_id === athleteId;
    
    // Determine timer duration:
    // - First attempt: 60 seconds (IWF Rule 6.6.3)
    // - Consecutive attempt: 120 seconds (IWF Rule 6.6.4 - Two-Minute Rule)
    // - Subsequent attempt (different athlete): 60 seconds
    let timerDuration = 60;
    let timerReason = 'First attempt';
    
    if (attemptNumber === 1) {
      timerDuration = 60;
      timerReason = 'First attempt';
    } else if (isConsecutiveAttempt) {
      timerDuration = 120;
      timerReason = 'Consecutive attempt (Two-Minute Rule)';
    } else {
      timerDuration = 60;
      timerReason = 'Subsequent attempt';
    }
    
    const presetName = timerDuration === 60 ? 'FIRST_ATTEMPT' : 'SUBSEQUENT_ATTEMPT';
    
    try {
      // Set the timer to the appropriate preset and start it
      timerService.setPreset(sessionId, io, presetName);
      timerService.startTimer(sessionId, io, timerDuration, 'attempt');
      
      // Emit timer auto-start notification
      io.to(`session:${sessionId}`).emit('timer:autoStarted', {
        sessionId,
        athleteName: attempt.athlete?.name,
        attemptNumber,
        duration: timerDuration,
        liftType: determinedLiftType,
        isConsecutive: isConsecutiveAttempt,
        reason: timerReason,
      });
    } catch (timerError) {
      console.error('Failed to auto-start timer:', timerError);
      // Don't fail the attempt declaration if timer fails
    }

    // Emit socket event
    io.emit('attempt:created', attempt);

    // Sync current live state to website (best-effort)
    syncLiveStateFromSession(sessionId, {
      running: true,
      remaining: timerDuration,
    });

    res.status(201).json({
      success: true,
      data: attempt,
      message: `Timer auto-started: ${timerDuration} seconds`,
    });
  } catch (error) {
    next(error);
  }
};

// Record referee decision
export const recordRefereeDecision = async (req, res, next) => {
  try {
    const { attemptId } = req.params;
    const { position, decision } = req.body;

    if (!position || !decision) {
      throw new AppError('Position and decision are required', 400);
    }

    if (!['left', 'center', 'right'].includes(position)) {
      throw new AppError('Position must be left, center, or right', 400);
    }

    if (!['good', 'no-lift'].includes(decision)) {
      throw new AppError('Decision must be good or no-lift', 400);
    }

    // Update the referee decision
    const field = `referee_${position}`;
    const { data: attempt, error } = await db.supabase
      .from('attempts')
      .update({ [field]: decision })
      .eq('id', attemptId)
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .single();

    if (error) throw new AppError(error.message, 400);

    // Check for three-attempt failure auto-DQ (IWF Rule 6.5.5)
    // Only check when result is finalized (not pending)
    if (attempt.result === 'no-lift') {
      const { data: allAttempts } = await db.supabase
        .from('attempts')
        .select('result')
        .eq('athlete_id', attempt.athlete_id)
        .eq('lift_type', attempt.lift_type)
        .neq('result', 'pending');
      
      // If all 3 attempts for this lift are no-lift, auto-DQ
      if (allAttempts && allAttempts.length === 3) {
        const allFailed = allAttempts.every(a => a.result === 'no-lift');
        
        if (allFailed) {
          // Auto-disqualify athlete
          const { data: updatedAthlete } = await db.supabase
            .from('athletes')
            .update({ is_dq: true })
            .eq('id', attempt.athlete_id)
            .select('*')
            .single();

          if (updatedAthlete) {
            syncAthleteStatus(updatedAthlete).catch((syncError) => {
              console.warn('Failed to sync auto-DQ athlete status:', syncError?.message || syncError);
            });
          }
          
          // Emit DQ notification
          req.app.get('io').emit('athlete:disqualified', {
            athleteId: attempt.athlete_id,
            athleteName: attempt.athlete?.name,
            reason: 'Three failed attempts in ' + (attempt.lift_type === 'snatch' ? 'Snatch' : 'Clean & Jerk'),
            liftType: attempt.lift_type,
            sessionId: attempt.session_id,
          });
        }
      }
    }

    // Emit socket event
    req.app.get('io').emit('attempt:updated', attempt);

    // If result is finalized, emit additional event
    if (attempt.result !== 'pending') {
      req.app.get('io').emit('attempt:validated', attempt);
      syncLiveResult(attempt);
    }

    res.status(200).json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    next(error);
  }
};

// Quick decision - automatically record all 3 referee decisions
export const recordQuickDecision = async (req, res, next) => {
  try {
    const { attemptId } = req.params;
    const { decision } = req.body;

    if (!decision) {
      throw new AppError('Decision is required', 400);
    }

    if (!['good', 'no-lift'].includes(decision)) {
      throw new AppError('Decision must be good or no-lift', 400);
    }

    // Record all 3 referee decisions at once
    const { data: attempt, error } = await db.supabase
      .from('attempts')
      .update({
        referee_left: decision,
        referee_center: decision,
        referee_right: decision,
      })
      .eq('id', attemptId)
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .single();

    if (error) throw new AppError(error.message, 400);

    // Check for three-attempt failure auto-DQ (IWF Rule 6.5.5)
    if (decision === 'no-lift') {
      const { data: allAttempts } = await db.supabase
        .from('attempts')
        .select('result')
        .eq('athlete_id', attempt.athlete_id)
        .eq('lift_type', attempt.lift_type)
        .neq('result', 'pending');
      
      // If all 3 attempts for this lift are no-lift, auto-DQ
      if (allAttempts && allAttempts.length === 3) {
        const allFailed = allAttempts.every(a => a.result === 'no-lift');
        
        if (allFailed) {
          // Auto-disqualify athlete
          const { data: updatedAthlete } = await db.supabase
            .from('athletes')
            .update({ is_dq: true })
            .eq('id', attempt.athlete_id)
            .select('*')
            .single();

          if (updatedAthlete) {
            syncAthleteStatus(updatedAthlete).catch((syncError) => {
              console.warn('Failed to sync auto-DQ athlete status:', syncError?.message || syncError);
            });
          }
          
          // Emit DQ notification
          req.app.get('io').emit('athlete:disqualified', {
            athleteId: attempt.athlete_id,
            athleteName: attempt.athlete?.name,
            reason: 'Three failed attempts in ' + (attempt.lift_type === 'snatch' ? 'Snatch' : 'Clean & Jerk'),
            liftType: attempt.lift_type,
            sessionId: attempt.session_id,
          });
        }
      }
    }

    // Emit socket events
    req.app.get('io').emit('attempt:updated', attempt);
    req.app.get('io').emit('attempt:validated', attempt);
    syncLiveResult(attempt);

    res.status(200).json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    next(error);
  }
};

// Jury override - Override referee decision (IWF Rule 3.3.5)
export const recordJuryOverride = async (req, res, next) => {
  try {
    const { attemptId } = req.params;
    const { decision, reason } = req.body;

    if (!decision) {
      throw new AppError('Decision is required', 400);
    }

    if (!['good', 'no-lift'].includes(decision)) {
      throw new AppError('Decision must be good or no-lift', 400);
    }

    if (!reason || reason.trim().length === 0) {
      throw new AppError('Reason for jury override is required', 400);
    }

    // Record jury override
    const { data: attempt, error } = await db.supabase
      .from('attempts')
      .update({
        jury_override: true,
        jury_decision: decision,
        jury_reason: reason.trim(),
        jury_timestamp: new Date().toISOString(),
        result: decision, // Override the referee result
      })
      .eq('id', attemptId)
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .single();

    if (error) throw new AppError(error.message, 400);

    // Emit socket events
    const io = req.app.get('io');
    io.to(`session:${attempt.session_id}`).emit('jury:override', {
      attemptId: attempt.id,
      athleteName: attempt.athlete?.name,
      originalResult: attempt.referee_left && attempt.referee_center && attempt.referee_right
        ? (([attempt.referee_left, attempt.referee_center, attempt.referee_right].filter(d => d === 'good').length >= 2) ? 'good' : 'no-lift')
        : 'pending',
      juryDecision: decision,
      reason: reason.trim(),
      timestamp: attempt.jury_timestamp,
    });
    
    io.to(`session:${attempt.session_id}`).emit('attempt:validated', attempt);
    syncLiveResult(attempt);

    res.status(200).json({
      success: true,
      data: attempt,
      message: `Jury override recorded: ${decision}`,
    });
  } catch (error) {
    next(error);
  }
};

// Get current attempt in progress
export const getCurrentAttempt = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { liftType } = req.query; // snatch or clean_and_jerk

    let query = db.supabase
      .from('attempts')
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .eq('session_id', sessionId)
      .eq('result', 'pending');

    // Filter by lift type if specified
    if (liftType) {
      query = query.eq('lift_type', liftType);
    }

    const { data, error } = await query
      .order('timestamp', { ascending: false })
      .limit(1);

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      data: data[0] || null,
    });
  } catch (error) {
    next(error);
  }
};

// Get session leaderboard
export const getSessionLeaderboard = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const { data, error } = await db.supabase
      .from('leaderboard')
      .select('*')
      .eq('session_id', sessionId)
      .order('rank', { ascending: true });

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      data: data || [],
    });
  } catch (error) {
    next(error);
  }
};

// Update session status
export const updateSessionStatus = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { status } = req.body;

    console.log('📋 Updating session status:', { sessionId, status, userId: req.user?.id });

    if (!status) {
      throw new AppError('Status is required', 400);
    }

    const updates = { status };

    if (status === 'in-progress' && !req.body.skipStartTime) {
      updates.start_time = new Date().toISOString();
    } else if (status === 'completed') {
      updates.end_time = new Date().toISOString();
    }

    const { data, error } = await db.supabase
      .from('sessions')
      .update(updates)
      .eq('id', sessionId)
      .select('*, competition:competitions(*)')
      .single();

    if (error) {
      console.error('❌ Database error updating session:', error);
      throw new AppError(error.message, 400);
    }

    console.log('✅ Session updated successfully:', { sessionId, newStatus: data.status });

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.emit('session:updated', data);
      console.log('📡 Emitted session:updated event');
    }

    // Sync competition status and live state to website (best-effort)
    syncCompetitionStatusBySession(sessionId, status);
    syncLiveStateFromSession(sessionId, {
      running: status === 'in-progress',
      remaining: null,
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('❌ Error in updateSessionStatus:', error);
    next(error);
  }
};

// Change current lift (snatch to clean & jerk)
export const changeCurrentLift = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { liftType } = req.body;

    if (!liftType || !['snatch', 'clean_and_jerk'].includes(liftType)) {
      throw new AppError('Valid lift type is required', 400);
    }

    const { data, error } = await db.supabase
      .from('sessions')
      .update({ current_lift: liftType })
      .eq('id', sessionId)
      .select('*, competition:competitions(*)')
      .single();

    if (error) throw new AppError(error.message, 400);

    // Emit socket event
    req.app.get('io').emit('session:updated', data);

    // Sync live state to website (best-effort)
    syncLiveStateFromSession(sessionId, {
      running: false,
      remaining: null,
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

// Update athlete medal (manual override)
export const updateAthleteMedal = async (req, res, next) => {
  try {
    const { athleteId } = req.params;
    const { medal } = req.body;

    // Validate medal value
    if (medal !== null && !['gold', 'silver', 'bronze'].includes(medal)) {
      throw new AppError('Medal must be gold, silver, bronze, or null', 400);
    }

    const { data, error } = await db.supabase
      .from('athletes')
      .update({ 
        medal,
        medal_manual_override: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', athleteId)
      .select('*, team:teams(*), session:sessions(*)')
      .single();

    if (error) throw new AppError(error.message, 400);

    // Emit socket event to notify all clients
    const io = req.app.get('io');
    io.emit('athlete:updated', data);
    
    // Also emit leaderboard update for the session
    if (data.session_id) {
      const { data: leaderboard } = await db.supabase
        .from('athletes')
        .select('*')
        .eq('session_id', data.session_id)
        .order('rank', { ascending: true, nullsFirst: false });
      
      io.to(`session:${data.session_id}`).emit('leaderboard:updated', leaderboard);
    }

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};
// Request weight change (IWF Rule 6.5.1 - Weight change regulations)
export const requestWeightChange = async (req, res, next) => {
  try {
    const { athleteId, weight, liftType, attemptNumber } = req.body;

    if (!athleteId || !weight || !liftType) {
      throw new AppError('Athlete ID, weight, and lift type are required', 400);
    }

    // Get athlete and current attempt
    const { data: athlete, error: athleteError } = await db.supabase
      .from('athletes')
      .select('*, session:sessions(*)')
      .eq('id', athleteId)
      .single();

    if (athleteError) throw new AppError('Athlete not found', 404);

    // Get current pending attempt
    const { data: currentAttempt } = await db.supabase
      .from('attempts')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('lift_type', liftType)
      .eq('result', 'pending')
      .single();

    if (!currentAttempt) {
      throw new AppError('No pending attempt found for this athlete', 400);
    }

    // IWF Rule: Weight changes only allowed until 1 minute before athlete is called
    // TODO: Implement time-based validation when timer integration is complete
    
    // IWF Rule: Weight can only be increased
    if (weight <= currentAttempt.weight) {
      throw new AppError(
        `New weight (${weight}kg) must be greater than current weight (${currentAttempt.weight}kg)`,
        400
      );
    }

    // Update the attempt weight
    const { data: updatedAttempt, error: updateError } = await db.supabase
      .from('attempts')
      .update({ 
        weight,
        weight_changed: true,
        weight_change_timestamp: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', currentAttempt.id)
      .select('*, athlete:athletes(*, team:teams(*)), session:sessions(*)')
      .single();

    if (updateError) throw new AppError(updateError.message, 400);

    // Emit socket event to update lifting order
    const io = req.app.get('io');
    io.to(`session:${athlete.session_id}`).emit('attempt:weightChanged', {
      attemptId: currentAttempt.id,
      athleteId,
      athleteName: athlete.name,
      oldWeight: currentAttempt.weight,
      newWeight: weight,
      liftType,
      sessionId: athlete.session_id,
    });

    // Re-emit lifting order update
    io.to(`session:${athlete.session_id}`).emit('liftingOrder:updated', {
      sessionId: athlete.session_id,
      liftType,
    });

    res.status(200).json({
      success: true,
      data: updatedAttempt,
      message: `Weight changed from ${currentAttempt.weight}kg to ${weight}kg`,
    });
  } catch (error) {
    next(error);
  }
};