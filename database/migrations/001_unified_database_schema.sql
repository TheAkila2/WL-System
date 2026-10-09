-- =====================================================
-- UNIFIED DATABASE SCHEMA - WL-System + Lifting Social Website
-- =====================================================
-- This migration creates a single unified database that serves both:
-- 1. Lifting Social Website (public-facing for athletes)
-- 2. WL-System (competition management for officials)
--
-- Run this in your Supabase SQL Editor
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- ENUM TYPES (if not already exist)
-- =====================================================

DO $$ BEGIN
    CREATE TYPE competition_status AS ENUM ('upcoming', 'active', 'completed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE session_status AS ENUM ('scheduled', 'in-progress', 'completed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE lift_type AS ENUM ('snatch', 'clean_and_jerk');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE attempt_result AS ENUM ('pending', 'good', 'no-lift');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE referee_decision AS ENUM ('good', 'no-lift');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE gender_type AS ENUM ('male', 'female');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'technical', 'referee', 'viewer', 'user');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =====================================================
-- WEBSITE USER ACCOUNTS (for public users/athletes)
-- =====================================================

CREATE TABLE IF NOT EXISTS website_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  avatar TEXT,
  phone VARCHAR(50),
  bio TEXT,
  date_of_birth DATE,
  gender VARCHAR(50),
  nationality VARCHAR(100),
  
  -- Athlete-specific fields
  federation_id VARCHAR(100),
  club_name VARCHAR(255),
  coach_name VARCHAR(255),
  
  -- Shipping address (JSON)
  shipping_address JSONB DEFAULT '{}',
  
  -- Billing address (JSON)
  billing_address JSONB DEFAULT '{}',
  
  -- Notifications (JSON)
  notifications JSONB DEFAULT '{"email": true, "orderUpdates": true, "programAlerts": true, "announcements": true}',
  
  -- Wishlist (array of product IDs)
  wishlist UUID[] DEFAULT '{}',
  
  -- Enrolled programs (JSON array)
  enrolled_programs JSONB DEFAULT '[]',
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- WL-SYSTEM ADMIN USERS (for competition officials)
-- =====================================================

CREATE TABLE IF NOT EXISTS wl_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role user_role DEFAULT 'viewer',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- COMPETITIONS (Central - used by both systems)
-- =====================================================

CREATE TABLE IF NOT EXISTS competitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE,
    description TEXT,
    date DATE NOT NULL,
    end_date DATE,
    location VARCHAR(255) NOT NULL,
    venue VARCHAR(255),
    organizer VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    
    -- Competition Status
    status competition_status DEFAULT 'upcoming',
    
    -- Website Display
    is_published BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,
    cover_image TEXT,
    
    -- Entry Configuration
    entry_fee DECIMAL(10, 2) DEFAULT 0,
    max_participants INTEGER,
    current_participants INTEGER DEFAULT 0,
    
    -- Weight Categories (JSON array)
    weight_categories JSONB DEFAULT '{"male": ["60", "65", "71", "79", "88", "94", "110", "+110"], "female": ["48", "53", "58", "63", "69", "77", "86", "+86"]}',
    
    -- Registration Period
    registration_open BOOLEAN DEFAULT false,
    registration_start TIMESTAMP WITH TIME ZONE,
    registration_end TIMESTAMP WITH TIME ZONE,
    
    -- Preliminary Entry Period
    preliminary_entry_open BOOLEAN DEFAULT false,
    preliminary_entry_start TIMESTAMP WITH TIME ZONE,
    preliminary_entry_end TIMESTAMP WITH TIME ZONE,
    
    -- Final Entry Period
    final_entry_open BOOLEAN DEFAULT false,
    final_entry_start TIMESTAMP WITH TIME ZONE,
    final_entry_end TIMESTAMP WITH TIME ZONE,
    
    -- Technical Meeting
    technical_meeting_date TIMESTAMP WITH TIME ZONE,
    lot_draw_completed BOOLEAN DEFAULT false,
    
    -- Rules and Requirements
    require_qualifying_total BOOLEAN DEFAULT false,
    require_medical_clearance BOOLEAN DEFAULT false,
    competition_rules TEXT,
    
    -- Sanctioning
    sanctioning_body VARCHAR(100), -- 'IWF', 'National Federation', etc.
    competition_level VARCHAR(50), -- 'local', 'regional', 'national', 'international'
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- TEAMS/CLUBS
-- =====================================================

CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    country VARCHAR(3) NOT NULL, -- ISO 3166-1 alpha-3 country code
    city VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    logo_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, country)
);

