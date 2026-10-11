import { supabase } from '../services/database.js';
import { AppError } from '../middleware/errorHandler.js';
import { syncAthleteStatus } from '../services/liftingSocialSync.service.js';
import { updateAthletesFromFinal } from '../services/athleteService.js';

// IWF Weight Categories (2024 Rules)
const WEIGHT_CATEGORIES = {
  male: [
    { category: '60', min: 0, max: 60 },
    { category: '65', min: 60.01, max: 65 },
    { category: '71', min: 65.01, max: 71 },
    { category: '79', min: 71.01, max: 79 },
    { category: '88', min: 79.01, max: 88 },
    { category: '94', min: 88.01, max: 94 },
    { category: '110', min: 94.01, max: 110 },
    { category: '110+', min: 110.01, max: Infinity }
  ],
  female: [
    { category: '48', min: 0, max: 48 },
    { category: '53', min: 48.01, max: 53 },
    { category: '58', min: 53.01, max: 58 },
    { category: '63', min: 58.01, max: 63 },
    { category: '69', min: 63.01, max: 69 },
    { category: '77', min: 69.01, max: 77 },
    { category: '86', min: 77.01, max: 86 },
    { category: '86+', min: 86.01, max: Infinity }
  ]
};

// Validate bodyweight against weight category (IWF Rule 6.3.1)
const validateWeightCategory = (bodyWeight, weightCategory, gender) => {
  const categories = WEIGHT_CATEGORIES[gender] || WEIGHT_CATEGORIES.female;
  const category = categories.find(c => c.category === weightCategory);
  
  if (!category) {
    return { valid: false, message: 'Invalid weight category' };
  }
  
  if (bodyWeight > category.max) {
    return { 
      valid: false, 
      message: `Bodyweight ${bodyWeight}kg exceeds ${category.category}kg category limit (max ${category.max}kg)`,
      overweight: true,
      excess: (bodyWeight - category.max).toFixed(2)
    };
  }
  
  if (bodyWeight < category.min) {
    return { 
      valid: false, 
      message: `Bodyweight ${bodyWeight}kg is below ${category.category}kg category minimum (min ${category.min}kg)`,
      underweight: true
    };
  }
  
  return { valid: true, message: 'Weight within category limits' };
};

