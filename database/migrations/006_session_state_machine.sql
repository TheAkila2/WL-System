-- =====================================================
-- MIGRATION 006: SESSION STATE MACHINE IMPLEMENTATION
-- =====================================================
-- Implements optimized competition workflow with:
-- - Session state transitions
-- - Weigh-in tracking
-- - Phase locking (snatch/C&J)
-- - Progressive button unlocking
-- =====================================================

-- =====================================================
-- 1. CREATE SESSION STATE ENUM
-- =====================================================

CREATE TYPE session_state AS ENUM (
    'scheduled',          -- Initial state, no activities yet
    'postponed',          -- Postponed by admin
    'weighing',           -- Weigh-in in progress
    'ready_to_start',     -- Weigh-in complete, ready for competition
    'active',             -- Competition in progress (deciding phase)
    'snatch_active',      -- Snatch phase active, C&J locked
    'snatch_complete',    -- All snatch done, C&J available
    'clean_jerk_active',  -- C&J phase active, Snatch locked
    'complete'            -- Competition finished
);

CREATE TYPE competition_phase AS ENUM ('snatch', 'clean_jerk');

-- =====================================================
-- 2. UPDATE SESSIONS TABLE
-- =====================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS state session_state DEFAULT 'scheduled';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_phase competition_phase DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS weigh_in_completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS snatch_started_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS snatch_completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS clean_jerk_started_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS clean_jerk_completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS locked_phase competition_phase DEFAULT NULL;

-- =====================================================
-- 3. UPDATE ATHLETES TABLE (WEIGH-IN FIELDS)
-- =====================================================

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS body_weight_kg DECIMAL(5,2);
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS weigh_in_date TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS weighed_in BOOLEAN DEFAULT FALSE;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS start_weight_kg DECIMAL(5,2);

-- =====================================================
-- 4. CREATE SESSION PROGRESSION LOCKS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS session_progression_locks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    
    -- Button visibility flags
    weigh_in_button_enabled BOOLEAN DEFAULT TRUE,
    start_competition_button_enabled BOOLEAN DEFAULT FALSE,
    start_snatch_button_enabled BOOLEAN DEFAULT FALSE,
    start_clean_jerk_button_enabled BOOLEAN DEFAULT FALSE,
    
    -- Weigh-in progress tracking
    weigh_in_required_athletes INT DEFAULT 0,
    weigh_in_completed_count INT DEFAULT 0,
    
    -- Snatch phase tracking
    snatch_total_lifters INT DEFAULT 0,
    snatch_completed_lifters INT DEFAULT 0,
    
    -- C&J phase tracking
    clean_jerk_total_lifters INT DEFAULT 0,
    clean_jerk_completed_lifters INT DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_progression_locks_session 
ON session_progression_locks(session_id);

-- =====================================================
-- 5. CREATE SESSION STATE HISTORY TABLE (AUDIT TRAIL)
-- =====================================================

CREATE TABLE IF NOT EXISTS session_state_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    from_state session_state NOT NULL,
    to_state session_state NOT NULL,
    changed_by UUID REFERENCES wl_users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_state_history_session 
ON session_state_history(session_id);
CREATE INDEX IF NOT EXISTS idx_session_state_history_created 
ON session_state_history(created_at DESC);