-- =====================================================
-- SESSIONS (Competition days/sessions within a competition)
-- =====================================================

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    session_number INTEGER DEFAULT 1,
    weight_category VARCHAR(10), -- e.g., '81', '89', '+109'
    weight_classes TEXT[], -- Array of weight classes for this session
    gender gender_type,
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    status session_status DEFAULT 'scheduled',
    current_lift lift_type DEFAULT 'snatch',
    weigh_in_start TIMESTAMP WITH TIME ZONE,
    weigh_in_end TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- EVENT REGISTRATIONS (Website users registering for competitions)
-- =====================================================

CREATE TABLE IF NOT EXISTS event_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES website_users(id) ON DELETE CASCADE,
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  
  -- Registration Status Flow
  status VARCHAR(50) DEFAULT 'registered' CHECK (
    status IN (
      'registered',           -- Initial registration
      'preliminary_pending',  -- Preliminary entry submitted, awaiting approval
      'preliminary_approved', -- Preliminary entry approved
      'final_pending',        -- Final entry submitted, awaiting approval
      'final_approved',       -- Final entry approved, ready for competition
      'payment_pending',      -- Awaiting payment
      'confirmed',            -- Fully confirmed
      'weighed_in',           -- Weigh-in completed
      'competing',            -- Currently competing
      'completed',            -- Competition completed
      'withdrawn',            -- Athlete withdrew
      'disqualified'          -- Disqualified
    )
  ),
  
  -- Basic Registration Info
  gender VARCHAR(50) NOT NULL,
  weight_category VARCHAR(50),
  date_of_birth DATE,
  nationality VARCHAR(100),
  
  -- Club/Federation Info
  club_name VARCHAR(255),
  federation_id VARCHAR(255),
  
  -- Coach Information
  coach_name VARCHAR(255),
  coach_phone VARCHAR(50),
  coach_email VARCHAR(255),
  
  -- Preliminary Entry Data (submitted 4 weeks before)
  entry_total INTEGER,           -- Best total for seeding
  best_snatch INTEGER,           -- Best snatch for seeding
  best_clean_jerk INTEGER,       -- Best C&J for seeding
  qualifying_total INTEGER,      -- Required for some competitions
  
  -- Final Entry Data (submitted 5-10 days before)
  confirmed_weight_category VARCHAR(50),
  snatch_opener INTEGER,         -- First snatch attempt
  cnj_opener INTEGER,            -- First C&J attempt
  
  -- Weigh-In Data (day of competition)
  actual_bodyweight DECIMAL(5,2),
  weigh_in_time TIMESTAMP WITH TIME ZONE,
  bodyweight_category_confirmed VARCHAR(50),
  
  -- Assignment (set by admin after approval)
  session_id UUID REFERENCES sessions(id),
  lot_number INTEGER,
  start_number INTEGER,
  group_number VARCHAR(50),
  
  -- Link to WL-System athlete (created when final entry approved)
  wl_athlete_id UUID,
  
  -- Medical & Documentation
  medical_clearance BOOLEAN DEFAULT false,
  medical_clearance_date TIMESTAMP WITH TIME ZONE,
  medical_document_url TEXT,
  
  -- Payment Information
  payment_status VARCHAR(50) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded', 'waived')),
  payment_amount DECIMAL(10, 2),
  payment_method VARCHAR(100),
  payment_date TIMESTAMP WITH TIME ZONE,
  payment_transaction_id VARCHAR(255),
  
  -- Admin Notes
  admin_notes TEXT,
  athlete_notes TEXT,
  withdrawal_reason TEXT,
  
  -- Timestamps
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  preliminary_submitted_at TIMESTAMP WITH TIME ZONE,
  preliminary_approved_at TIMESTAMP WITH TIME ZONE,
  final_submitted_at TIMESTAMP WITH TIME ZONE,
  final_approved_at TIMESTAMP WITH TIME ZONE,
  confirmed_at TIMESTAMP WITH TIME ZONE,
  withdrawn_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(user_id, competition_id) -- Prevent duplicate registrations
);

-- =====================================================
-- ATHLETES (WL-System athletes for competition)
-- =====================================================