export const getAthletes = async (req, res, next) => {
  try {
    const { sessionId, gender, weightCategory, limit = 100, offset = 0 } = req.query;
    const sessionIdFromParam = req.params.sessionId; // Support both route param and query param

    // Best-effort sync: keep WL athletes aligned with latest final entry details
    try {
      const { data: athleteRegs } = await supabase
        .from('athletes')
        .select('registration_id')
        .not('registration_id', 'is', null);

      const registrationIds = [...new Set((athleteRegs || []).map((a) => a.registration_id).filter(Boolean))];

      if (registrationIds.length > 0) {
        const { data: finalApprovedRegs } = await supabase
          .from('event_registrations')
          .select('id')
          .in('id', registrationIds)
          .eq('status', 'final_approved');

        for (const reg of finalApprovedRegs || []) {
          const { data: finalAthletes } = await supabase
            .from('preliminary_entry_athletes')
            .select('*')
            .eq('registration_id', reg.id)
            .order('competitor_number', { ascending: true });

          if (finalAthletes && finalAthletes.length > 0) {
            await updateAthletesFromFinal(reg.id, finalAthletes);
          }
        }
      }
    } catch (syncError) {
      console.warn('Final-entry sync skipped due to error:', syncError?.message || syncError);
    }
    
    // Use optimized query with JOINs for related data
    let query = supabase.from('athletes').select('*, session:sessions(*), team:teams(*)');

    // Use sessionId from route param if available, otherwise from query param
    const finalSessionId = sessionIdFromParam || sessionId;
    
    if (finalSessionId) query = query.eq('session_id', finalSessionId);
    if (gender) query = query.eq('gender', gender);
    if (weightCategory) query = query.eq('weight_category', weightCategory);

    // Add pagination
    query = query
      .order('start_number', { ascending: true, nullsFirst: false })
      .order('lot_number', { ascending: true, nullsFirst: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error, count } = await query;

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      count: count || data?.length || 0,
      data: data || [],
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + parseInt(limit)) < (count || 0)
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getAthlete = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('athletes')
      .select('*, team:teams(*)')
      .eq('id', req.params.id)
      .single();

    if (error) throw new AppError('Athlete not found', 404);

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const createAthlete = async (req, res, next) => {
  try {
    // Validate required fields
    const { name, gender, weight_category, session_id, team_id, id_number, registration_number, best_total, coach_name, birth_date } = req.body;
    
    if (!name || !name.trim()) {
      throw new AppError('Athlete name is required', 400);
    }
    if (!gender) {
      throw new AppError('Gender is required', 400);
    }
    if (!weight_category) {
      throw new AppError('Weight category is required', 400);
    }
    if (!session_id) {
      throw new AppError('Session is required', 400);
    }

    // Get country from team or use default
    let country = 'UNK'; // Default country code
    
    if (team_id) {
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .select('country')
        .eq('id', team_id)
        .single();
      
      if (team && team.country) {
        country = team.country;
      }
    }

    // Prepare athlete data (exclude fields that shouldn't be set on creation)
    const athleteData = {
      name: name.trim(),
      gender,
      weight_category,
      session_id,
      country, // Set country from team or default
      birth_date: birth_date || null,
      team_id: team_id || null,
      id_number: id_number || null,
      registration_number: registration_number || null,
      best_total: best_total ? parseFloat(best_total) : null,
      coach_name: coach_name || null,
      // Note: body_weight, start_number, and other fields are managed separately or auto-generated
    };

    const { data, error } = await supabase
      .from('athletes')
      .insert([athleteData])
      .select();

    if (error) {
      console.error('Supabase insert error:', error);
      throw new AppError(`Failed to register athlete: ${error.message}`, 400);
    }

    if (!data || data.length === 0) {
      throw new AppError('Failed to create athlete record', 400);
    }

    res.status(201).json({
      success: true,
      data: data[0],
    });
  } catch (error) {
    next(error);
  }
};

export const updateAthlete = async (req, res, next) => {
  try {
    // Validate bodyweight against weight category if body_weight is being updated
    if (req.body.body_weight) {
      // Get athlete's current data to check gender and weight category
      const { data: athlete } = await supabase
        .from('athletes')
        .select('gender, weight_category')
        .eq('id', req.params.id)
        .single();
      
      if (athlete) {
        const gender = req.body.gender || athlete.gender;
        const weightCategory = req.body.weight_category || athlete.weight_category;
        
        const validation = validateWeightCategory(
          parseFloat(req.body.body_weight),
          weightCategory,
          gender
        );
        
        if (!validation.valid) {
          // Return warning but allow update (officials can override)
          res.status(200).json({
            success: true,
            data: null,
            warning: validation.message,
            weightValidation: {
              valid: false,
              overweight: validation.overweight || false,
              underweight: validation.underweight || false,
              excess: validation.excess || null,
              message: validation.message,
              requiresReweigh: validation.overweight, // IWF allows 2-hour reweigh
            }
          });
          return;
        }
      }
    }

    // Process best_total if provided (convert to number)
    const updateData = { ...req.body };
    if (updateData.best_total) {
      updateData.best_total = parseFloat(updateData.best_total);
    }

    const { data, error } = await supabase
      .from('athletes')
      .update(updateData)
      .eq('id', req.params.id)
      .select();

    if (error) throw new AppError(error.message, 400);
    if (!data || data.length === 0) throw new AppError('Athlete not found', 404);

    // Best-effort sync for fields that affect public live scoreboard display.
    if (
      Object.prototype.hasOwnProperty.call(updateData, 'is_dq') ||
      Object.prototype.hasOwnProperty.call(updateData, 'lot_number') ||
      Object.prototype.hasOwnProperty.call(updateData, 'start_number') ||
      Object.prototype.hasOwnProperty.call(updateData, 'registration_id')
    ) {
      syncAthleteStatus(data[0]).catch((syncError) => {
        console.warn('Failed to sync athlete status to website:', syncError?.message || syncError);
      });
    }

    res.status(200).json({
      success: true,
      data: data[0],
    });
  } catch (error) {
    next(error);
  }
};

export const deleteAthlete = async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('athletes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      data: {},
    });
  } catch (error) {
    next(error);
  }
};