-- =====================================================
-- 6. STATE TRANSITION FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION validate_session_state_transition(
    p_current_state session_state,
    p_new_state session_state
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN CASE
        WHEN p_current_state = 'scheduled' THEN p_new_state IN ('weighing', 'postponed')
        WHEN p_current_state = 'postponed' THEN p_new_state IN ('scheduled')
        WHEN p_current_state = 'weighing' THEN p_new_state IN ('ready_to_start', 'scheduled')
        WHEN p_current_state = 'ready_to_start' THEN p_new_state IN ('active', 'weighing')
        WHEN p_current_state = 'active' THEN p_new_state IN ('snatch_active')
        WHEN p_current_state = 'snatch_active' THEN p_new_state IN ('snatch_complete')
        WHEN p_current_state = 'snatch_complete' THEN p_new_state IN ('clean_jerk_active', 'snatch_active')
        WHEN p_current_state = 'clean_jerk_active' THEN p_new_state IN ('complete')
        WHEN p_current_state = 'complete' THEN FALSE
        ELSE FALSE
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =====================================================
-- 7. UPDATE SESSION STATE FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION update_session_state(
    p_session_id UUID,
    p_new_state session_state,
    p_user_id UUID DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_current_state session_state;
    v_result JSONB;
BEGIN
    -- Get current state
    SELECT state INTO v_current_state FROM sessions WHERE id = p_session_id;
    
    IF v_current_state IS NULL THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;
    
    -- Validate transition
    IF NOT validate_session_state_transition(v_current_state, p_new_state) THEN
        RAISE EXCEPTION 'Invalid state transition: % -> %', v_current_state, p_new_state;
    END IF;
    
    -- Update session state
    UPDATE sessions 
    SET 
        state = p_new_state,
        updated_at = CURRENT_TIMESTAMP,
        -- Update timestamps based on state
        weigh_in_completed_at = CASE 
            WHEN p_new_state = 'ready_to_start' THEN CURRENT_TIMESTAMP 
            ELSE weigh_in_completed_at 
        END,
        snatch_started_at = CASE 
            WHEN p_new_state = 'snatch_active' THEN CURRENT_TIMESTAMP 
            ELSE snatch_started_at 
        END,
        snatch_completed_at = CASE 
            WHEN p_new_state = 'snatch_complete' THEN CURRENT_TIMESTAMP 
            ELSE snatch_completed_at 
        END,
        clean_jerk_started_at = CASE 
            WHEN p_new_state = 'clean_jerk_active' THEN CURRENT_TIMESTAMP 
            ELSE clean_jerk_started_at 
        END,
        clean_jerk_completed_at = CASE 
            WHEN p_new_state = 'complete' THEN CURRENT_TIMESTAMP 
            ELSE clean_jerk_completed_at 
        END,
        locked_phase = CASE
            WHEN p_new_state = 'snatch_active' THEN 'clean_jerk'::competition_phase
            WHEN p_new_state = 'snatch_complete' THEN 'snatch'::competition_phase
            WHEN p_new_state = 'clean_jerk_active' THEN 'snatch'::competition_phase
            ELSE NULL
        END,
        current_phase = CASE
            WHEN p_new_state = 'snatch_active' THEN 'snatch'::competition_phase
            WHEN p_new_state = 'clean_jerk_active' THEN 'clean_jerk'::competition_phase
            ELSE current_phase
        END
    WHERE id = p_session_id;
    
    -- Log state change
    INSERT INTO session_state_history (session_id, from_state, to_state, changed_by, reason)
    VALUES (p_session_id, v_current_state, p_new_state, p_user_id, p_reason);
    
    -- Update progression locks based on new state
    PERFORM update_session_progression_locks(p_session_id, p_new_state);
    
    -- Return success response
    v_result := jsonb_build_object(
        'success', TRUE,
        'session_id', p_session_id,
        'previous_state', v_current_state,
        'new_state', p_new_state,
        'timestamp', CURRENT_TIMESTAMP
    );
    
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 8. UPDATE PROGRESSION LOCKS FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION update_session_progression_locks(
    p_session_id UUID,
    p_new_state session_state
) RETURNS VOID AS $$
DECLARE
    v_total_athletes INT;
    v_weighed_in INT;
BEGIN
    -- Get athlete counts
    SELECT COUNT(*) INTO v_total_athletes FROM athletes WHERE session_id = p_session_id;
    SELECT COUNT(*) INTO v_weighed_in FROM athletes WHERE session_id = p_session_id AND weighed_in = TRUE;
    
    -- Update or insert progression locks
    INSERT INTO session_progression_locks (
        session_id,
        weigh_in_button_enabled,
        start_competition_button_enabled,
        start_snatch_button_enabled,
        start_clean_jerk_button_enabled,
        weigh_in_required_athletes,
        weigh_in_completed_count
    ) VALUES (
        p_session_id,
        CASE WHEN p_new_state = 'scheduled' THEN TRUE ELSE FALSE END,
        CASE WHEN p_new_state = 'ready_to_start' THEN TRUE ELSE FALSE END,
        CASE WHEN p_new_state IN ('active', 'snatch_active') THEN TRUE ELSE FALSE END,
        CASE WHEN p_new_state IN ('snatch_complete', 'clean_jerk_active') THEN TRUE ELSE FALSE END,
        v_total_athletes,
        v_weighed_in
    )
    ON CONFLICT (session_id) DO UPDATE SET
        weigh_in_button_enabled = CASE WHEN p_new_state = 'scheduled' THEN TRUE ELSE FALSE END,
        start_competition_button_enabled = CASE WHEN p_new_state = 'ready_to_start' THEN TRUE ELSE FALSE END,
        start_snatch_button_enabled = CASE WHEN p_new_state IN ('active', 'snatch_active') THEN TRUE ELSE FALSE END,
        start_clean_jerk_button_enabled = CASE WHEN p_new_state IN ('snatch_complete', 'clean_jerk_active') THEN TRUE ELSE FALSE END,
        weigh_in_required_athletes = v_total_athletes,
        weigh_in_completed_count = v_weighed_in,
        updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 9. WEIGH-IN COMPLETE FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION mark_athlete_weighed_in(
    p_athlete_id UUID,
    p_body_weight_kg DECIMAL,
    p_start_weight_kg DECIMAL DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session_id UUID;
    v_total_athletes INT;
    v_weighed_in INT;
BEGIN
    -- Update athlete weigh-in and capture session
    UPDATE athletes
    SET
        weighed_in = TRUE,
        body_weight_kg = p_body_weight_kg,
        start_weight_kg = COALESCE(p_start_weight_kg, p_body_weight_kg + 5),
        weigh_in_date = CURRENT_TIMESTAMP,
        weigh_in_completed_at = COALESCE(weigh_in_completed_at, CURRENT_TIMESTAMP)
    WHERE id = p_athlete_id
    RETURNING session_id INTO v_session_id;

    IF NOT FOUND OR v_session_id IS NULL THEN
        RAISE EXCEPTION 'Athlete not found or not assigned to session: %', p_athlete_id;
    END IF;

    -- Refresh progression lock counters so buttons unlock when all weighed
    SELECT
        COUNT(*)::INT,
        COUNT(*) FILTER (WHERE weighed_in = TRUE)::INT
    INTO v_total_athletes, v_weighed_in
    FROM athletes
    WHERE session_id = v_session_id;

    UPDATE session_progression_locks
    SET
        weigh_in_required_athletes = v_total_athletes,
        weigh_in_completed_count = v_weighed_in,
        start_competition_button_enabled = CASE
            WHEN v_total_athletes > 0 AND v_total_athletes = v_weighed_in THEN TRUE
            ELSE start_competition_button_enabled
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE session_id = v_session_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'athlete_id', p_athlete_id,
        'body_weight_kg', p_body_weight_kg,
        'start_weight_kg', COALESCE(p_start_weight_kg, p_body_weight_kg + 5),
        'session_id', v_session_id,
        'weighed_in_count', v_weighed_in,
        'total_athletes', v_total_athletes,
        'timestamp', CURRENT_TIMESTAMP
    );
END;
$$;

-- =====================================================
-- 10. GET WEIGH-IN SUMMARY FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION get_weigh_in_summary(p_session_id UUID)
RETURNS TABLE (
    total_athletes INT,
    weighed_in INT,
    pending INT,
    completion_percentage DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::INT as total_athletes,
        COUNT(*) FILTER (WHERE weighed_in = TRUE)::INT as weighed_in,
        COUNT(*) FILTER (WHERE weighed_in = FALSE)::INT as pending,
        ROUND(
            CASE 
                WHEN COUNT(*) = 0 THEN 0
                ELSE (COUNT(*) FILTER (WHERE weighed_in = TRUE)::DECIMAL / COUNT(*) * 100)
            END,
            2
        ) as completion_percentage
    FROM athletes
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 11. GET NEXT LIFTER FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION get_next_lifter(
    p_session_id UUID,
    p_phase competition_phase
) RETURNS TABLE (
    athlete_id UUID,
    athlete_name VARCHAR,
    team_name VARCHAR,
    current_attempt INT,
    target_weight INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        a.id,
        a.name,
        COALESCE(t.name, a.country),
        CASE 
            WHEN p_phase = 'snatch' THEN 
                COALESCE(
                    (SELECT attempt_number FROM attempts 
                     WHERE athlete_id = a.id AND lift_type = 'snatch' AND result = 'pending'
                     ORDER BY attempt_number ASC LIMIT 1),
                    1
                )
            ELSE 
                COALESCE(
                    (SELECT attempt_number FROM attempts 
                     WHERE athlete_id = a.id AND lift_type = 'clean_and_jerk' AND result = 'pending'
                     ORDER BY attempt_number ASC LIMIT 1),
                    1
                )
        END::INT,
        CASE 
            WHEN p_phase = 'snatch' THEN 
                COALESCE(
                    (SELECT weight FROM attempts 
                     WHERE athlete_id = a.id AND lift_type = 'snatch' AND result = 'pending'
                     ORDER BY attempt_number ASC LIMIT 1),
                    a.start_weight_kg::INT
                )
            ELSE 
                COALESCE(
                    (SELECT weight FROM attempts 
                     WHERE athlete_id = a.id AND lift_type = 'clean_and_jerk' AND result = 'pending'
                     ORDER BY attempt_number ASC LIMIT 1),
                    (a.best_snatch + 10)
                )
        END::INT
    FROM athletes a
    LEFT JOIN teams t ON a.team_id = t.id
    WHERE a.session_id = p_session_id
        AND a.is_dq = FALSE
    ORDER BY 
        CASE 
            WHEN p_phase = 'snatch' THEN a.lifting_order_snatch
            ELSE a.lifting_order_clean_jerk
        END ASC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 12. CREATE INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_current_phase ON sessions(current_phase);
CREATE INDEX IF NOT EXISTS idx_athletes_weighed_in ON athletes(weighed_in) WHERE weighed_in = FALSE;
CREATE INDEX IF NOT EXISTS idx_session_state_history_session_created 
ON session_state_history(session_id, created_at DESC);

-- =====================================================
-- 13. COMMENTS
-- =====================================================

COMMENT ON TYPE session_state IS 'Represents the state of a session in the optimized workflow';
COMMENT ON TYPE competition_phase IS 'Represents the current phase of competition (snatch or clean_jerk)';
COMMENT ON TABLE session_progression_locks IS 'Tracks which buttons should be enabled for each session based on state';
COMMENT ON TABLE session_state_history IS 'Audit trail of all session state transitions';
COMMENT ON FUNCTION validate_session_state_transition IS 'Validates if a state transition is allowed';
COMMENT ON FUNCTION update_session_state IS 'Updates session state with validation and audit logging';
COMMENT ON FUNCTION get_weigh_in_summary IS 'Returns weigh-in progress for a session';
COMMENT ON FUNCTION get_next_lifter IS 'Returns the next lifter for a given phase';