CREATE TABLE IF NOT EXISTS athletes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Link to website registration
    registration_id UUID REFERENCES event_registrations(id) ON DELETE SET NULL,
    website_user_id UUID REFERENCES website_users(id) ON DELETE SET NULL,
    
    -- Athlete Info
    name VARCHAR(255) NOT NULL,
    country VARCHAR(3) NOT NULL, -- ISO 3166-1 alpha-3 country code
    birth_date DATE,
    gender gender_type NOT NULL,
    weight_category VARCHAR(10) NOT NULL,
    body_weight DECIMAL(5,2), -- kg with 2 decimal places
    
    -- Team/Club
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    coach_name VARCHAR(255),
    
    -- Competition Assignment
    start_number INTEGER,
    lot_number INTEGER,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    
    -- Opening Attempts (from final entry)
    snatch_opener INTEGER,
    cnj_opener INTEGER,
    
    -- Calculated fields (updated by triggers)
    best_snatch INTEGER DEFAULT 0,
    best_clean_and_jerk INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    sinclair_total DECIMAL(8,2) DEFAULT 0,
    rank INTEGER,
    
    -- Medal and timing fields
    medal VARCHAR(10), -- 'gold', 'silver', 'bronze', or NULL
    total_completed_at TIMESTAMP WITH TIME ZONE,
    medal_manual_override BOOLEAN DEFAULT false,
    
    -- Additional IWF fields
    id_number VARCHAR(100),
    registration_number VARCHAR(100),
    best_total INTEGER, -- Historical best
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CHECK (body_weight > 0 OR body_weight IS NULL),
    CHECK (start_number > 0 OR start_number IS NULL)
);

-- =====================================================
-- ATTEMPTS
-- =====================================================

CREATE TABLE IF NOT EXISTS attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    lift_type lift_type NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
    weight INTEGER NOT NULL CHECK (weight > 0),
    result attempt_result DEFAULT 'pending',
    
    -- Referee decisions
    referee_left referee_decision,
    referee_center referee_decision,
    referee_right referee_decision,
    
    -- Jury override
    jury_override BOOLEAN DEFAULT false,
    jury_decision attempt_result,
    
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(athlete_id, lift_type, attempt_number)
);

-- =====================================================
-- WEBSITE ADDITIONAL TABLES
-- =====================================================

-- Featured Athletes (for website display - different from competition athletes)
CREATE TABLE IF NOT EXISTS featured_athletes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  bio TEXT,
  image TEXT,
  category VARCHAR(100),
  gender VARCHAR(50),
  snatch INTEGER,
  clean_and_jerk INTEGER,
  total INTEGER,
  achievements TEXT,
  gold_medals INTEGER DEFAULT 0,
  silver_medals INTEGER DEFAULT 0,
  bronze_medals INTEGER DEFAULT 0,
  instagram VARCHAR(255),
  facebook VARCHAR(255),
  featured BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Coaches
CREATE TABLE IF NOT EXISTS coaches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  bio TEXT NOT NULL,
  specializations TEXT[] DEFAULT '{}',
  certifications TEXT[] DEFAULT '{}',
  experience INTEGER NOT NULL DEFAULT 0,
  availability VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  image TEXT,
  featured BOOLEAN DEFAULT false,
  champions_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products (for shop)
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  compare_price DECIMAL(10, 2),
  image TEXT,
  images TEXT[] DEFAULT '{}',
  description TEXT,
  category VARCHAR(100),
  inventory INTEGER DEFAULT 0,
  in_stock BOOLEAN DEFAULT true,
  featured BOOLEAN DEFAULT false,
  sizes TEXT[] DEFAULT '{}',
  colors TEXT[] DEFAULT '{}',
  material VARCHAR(255),
  care TEXT,
  features TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES website_users(id) ON DELETE CASCADE,
  order_number VARCHAR(100) UNIQUE NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  subtotal DECIMAL(10, 2) NOT NULL,
  tax DECIMAL(10, 2) DEFAULT 0,
  shipping_fee DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  shipping_address JSONB NOT NULL,
  billing_address JSONB NOT NULL,
  payment_method VARCHAR(100) NOT NULL,
  payment_status VARCHAR(50) DEFAULT 'pending',
  order_status VARCHAR(50) DEFAULT 'pending',
  payment_id VARCHAR(255),
  tracking_number VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stories/Blog
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) UNIQUE NOT NULL,
  excerpt TEXT,
  content TEXT,
  author VARCHAR(255),
  cover_image TEXT,
  image TEXT,
  category VARCHAR(100),
  category_color VARCHAR(50),
  tags TEXT[] DEFAULT '{}',
  read_time VARCHAR(50),
  views INTEGER DEFAULT 0,
  video_id VARCHAR(255),
  featured BOOLEAN DEFAULT false,
  published_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Training Programs
