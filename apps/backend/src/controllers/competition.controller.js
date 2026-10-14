import { supabase } from '../services/database.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * SINGLE COMPETITION SYSTEM
 * The system manages only ONE competition at a time.
 * This controller provides endpoints to get and update the current competition.
 */

/**
 * Get the current competition (singleton)
 * Returns the active competition, or the most recent one if none is active
 */
export const getCurrentCompetition = async (req, res, next) => {
  try {
    // First try to get active competition
    let { data, error } = await supabase
      .from('competitions')
      .select('*')
      .eq('status', 'active')
      .single();

    // If no active competition, get the most recent one
    if (error || !data) {
      const result = await supabase
        .from('competitions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      data = result.data;
      error = result.error;
    }

    res.status(200).json({
      success: true,
      data: data || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Sync competition to lifting-social-website
 */
const syncCompetitionToWebsite = async (competition) => {
  try {
    console.log(`📤 Syncing competition to lifting-social-website:`, competition.id);
    
    const syncPayload = {
      wl_competition_id: competition.id,
      title: competition.name,
      description: competition.description || '',
      location: competition.location,
      venue: competition.location, // Map venue to location
      start_date: competition.date,
      registration_deadline: null,
      preliminary_entry_start: null,
      preliminary_entry_end: null,
      final_entry_start: null,
      final_entry_end: null,
      weight_categories: [],
      age_categories: [],
      sanctioning_body: competition.organizer || 'Unknown',
      competition_level: 'regional',
      max_participants: null,
      entry_fee: 0,
      require_medical_clearance: false,
      competition_rules: {},
      image_url: competition.image_url, // Include the image URL
      config: {}
    };

    // Make the sync request to lifting-social-backend
    const rawBaseUrl = process.env.LIFTING_SOCIAL_API_URL || 'http://localhost:5000';
    const syncBaseUrl = rawBaseUrl.replace(/\/+$/, '').replace(/\/api$/, '');

    const response = await fetch(
      `${syncBaseUrl}/api/wl-system/sync/competition`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SYNC_API_KEY || 'dev-key'}`,
        },
        body: JSON.stringify(syncPayload),
      }
    );

    if (!response.ok) {
      console.error(`⚠️ Sync failed with status ${response.status}`);
      const error = await response.text();
      console.error('Sync error:', error);
      return;
    }

    const result = await response.json();
    console.log(`✅ Competition synced successfully:`, result);
  } catch (error) {
    console.error(`❌ Error syncing competition:`, error);
    // Don't throw - sync failure shouldn't prevent competition creation
  }
};

/**
 * Update the current competition
 * If no competition exists, creates one. Otherwise updates the existing one.
 */
export const updateCurrentCompetition = async (req, res, next) => {
  try {
    console.log('📝 Updating competition with data:', req.body);
    
    // Get current competition
    const { data: existing } = await supabase
      .from('competitions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    console.log('📊 Existing competition:', existing?.id);

    let data, error;

    if (existing) {
      // Update existing competition
      console.log('🔄 Updating competition ID:', existing.id);
      const result = await supabase
        .from('competitions')
        .update(req.body)
        .eq('id', existing.id)
        .select();
      
      data = result.data;
      error = result.error;
      
      if (error) {
        console.error('❌ Supabase update error:', error);
      } else {
        console.log('✅ Update successful');
      }
    } else {
      // Create new competition if none exists
      const result = await supabase
        .from('competitions')
        .insert([{ ...req.body, status: 'active' }])
        .select();
      
      data = result.data;
      error = result.error;
    }

    if (error) throw new AppError(error.message, 400);

    // Sync competition to website
    const updatedCompetition = data[0];
    await syncCompetitionToWebsite(updatedCompetition);

    // Emit socket event
    req.app.get('io').emit('competition:updated', updatedCompetition);

    res.status(200).json({
      success: true,
      data: updatedCompetition,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Initialize competition - creates the first competition if none exists
 * If a competition already exists, this endpoint will fail and user must delete first
 */
export const initializeCompetition = async (req, res, next) => {
  try {
    // Check if any competition exists
    const { data: existing, error: selectError } = await supabase
      .from('competitions')
      .select('id')
      .limit(1)
      .single();

    // If we got data (existing = not null), a competition exists
    if (existing) {
      throw new AppError(
        'A competition already exists. Please delete the existing competition first or use the update endpoint to modify it.',
        409
      );
    }

    // Create initial competition
    const { data, error } = await supabase
      .from('competitions')
      .insert([{ ...req.body, status: 'active' }])
      .select();

    if (error) throw new AppError(error.message, 400);

    // Sync competition to website
    const createdCompetition = data[0];
    await syncCompetitionToWebsite(createdCompetition);

    res.status(201).json({
      success: true,
      data: createdCompetition,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Set which session the venue display screens (Scoreboard/Intro/Results)
 * currently follow. Screens resolve this at runtime via Supabase Realtime
 * instead of a fixed sessionId baked into their URL, so switching sessions
 * in the Technical Panel updates every open display screen automatically.
 */
export const setActiveSession = async (req, res, next) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400);
    }

    // Resolve the current competition the same way getCurrentCompetition does.
    let { data: competition, error: findError } = await supabase
      .from('competitions')
      .select('id')
      .eq('status', 'active')
      .single();

    if (findError || !competition) {
      const result = await supabase
        .from('competitions')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      competition = result.data;
      findError = result.error;
    }

    if (findError || !competition) {
      throw new AppError('No competition found', 404);
    }

    const { data, error } = await supabase
      .from('competitions')
      .update({ active_session_id: sessionId })
      .eq('id', competition.id)
      .select()
      .single();

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a competition and all associated data
 * (sessions, athletes, attempts, etc.)
 */
export const deleteCompetition = async (req, res, next) => {
  try {
    const { competitionId } = req.params;

    if (!competitionId) {
      throw new AppError('Competition ID is required', 400);
    }

    // Delete the competition (cascading deletes will handle related records)
    const { error } = await supabase
      .from('competitions')
      .delete()
      .eq('id', competitionId);

    if (error) throw new AppError(error.message, 400);

    res.status(200).json({
      success: true,
      message: 'Competition deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
