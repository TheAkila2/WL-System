import { supabase as db } from '../services/database.js';
import { getCurrentEffectiveWeight } from './weightChange.service.js';

function parseWeightCategoryValue(weightCategory) {
  if (!weightCategory || typeof weightCategory !== 'string') {
    return Number.POSITIVE_INFINITY;
  }

  const normalized = weightCategory.trim();
  const isPlusClass = normalized.startsWith('+');
  const numericPart = parseFloat(normalized.replace(/[^\d.]/g, ''));

  if (Number.isNaN(numericPart)) {
    return Number.POSITIVE_INFINITY;
  }

  // Super-heavy classes (e.g. +109) should always come after capped classes.
  return isPlusClass ? numericPart + 1000 : numericPart;
}

/**
 * Lifting Order Service
 * Calculates athlete lifting order according to IWF rules
 */

/**
 * Calculate lifting order for a session
 * 
 * IWF Rules:
 * 1. Athletes lift in order of declared weight (lowest first)
 * 2. If same weight, lot number determines order (lowest first)
 * 3. Within same attempt number, failed attempts repeat at same weight
 * 4. Athlete can change weight between attempts (must increase by min 1kg)
 * 
 * @param {string} sessionId - Session UUID
 * @param {string} liftType - 'snatch' or 'clean_jerk'
 * @returns {Promise<Array>} Ordered list of athletes
 */
export async function calculateLiftingOrder(sessionId, liftType = 'snatch') {
  try {
    // Get all athletes in session with their attempts
    const { data: athletes, error: athletesError } = await db
      .from('athletes')
      .select(`
        id,
        name,
        country,
        start_number,
        body_weight,
        weight_category,
        opening_snatch,
        opening_clean_jerk,
        lot_number,
        team_id,
        teams (
          name,
          logo_url
        )
      `)
      .eq('session_id', sessionId)
      .not('weigh_in_completed_at', 'is', null); // Only athletes who completed weigh-in

    if (athletesError) throw athletesError;
    if (!athletes || athletes.length === 0) return [];

    // Get all attempts for these athletes
    const athleteIds = athletes.map(a => a.id);
    const { data: attempts, error: attemptsError } = await db
      .from('attempts')
      .select('*')
      .in('athlete_id', athleteIds)
      .eq('lift_type', liftType)
      .order('attempt_number', { ascending: true });

    if (attemptsError) throw attemptsError;

    // Build athlete lifting data
    const promises = athletes.map(async (athlete) => {
      const athleteAttempts = (attempts || []).filter(a => a.athlete_id === athlete.id);
      
      // Find next attempt to take
      const completedAttempts = athleteAttempts.filter(a => a.result !== 'pending');
      const nextAttemptNumber = completedAttempts.length + 1; // 1, 2, or 3
      
      // If all 3 attempts done, exclude from order
      if (nextAttemptNumber > 3) {
        return null;
      }

      // Determine requested weight for next attempt
      let requestedWeight;
      const lastAttempt = completedAttempts[completedAttempts.length - 1];
      
      if (nextAttemptNumber === 1) {
        // First attempt: use opening weight (check for weight changes first)
        const changedWeight = await getCurrentEffectiveWeight(athlete.id, liftType);
        requestedWeight = changedWeight || (liftType === 'snatch' 
          ? athlete.opening_snatch 
          : athlete.opening_clean_jerk);
      } else if (lastAttempt?.result === 'good') {
        // If last attempt succeeded, check for weight change request
        const changedWeight = await getCurrentEffectiveWeight(athlete.id, liftType);
        // If there's a weight change, use it; otherwise default to last weight + 1kg
        requestedWeight = changedWeight || (lastAttempt.weight + 1);
      } else {
        // If last attempt failed, must repeat the same weight (no weight change allowed)
        requestedWeight = lastAttempt?.weight || (liftType === 'snatch' 
          ? athlete.opening_snatch 
          : athlete.opening_clean_jerk);
      }

      return {
        athlete_id: athlete.id,
        name: athlete.name,
        country: athlete.country,
        start_number: athlete.start_number,
        body_weight: athlete.body_weight,
        weight_category: athlete.weight_category,
        lot_number: athlete.lot_number,
        team_name: athlete.teams?.name,
        team_logo: athlete.teams?.logo_url,
        attempt_number: nextAttemptNumber,
        requested_weight: requestedWeight,
        last_attempt_result: lastAttempt?.result || null,
        attempts_completed: completedAttempts.length,
        attempts: athleteAttempts.map(a => ({
          number: a.attempt_number,
          weight: a.weight,
          result: a.result
        }))
      };
    });

    // Wait for all async operations
    const athletesWithOrder = await Promise.all(promises);

    // Sort according to IWF rules
    const sortedAthletes = athletesWithOrder.filter(a => a !== null).sort((a, b) => {
      // Rule 1: Lowest requested weight first
      if (a.requested_weight !== b.requested_weight) {
        return a.requested_weight - b.requested_weight;
      }

      // Rule 2: If same weight, lower bodyweight class first
      const aWeightCategory = parseWeightCategoryValue(a.weight_category);
      const bWeightCategory = parseWeightCategoryValue(b.weight_category);
      if (aWeightCategory !== bWeightCategory) {
        return aWeightCategory - bWeightCategory;
      }

      // Rule 3: If same weight category, lowest lot number first
      if (a.lot_number !== b.lot_number) {
        return (a.lot_number || 999) - (b.lot_number || 999);
      }

      // Rule 4: If same lot number, lower attempt number first
      if (a.attempt_number !== b.attempt_number) {
        return a.attempt_number - b.attempt_number;
      }

      // Rule 5: If same attempt number, failed attempts before successful
      // (This handles cases where someone failed and is repeating)
      const aFailed = a.last_attempt_result === 'fail' ? 0 : 1;
      const bFailed = b.last_attempt_result === 'fail' ? 0 : 1;
      if (aFailed !== bFailed) {
        return aFailed - bFailed;
      }

      // Final tie-breaker: start number (shouldn't happen, but just in case)
      return a.start_number - b.start_number;
    });

    return sortedAthletes;
  } catch (error) {
    console.error('Error calculating lifting order:', error);
    throw error;
  }
}

/**
 * Get current athlete, on deck, and in the hole
 * 
 * @param {string} sessionId - Session UUID
 * @param {string} liftType - 'snatch' or 'clean_jerk'
 * @returns {Promise<Object>} { current, onDeck, inHole, fullOrder }
 */
export async function getCurrentLiftingPositions(sessionId, liftType = 'snatch') {
  const order = await calculateLiftingOrder(sessionId, liftType);
  
  return {
    current: order[0] || null,      // Athlete on platform
    onDeck: order[1] || null,       // Next athlete
    inHole: order[2] || null,       // Athlete after next
    fullOrder: order                // Complete ordered list
  };
}

/**
 * Check if athlete is ready to lift (for clock management)
 * 
 * @param {string} sessionId - Session UUID
 * @param {string} athleteId - Athlete UUID
 * @param {string} liftType - 'snatch' or 'clean_jerk'
 * @returns {Promise<boolean>}
 */
export async function isAthleteCurrentLifter(sessionId, athleteId, liftType) {
  const positions = await getCurrentLiftingPositions(sessionId, liftType);
  return positions.current?.athlete_id === athleteId;
}

export default {
  calculateLiftingOrder,
  getCurrentLiftingPositions,
  isAthleteCurrentLifter
};