CREATE TABLE IF NOT EXISTS programs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  coach_id UUID REFERENCES coaches(id),
  duration_weeks INTEGER,
  level VARCHAR(50), -- 'beginner', 'intermediate', 'advanced'
  price DECIMAL(10, 2),
  image TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- SYNC/AUDIT LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL,
  registration_id UUID REFERENCES event_registrations(id) ON DELETE SET NULL,
  athlete_id UUID REFERENCES athletes(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL, -- 'registration_approved', 'athlete_created', 'results_synced', etc.
  from_system VARCHAR(50), -- 'website', 'wl_system'
  to_system VARCHAR(50),
  data JSONB,
  status VARCHAR(50) DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Competitions
CREATE INDEX IF NOT EXISTS idx_competitions_slug ON competitions(slug);
CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status);
CREATE INDEX IF NOT EXISTS idx_competitions_date ON competitions(date);
CREATE INDEX IF NOT EXISTS idx_competitions_published ON competitions(is_published);

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_competition ON sessions(competition_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- Event Registrations
CREATE INDEX IF NOT EXISTS idx_registrations_user ON event_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_registrations_competition ON event_registrations(competition_id);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON event_registrations(status);
CREATE INDEX IF NOT EXISTS idx_registrations_wl_athlete ON event_registrations(wl_athlete_id);

-- Athletes
CREATE INDEX IF NOT EXISTS idx_athletes_session ON athletes(session_id);
CREATE INDEX IF NOT EXISTS idx_athletes_registration ON athletes(registration_id);
CREATE INDEX IF NOT EXISTS idx_athletes_rank ON athletes(rank) WHERE rank IS NOT NULL;

-- Attempts
CREATE INDEX IF NOT EXISTS idx_attempts_athlete ON attempts(athlete_id);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_timestamp ON attempts(timestamp);

-- Website Users
CREATE INDEX IF NOT EXISTS idx_website_users_email ON website_users(email);

-- Teams
CREATE INDEX IF NOT EXISTS idx_teams_country ON teams(country);

-- =====================================================
-- FUNCTIONS FOR UNIFIED SYSTEM
-- =====================================================

-- Function to generate slug from name
CREATE OR REPLACE FUNCTION generate_slug(name TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to create athlete from approved registration
CREATE OR REPLACE FUNCTION create_athlete_from_registration(p_registration_id UUID)
RETURNS UUID AS $$
DECLARE
    v_registration RECORD;
    v_user RECORD;
    v_athlete_id UUID;
    v_team_id UUID;
    v_session_id UUID;
BEGIN
    -- Get registration details
    SELECT * INTO v_registration FROM event_registrations WHERE id = p_registration_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration not found';
    END IF;
    
    -- Get user details
    SELECT * INTO v_user FROM website_users WHERE id = v_registration.user_id;
    
    -- Find or create team if club name provided
    IF v_registration.club_name IS NOT NULL AND v_registration.club_name != '' THEN
        SELECT id INTO v_team_id FROM teams WHERE name = v_registration.club_name LIMIT 1;
        IF NOT FOUND THEN
            INSERT INTO teams (name, country)
            VALUES (v_registration.club_name, COALESCE(SUBSTRING(v_registration.nationality FROM 1 FOR 3), 'UNK'))
            RETURNING id INTO v_team_id;
        END IF;
    END IF;
    
    -- Get session if assigned
    v_session_id := v_registration.session_id;
    
    -- Create athlete
    INSERT INTO athletes (
        registration_id,
        website_user_id,
        name,
        country,
        birth_date,
        gender,
        weight_category,
        team_id,
        coach_name,
        session_id,
        lot_number,
        start_number,
        snatch_opener,
        cnj_opener
    ) VALUES (
        p_registration_id,
        v_registration.user_id,
        v_user.name,
        COALESCE(SUBSTRING(v_registration.nationality FROM 1 FOR 3), 'UNK'),
        COALESCE(v_registration.date_of_birth, v_user.date_of_birth),
        v_registration.gender::gender_type,
        COALESCE(v_registration.confirmed_weight_category, v_registration.weight_category),
        v_team_id,
        v_registration.coach_name,
        v_session_id,
        v_registration.lot_number,
        v_registration.start_number,
        v_registration.snatch_opener,
        v_registration.cnj_opener
    )
    RETURNING id INTO v_athlete_id;
    
    -- Update registration with athlete ID
    UPDATE event_registrations
    SET wl_athlete_id = v_athlete_id,
        status = 'final_approved',
        final_approved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_registration_id;
    
    -- Log the sync
    INSERT INTO sync_log (registration_id, athlete_id, competition_id, action, from_system, to_system, status)
    VALUES (p_registration_id, v_athlete_id, v_registration.competition_id, 'athlete_created', 'website', 'wl_system', 'success');
    
    RETURN v_athlete_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate competition slug
CREATE OR REPLACE FUNCTION trigger_generate_competition_slug()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := generate_slug(NEW.name) || '-' || EXTRACT(YEAR FROM NEW.date);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generate_competition_slug ON competitions;
CREATE TRIGGER generate_competition_slug
    BEFORE INSERT ON competitions
    FOR EACH ROW
    EXECUTE FUNCTION trigger_generate_competition_slug();

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers to all tables
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name IN ('competitions', 'sessions', 'athletes', 'attempts', 'teams', 
                           'event_registrations', 'website_users', 'wl_users', 'products', 
                           'orders', 'stories', 'coaches', 'programs', 'featured_athletes')
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS update_%I_updated_at ON %I', t, t);
        EXECUTE format('CREATE TRIGGER update_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t, t);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS FOR UNIFIED ACCESS
-- =====================================================

-- View: Competitions with registration counts
CREATE OR REPLACE VIEW competition_overview AS
SELECT 
    c.*,
    (SELECT COUNT(*) FROM event_registrations er WHERE er.competition_id = c.id) as total_registrations,
    (SELECT COUNT(*) FROM event_registrations er WHERE er.competition_id = c.id AND er.status = 'registered') as pending_registrations,
    (SELECT COUNT(*) FROM event_registrations er WHERE er.competition_id = c.id AND er.status = 'preliminary_approved') as preliminary_approved,
    (SELECT COUNT(*) FROM event_registrations er WHERE er.competition_id = c.id AND er.status = 'final_approved') as final_approved,
    (SELECT COUNT(*) FROM event_registrations er WHERE er.competition_id = c.id AND er.status IN ('confirmed', 'weighed_in', 'competing', 'completed')) as confirmed_athletes,
    (SELECT COUNT(*) FROM sessions s WHERE s.competition_id = c.id) as total_sessions,
    (SELECT COUNT(*) FROM athletes a WHERE a.session_id IN (SELECT id FROM sessions WHERE competition_id = c.id)) as total_athletes
FROM competitions c;

-- View: Registration details with user info
CREATE OR REPLACE VIEW registration_details AS
SELECT 
    er.*,
    u.name as user_name,
    u.email as user_email,
    u.phone as user_phone,
    u.avatar as user_avatar,
    c.name as competition_name,
    c.date as competition_date,
    c.location as competition_location,
    s.name as session_name,
    s.start_time as session_start_time,
    a.id as athlete_id,
    a.best_snatch as athlete_best_snatch,
    a.best_clean_and_jerk,
    a.total as competition_total,
    a.rank as competition_rank,
    a.medal
FROM event_registrations er
JOIN website_users u ON er.user_id = u.id
JOIN competitions c ON er.competition_id = c.id
LEFT JOIN sessions s ON er.session_id = s.id
LEFT JOIN athletes a ON er.wl_athlete_id = a.id;

-- =====================================================
-- ROW LEVEL SECURITY (Optional)
-- =====================================================

-- Enable RLS on sensitive tables
ALTER TABLE website_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_registrations ENABLE ROW LEVEL SECURITY;

-- Public read access for competitions
ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read competitions" ON competitions FOR SELECT USING (is_published = true);
CREATE POLICY "Admin full access competitions" ON competitions FOR ALL USING (true); -- Adjust based on your auth

-- Public read for athletes during competition
ALTER TABLE athletes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read athletes" ON athletes FOR SELECT USING (true);

-- Public read for attempts
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read attempts" ON attempts FOR SELECT USING (true);

-- =====================================================
-- INITIAL ADMIN USER (change password after setup)
-- =====================================================

INSERT INTO wl_users (email, password, name, role, is_active)
VALUES ('admin@wlsystem.com', '$2b$10$placeholder_hash_change_me', 'System Admin', 'admin', true)
ON CONFLICT (email) DO NOTHING;

-- =====================================================
-- NOTES
-- =====================================================
-- 1. Both systems now share the same database
-- 2. Competitions created in WL-System appear on website
-- 3. Website registrations are visible in WL-System
-- 4. When admin approves final entry, athlete is created for competition
-- 5. All sync operations are logged in sync_log table
-- =====================================================
