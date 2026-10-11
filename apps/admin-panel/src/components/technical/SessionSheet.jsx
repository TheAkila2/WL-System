import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { Download, RefreshCw, ArrowLeft, Timer, Check, Trash2, Unlock, Monitor, Maximize2, Minimize2 } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import AttemptCell from './AttemptCell';
import socketService from '../../services/socket';
import { supabase } from '../../services/supabaseClient';
import CompetitionTimer from './CompetitionTimer';
import WeighInModal from './WeighInModal';
import PhaseControlButtons from './PhaseControlButtons';

const ENABLE_SYSTEM_RECOMMENDATION = true;

export default function SessionSheet({ session: initialSession, onBack, onToggleFullscreen, isFullscreen, browserFullscreen, readOnly = false }) {
  const [athletes, setAthletes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [autoSaveTimeout, setAutoSaveTimeout] = useState(null);
  const [session, setSession] = useState(initialSession);
  const [error, setError] = useState(null);
  const [lastUpdateSource, setLastUpdateSource] = useState(null);
  const [nextLifter, setNextLifter] = useState(null);
  const [previousLifter, setPreviousLifter] = useState(null); // Track previous lifter for timer duration
  const [timerDuration, setTimerDuration] = useState(60); // IWF: 60s or 120s
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerKey, setTimerKey] = useState(0); // Force timer reset
  const [forceEditMode, setForceEditMode] = useState(false); // Force edit mode to bypass restrictions
  const [showWeighInModal, setShowWeighInModal] = useState(false); // Phase 2: Weigh-in modal state
  const [selectedWeightClass, setSelectedWeightClass] = useState(null); // Multi-class: selected weight class
  const [availableWeightClasses, setAvailableWeightClasses] = useState([]); // Multi-class: all weight classes in session
  const [previousAthleteId, setPreviousAthleteId] = useState(null); // Track athlete ID for timer logic
  const [tableScale, setTableScale] = useState(1); // Scale sheet to fit fullscreen vertically
  const [recommendationEnabled, setRecommendationEnabled] = useState(true); // Toggle system recommendation
  const tableWrapperRef = useRef(null);
  const tableRef = useRef(null);

  const recommendationsOn = !readOnly && ENABLE_SYSTEM_RECOMMENDATION && recommendationEnabled;

  const sessionId = session?.id;

  const getAthleteTeamCode = (athlete) => {
    const team = athlete?.team || athlete?.teams;

    return (
      team?.code ||
      team?.country_code ||
      team?.country ||
      athlete?.team_code ||
      athlete?.country_code ||
      athlete?.country ||
      '-'
    );
  };

  const hasCompletedWeighIn = (athlete) => {
    return Boolean(
      athlete?.weigh_in_completed_at ||
      athlete?.weighed_in ||
      athlete?.weigh_in_status === 'completed'
    );
  };

  const getWeightCategoryValue = (weightCategory) => {
    if (!weightCategory || typeof weightCategory !== 'string') {
      return Number.POSITIVE_INFINITY;
    }

    const normalized = weightCategory.trim();
    const isPlusClass = normalized.startsWith('+');
    const numericPart = parseFloat(normalized.replace(/[^\d.]/g, ''));

    if (Number.isNaN(numericPart)) {
      return Number.POSITIVE_INFINITY;
    }

    // Super-heavy classes (e.g. +109) should sort after capped classes.
    return isPlusClass ? numericPart + 1000 : numericPart;
  };

  // Calculate best lifts and totals for each athlete
  const calculateResults = (athletesData) => {
    return athletesData.map(athlete => {
      const snatchAttempts = athlete.attempts?.filter(a => a.lift_type === 'snatch') || [];
      const cjAttempts = athlete.attempts?.filter(a => a.lift_type === 'clean_and_jerk') || [];

      const goodSnatch = snatchAttempts.filter(a => a.result === 'good');
      const goodCJ = cjAttempts.filter(a => a.result === 'good');

      const bestSnatch = goodSnatch.length > 0 
        ? Math.max(...goodSnatch.map(a => a.weight || a.requested_weight || 0))
        : 0;
      
      const bestCleanJerk = goodCJ.length > 0
        ? Math.max(...goodCJ.map(a => a.weight || a.requested_weight || 0))
        : 0;

      const total = (bestSnatch > 0 && bestCleanJerk > 0) ? bestSnatch + bestCleanJerk : 0;

      return {
        ...athlete,
        bestSnatch,
        bestCleanJerk,
        total,
        is_dq: athlete.is_dq || false
      };
    });
  };

  // Calculate rankings (without reordering rows, DQ athletes at bottom)
  const calculateRankings = (athletesData) => {
    const withResults = calculateResults(athletesData);
    
    // Separate DQ and active athletes
    const activeAthletes = withResults.filter(a => !a.is_dq);
    const dqAthletes = withResults.filter(a => a.is_dq);
    
    // Group active athletes by weight class for separate ranking
    const athletesByClass = {};
    activeAthletes.forEach(athlete => {
      const wc = athlete.weight_category;
      if (!athletesByClass[wc]) {
        athletesByClass[wc] = [];
      }
      athletesByClass[wc].push(athlete);
    });

    // Create rank map with per-class rankings
    const rankMap = {};
    Object.keys(athletesByClass).forEach(weightClass => {
      // Sort athletes within this weight class
      const classAthletes = athletesByClass[weightClass].slice().sort((a, b) => {
        if (a.total !== b.total) return b.total - a.total;
        if (a.bodyweight !== b.bodyweight) return a.bodyweight - b.bodyweight;
        return (a.start_number || 0) - (b.start_number || 0);
      });
      
      // Assign ranks within this class
      classAthletes.forEach((athlete, index) => {
        rankMap[athlete.id] = athlete.total > 0 ? index + 1 : null;
      });
    });

    // Return active athletes in original order with calculated ranks, then DQ athletes at bottom
    const activeWithRanks = activeAthletes.map(athlete => ({
      ...athlete,
      rank: rankMap[athlete.id] || null
    }));

    // DQ athletes with no rank
    const dqWithRanks = dqAthletes.map(athlete => ({
      ...athlete,
      rank: null
    }));

    return [...activeWithRanks, ...dqWithRanks];
  };

  // Calculate next lifter based on IWF rules
  const calculateNextLifter = useCallback((athletesData, currentPhase = null) => {
    if (!athletesData || athletesData.length === 0) return null;

    const activeAthletes = athletesData.filter(a => !a.is_dq);
    if (activeAthletes.length === 0) return null;

    // Collect all pending attempts with their details
    const pendingAttempts = [];

    activeAthletes.forEach(athlete => {
      // Determine which lift type to check based on current phase
      let skipSnatch = false;
      let skipCJ = false;

      // If in clean_jerk_active phase, prioritize C&J and ignore snatch
      if (currentPhase === 'clean_jerk_active') {
        skipSnatch = true;
      }
      // If in snatch_active phase, prioritize snatch and ignore C&J
      else if (currentPhase === 'snatch_active') {
        skipCJ = true;
      }

      // Check snatch attempts (1, 2, 3)
      let hasSnatchPending = false;
      if (!skipSnatch) {
        for (let attemptNum = 1; attemptNum <= 3; attemptNum++) {
          const snatchAttempt = athlete.attempts?.find(
            a => a.lift_type === 'snatch' && a.attempt_number === attemptNum
          );
          
          // If attempt doesn't exist or is pending, it's next for this athlete
          if (!snatchAttempt || snatchAttempt.result === 'pending') {
            const weight = snatchAttempt?.weight || snatchAttempt?.requested_weight || athlete.opening_snatch || 0;
            if (weight > 0) {
              pendingAttempts.push({
                athlete,
                liftType: 'snatch',
                attemptNumber: attemptNum,
                weight,
                displayName: athlete.name || 'Unknown'
              });
              hasSnatchPending = true;
            }
            break; // Only consider the first pending attempt for this lift type
          }
        }
      }

      // Check clean & jerk attempts (1, 2, 3) - only if no pending snatch attempts (or in C&J phase)
      if (!skipCJ && (!hasSnatchPending || currentPhase === 'clean_jerk_active')) {
        for (let attemptNum = 1; attemptNum <= 3; attemptNum++) {
          const cjAttempt = athlete.attempts?.find(
            a => a.lift_type === 'clean_and_jerk' && a.attempt_number === attemptNum
          );
          
          if (!cjAttempt || cjAttempt.result === 'pending') {
            const weight = cjAttempt?.weight || cjAttempt?.requested_weight || athlete.opening_clean_jerk || 0;
            if (weight > 0) {
              pendingAttempts.push({
                athlete,
                liftType: 'clean_and_jerk',
                attemptNumber: attemptNum,
                weight,
                displayName: athlete.name || 'Unknown'
              });
            }
            break;
          }
        }
      }
    });

    if (pendingAttempts.length === 0) return null;

    // Sort by IWF rules:
    // 1. For current phase: same lift type comes first
    // 2. Lower weight first (ascending)
    // 3. Lower weight class first when weight is equal
    // 4. Lower attempt number first
    // 5. Lower start number first (tie-breaker)
    pendingAttempts.sort((a, b) => {
      // If in specific phase, prioritize that lift type
      if (currentPhase === 'clean_jerk_active' || currentPhase === 'snatch_active') {
        // Same lift type, sort by weight
        if (a.liftType === b.liftType) {
          if (a.weight !== b.weight) return a.weight - b.weight;
          const wcA = getWeightCategoryValue(a.athlete.weight_category);
          const wcB = getWeightCategoryValue(b.athlete.weight_category);
          if (wcA !== wcB) return wcA - wcB;
          if (a.attemptNumber !== b.attemptNumber) return a.attemptNumber - b.attemptNumber;
          return (a.athlete.start_number || 0) - (b.athlete.start_number || 0);
        }
        // Different lift types
        return 0; // Only one type should be in pendingAttempts in active phase
      }

      // Normal flow (multiple phases): Snatch before C&J
      if (a.liftType !== b.liftType) {
        return a.liftType === 'snatch' ? -1 : 1;
      }
      // Lower weight first
      if (a.weight !== b.weight) {
        return a.weight - b.weight;
      }
      // Lower weight class first when requested weight is tied
      const wcA = getWeightCategoryValue(a.athlete.weight_category);
      const wcB = getWeightCategoryValue(b.athlete.weight_category);
      if (wcA !== wcB) {
        return wcA - wcB;
      }
      // Lower attempt number first
      if (a.attemptNumber !== b.attemptNumber) {
        return a.attemptNumber - b.attemptNumber;
      }
      // Lower start number first (tie-breaker)
      return (a.athlete.start_number || 0) - (b.athlete.start_number || 0);
    });

    return pendingAttempts[0];
  }, []);

  // Update timer when next lifter changes (IWF Rules)
  useEffect(() => {
    if (nextLifter && nextLifter.athlete) {
      // IWF Rule 6.6.3 & 6.6.4:
      // - 60 seconds for first attempt or when switching athletes
      // - 120 seconds for consecutive attempts by same athlete
      const currentAthleteId = nextLifter.athlete.id;
      let duration = 60;
      
      console.log('🏋️ Next Lifter:', currentAthleteId, nextLifter.displayName);
      console.log('📋 Previous Athlete ID:', previousAthleteId);
      
      // Check if same athlete as previous
      if (previousAthleteId && previousAthleteId === currentAthleteId) {
        // Same athlete, consecutive attempt - 120 seconds
        duration = 120;
        console.log('⏱️ SAME ATHLETE - Setting timer to 120s');
      } else {
        // Different athlete or first lifter - 60 seconds
        console.log('⏱️ DIFFERENT ATHLETE - Setting timer to 60s');
      }
      
      setTimerDuration(duration);
      setTimerKey(prev => prev + 1); // Reset timer
      setTimerRunning(false); // Don't auto-start, official will start manually
      
      // Update previous athlete ID for next comparison
      setPreviousAthleteId(currentAthleteId);
    }
  }, [nextLifter]);

  // Load session data
  const fetchSessionData = useCallback(async ({ silent = false } = {}) => {
    if (!sessionId) return;

    try {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      
      console.log('🔄 Fetching session data for sessionId:', sessionId);
      
      const response = await api.get(`/technical/sessions/${sessionId}/sheet`);
      
      // Handle API response format: {success: true, data: [...athletes]}
      let athletesData = [];
      if (response.data.success && Array.isArray(response.data.data)) {
        athletesData = response.data.data;
      } else if (Array.isArray(response.data.athletes)) {
        athletesData = response.data.athletes;
      } else if (Array.isArray(response.data)) {
        athletesData = response.data;
      }
      
      // Validate that we got data - if empty, keep existing data
      if (!athletesData || athletesData.length === 0) {
        console.warn('⚠️ API returned empty athletes data, keeping existing data');
        if (!silent) setLoading(false);
        return;
      }
      
      // Transform snatch_attempts and clean_jerk_attempts to attempts array
      const transformedAthletes = athletesData.map(athlete => {
        const attempts = [];
        
        // Add snatch attempts
        if (Array.isArray(athlete.snatch_attempts)) {
          attempts.push(...athlete.snatch_attempts.map(a => ({
            ...a,
            lift_type: 'snatch'
          })));
        }
        
        // Add clean & jerk attempts
        if (Array.isArray(athlete.clean_jerk_attempts)) {
          attempts.push(...athlete.clean_jerk_attempts.map(a => ({
            ...a,
            lift_type: 'clean_and_jerk'
          })));
        }
        
        return {
          ...athlete,
          attempts: attempts
        };
      });
      
      const weighedInAthletes = transformedAthletes.filter(hasCompletedWeighIn);

      console.log('📊 Athletes loaded:', transformedAthletes.length);
      console.log('⚖️ Weigh-in completed athletes:', weighedInAthletes.length);
      
      // Extract available weight classes from athletes (for reference only, not for filtering)
      const uniqueWeightClasses = [...new Set(weighedInAthletes.map(a => a.weight_category))].sort();
      setAvailableWeightClasses(uniqueWeightClasses);
      
      // Don't filter by weight class - show all classes in one sheet
      
      const withCalculations = calculateRankings(weighedInAthletes);
      setAthletes(withCalculations);
      
      const next = recommendationsOn
        ? calculateNextLifter(withCalculations, session?.state)
        : null;
      setNextLifter(next);
      
    } catch (error) {
      console.error('❌ Error fetching session data:', error);
      if (!silent) {
        setError(error.message || 'Failed to load session data');
        toast.error('Failed to load session data');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [sessionId, recommendationsOn]);

  // Auto-refresh for read-only display screens (e.g. the Scoreboard venue display),
  // since SessionSheet otherwise only refetches in response to local user actions.
  // Scoped to readOnly so the Technical Panel's live editing is never interrupted
  // by a background refetch resetting focus/in-progress input.
  useEffect(() => {
    if (!readOnly || !sessionId) return;

    const interval = setInterval(() => fetchSessionData({ silent: true }), 3000);

    const channel = supabase
      .channel(`sheet-readonly-${sessionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attempts', filter: `session_id=eq.${sessionId}` },
        () => fetchSessionData({ silent: true })
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'athletes', filter: `session_id=eq.${sessionId}` },
        () => fetchSessionData({ silent: true })
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [readOnly, sessionId, fetchSessionData]);

  // Small "called to platform" clock for the Technical Panel's fullscreen header —
  // mirrors the Intro screen's countdown so the operator can see remaining time
  // without switching to the venue display.
  const [callClock, setCallClock] = useState(null); // { athleteName, calledAt, durationSeconds }
  const [callTimeRemaining, setCallTimeRemaining] = useState(null);

  const applyCallClock = useCallback(async (sessionRow) => {
    if (!sessionRow?.current_call_athlete_id) {
      setCallClock(null);
      return;
    }
    try {
      const res = await api.get(`/athletes/${sessionRow.current_call_athlete_id}`);
      setCallClock({
        athleteName: res.data.data?.name || 'Athlete',
        calledAt: sessionRow.current_call_at,
        durationSeconds: sessionRow.current_call_duration_seconds || 60,
      });
    } catch (err) {
      console.error('Failed to load called athlete for clock:', err);
    }
  }, []);

  useEffect(() => {
    if (readOnly || !sessionId) return;

    api.get(`/sessions/${sessionId}`).then((res) => applyCallClock(res.data.data)).catch(() => {});

    const channel = supabase
      .channel(`sheet-callclock-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => applyCallClock(payload.new)
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [readOnly, sessionId, applyCallClock]);

  useEffect(() => {
    if (!callClock?.calledAt) {
      setCallTimeRemaining(null);
      return;
    }
    const calledAtMs = new Date(callClock.calledAt).getTime();
    const tick = () => {
      const elapsed = (Date.now() - calledAtMs) / 1000;
      setCallTimeRemaining(Math.max(0, Math.ceil(callClock.durationSeconds - elapsed)));
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [callClock]);

  const callClockBadge = !readOnly && callClock && callTimeRemaining !== null && (
    <div
      className={`flex items-center gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg border text-xs sm:text-sm font-mono font-bold tabular-nums ${
        callTimeRemaining === 0 || callTimeRemaining <= 10
          ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse'
          : 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-zinc-600 text-slate-700 dark:text-zinc-200'
      }`}
      title={`${callClock.athleteName} — called to platform`}
    >
      <Timer size={12} className="sm:w-3.5 sm:h-3.5 shrink-0" />
      <span className="hidden sm:inline truncate max-w-[120px]">{callClock.athleteName}</span>
      <span>
        {callTimeRemaining === 0
          ? 'TIME'
          : `${Math.floor(callTimeRemaining / 60)}:${String(callTimeRemaining % 60).padStart(2, '0')}`}
      </span>
    </div>
  );

  // Interval / break timer — a 10-minute countdown the Technical Panel can
  // toggle on/off. While active, the readOnly Scoreboard screen is fully
  // replaced with a full-screen countdown instead of the attempt grid.
  const [intervalTimer, setIntervalTimer] = useState(null); // { active, startedAt, durationSeconds }
  const [intervalTimeRemaining, setIntervalTimeRemaining] = useState(null);
  // Default screen — a blank white takeover (centered logo) for the Scoreboard
  // when there's nothing live to show between sessions.
  const [defaultScreenActive, setDefaultScreenActive] = useState(false);

  const applyIntervalTimer = useCallback((sessionRow) => {
    if (!sessionRow) return;
    setIntervalTimer({
      active: !!sessionRow.interval_timer_active,
      startedAt: sessionRow.interval_timer_started_at,
      durationSeconds: sessionRow.interval_timer_duration_seconds || 600,
    });
    setDefaultScreenActive(!!sessionRow.default_screen_active);
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    api.get(`/sessions/${sessionId}`).then((res) => applyIntervalTimer(res.data.data)).catch(() => {});

    const channel = supabase
      .channel(`sheet-intervaltimer-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => applyIntervalTimer(payload.new)
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [sessionId, applyIntervalTimer]);

  useEffect(() => {
    if (!intervalTimer?.active || !intervalTimer?.startedAt) {
      setIntervalTimeRemaining(null);
      return;
    }
    const startedMs = new Date(intervalTimer.startedAt).getTime();
    const tick = () => {
      const elapsed = (Date.now() - startedMs) / 1000;
      setIntervalTimeRemaining(Math.max(0, Math.ceil(intervalTimer.durationSeconds - elapsed)));
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [intervalTimer]);

  const handleToggleIntervalTimer = async () => {
    if (!sessionId) return;
    try {
      if (intervalTimer?.active) {
        await api.post(`/sessions/${sessionId}/interval-timer/stop`);
      } else {
        await api.post(`/sessions/${sessionId}/interval-timer/start`, { durationSeconds: 600 });
      }
    } catch (err) {
      console.error('Failed to toggle interval timer:', err);
      toast.error('Failed to toggle interval timer');
    }
  };

  const intervalTimerButton = !readOnly && (
    <button
      onClick={handleToggleIntervalTimer}
      className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors ${
        intervalTimer?.active
          ? 'bg-red-600 hover:bg-red-700 text-white'
          : 'bg-slate-700 hover:bg-slate-600 text-white'
      }`}
      title={intervalTimer?.active ? 'Stop interval timer (Scoreboard returns to normal)' : 'Start 10-minute interval timer (takes over Scoreboard)'}
    >
      <Timer size={14} className="shrink-0" />
      <span className="hidden sm:inline">{intervalTimer?.active ? 'Stop Timer' : '10 Min Timer'}</span>
    </button>
  );

  const handleToggleDefaultScreen = async () => {
    if (!sessionId) return;
    try {
      if (defaultScreenActive) {
        await api.post(`/sessions/${sessionId}/default-screen/stop`);
      } else {
        await api.post(`/sessions/${sessionId}/default-screen/start`);
      }
    } catch (err) {
      console.error('Failed to toggle default screen:', err);
      toast.error('Failed to toggle default screen');
    }
  };

  const defaultScreenButton = !readOnly && (
    <button
      onClick={handleToggleDefaultScreen}
      className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors ${
        defaultScreenActive
          ? 'bg-red-600 hover:bg-red-700 text-white'
          : 'bg-slate-700 hover:bg-slate-600 text-white'
      }`}
      title={defaultScreenActive ? 'Stop default screen (Scoreboard returns to normal)' : 'Show blank default screen on Scoreboard'}
    >
      <Monitor size={14} className="shrink-0" />
      <span className="hidden sm:inline">{defaultScreenActive ? 'Stop Default' : 'Default Screen'}</span>
    </button>
  );

  const intervalTimerBadge = !readOnly && intervalTimer?.active && intervalTimeRemaining !== null && (
    <div
      className={`flex items-center gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg border text-xs sm:text-sm font-mono font-bold tabular-nums ${
        intervalTimeRemaining === 0 || intervalTimeRemaining <= 10
          ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse'
          : 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-zinc-600 text-slate-700 dark:text-zinc-200'
      }`}
      title="Break timer"
    >
      <Timer size={12} className="sm:w-3.5 sm:h-3.5 shrink-0" />
      <span className="hidden sm:inline">Break</span>
      <span>
        {intervalTimeRemaining === 0
          ? 'TIME'
          : `${Math.floor(intervalTimeRemaining / 60)}:${String(intervalTimeRemaining % 60).padStart(2, '0')}`}
      </span>
    </div>
  );

  // Handle attempt update (from AttemptCell)
  const handleAttemptUpdate = async (attemptData) => {
    try {
      console.log('💾 Updating attempt:', attemptData);
      setSaving(true);

      // Optimistic update
      const updatedAthletes = athletes.map(athlete => {
        if (athlete.id === attemptData.athlete_id) {
          const updatedAttempts = athlete.attempts?.map(a => {
            if (a.lift_type === attemptData.lift_type && 
                a.attempt_number === attemptData.attempt_number) {
              return { ...a, ...attemptData };
            }
            return a;
          }) || [];

          // If attempt doesn't exist, add it
          const attemptExists = updatedAttempts.some(
            a => a.lift_type === attemptData.lift_type && 
                 a.attempt_number === attemptData.attempt_number
          );

          if (!attemptExists) {
            updatedAttempts.push({
              ...attemptData,
              athlete_id: athlete.id,
              session_id: sessionId
            });
          }

          return {
            ...athlete,
            attempts: updatedAttempts
          };
        }
        return athlete;
      });

      const rankedAthletes = calculateRankings(updatedAthletes);
      setAthletes(rankedAthletes);
      
      const next = recommendationsOn
        ? calculateNextLifter(rankedAthletes, session?.state)
        : null;
      setNextLifter(next);

      // IMMEDIATE save to backend (no delay to prevent data loss)
      try {
        const payload = {
          athlete_id: attemptData.athlete_id,
          session_id: sessionId,
          lift_type: attemptData.lift_type,
          attempt_number: attemptData.attempt_number,
          weight: attemptData.weight || attemptData.requested_weight,
          result: attemptData.result || 'pending',
          edit_count: attemptData.edit_count ?? 0,
        };

        console.log('📡 Sending to backend immediately:', payload);
        setSaving(true);

        let savedAttempt;
        if (attemptData.id) {
          // Update existing attempt
          const response = await api.put(`/attempts/${attemptData.id}`, payload);
          console.log('✅ Attempt updated:', response.data);
          savedAttempt = response.data?.data;
          setLastSaved(new Date());
          // toast.success('✓ Saved'); // Hidden to reduce notification noise
        } else {
          // Create new attempt
          const response = await api.post('/attempts', payload);
          console.log('✅ Attempt created:', response.data);
          savedAttempt = response.data?.data;
          setLastSaved(new Date());
          // toast.success('✓ Saved'); // Hidden to reduce notification noise
        }

        // Merge the server's response (critically: its real `id`) back into local
        // state. Without this, a newly-created attempt never gets an `id` locally,
        // so editing the same cell again would try to CREATE it a second time
        // instead of updating it - and fail with a duplicate-key error.
        if (savedAttempt?.id) {
          setAthletes(prev => prev.map(athlete => {
            if (athlete.id !== attemptData.athlete_id) return athlete;
            return {
              ...athlete,
              attempts: athlete.attempts?.map(a =>
                a.lift_type === attemptData.lift_type && a.attempt_number === attemptData.attempt_number
                  ? { ...a, ...savedAttempt }
                  : a
              ) || [],
            };
          }));
        }


        // Emit socket update to notify other users (but not ourselves)
        socketService.emit('sheet:update', {
          sessionId,
          athleteId: attemptData.athlete_id,
          liftType: attemptData.lift_type,
          attemptNumber: attemptData.attempt_number,
          source: 'self' // Mark as our own update
        });
        
      } catch (error) {
        console.error('❌ Error saving attempt:', error);
        console.error('Error response:', error.response?.data);
        console.error('Error status:', error.response?.status);
        console.error('Error message:', error.message);
        // The screen still shows the optimistic value, but it was NOT saved to
        // the database. Without this, a reload (or anyone else's screen) silently
        // reverts to the old value with no indication anything went wrong.
        toast.error('Failed to save attempt - ' + (error.response?.data?.message || error.message || 'please retry'), { duration: 6000 });
        // Rethrow so the caller (AttemptCell) knows the save actually failed and
        // doesn't go on to show its own misleading "Weight updated" success toast.
        // Marked so the outer catch below doesn't show a second, duplicate toast.
        error._alreadyShownToast = true;
        throw error;
      } finally {
        setSaving(false);
      }

      // Clear any pending timeout
      if (autoSaveTimeout) clearTimeout(autoSaveTimeout);

    } catch (error) {
      console.error('❌ Error updating attempt:', error);
      if (!error._alreadyShownToast) {
        toast.error('Failed to update attempt');
      }
      setSaving(false);
    }
  };

  // Determine an athlete's next pending attempt, so "Call to Platform" can be
  // triggered right from the sheet without going to the separate Venue Screen
  // page. Each athlete progresses through snatch -> clean & jerk independently
  // (not tied to the session's overall current_lift), so this checks whether
  // THIS athlete has already judged all 3 snatch attempts before deciding
  // which lift type to look at.
  const getNextAttemptForAthlete = (athlete) => {
    const attempts = athlete.attempts || [];
    const snatchJudged = attempts.filter(
      a => a.lift_type === 'snatch' && (a.result === 'good' || a.result === 'no-lift')
    ).length;
    const liftType = snatchJudged < 3 ? 'snatch' : 'clean_and_jerk';

    const liftAttempts = attempts.filter(a => a.lift_type === liftType);
    for (let num = 1; num <= 3; num++) {
      const existing = liftAttempts.find(a => a.attempt_number === num);
      if (!existing || existing.result === 'pending') {
        const weight = existing?.weight || existing?.requested_weight ||
          (liftType === 'snatch' ? athlete.opening_snatch : athlete.opening_clean_jerk);
        return { liftType, attemptNumber: num, weight };
      }
    }
    return null; // all 3 attempts for both lifts are already judged
  };

  const handleCallToPlatform = async (athlete) => {
    const next = getNextAttemptForAthlete(athlete);
    if (!next || !next.weight) {
      toast.error(`${athlete.name} has no declared weight for their next attempt`);
      return;
    }
    try {
      await api.post(`/sessions/${sessionId}/call-athlete`, {
        athleteId: athlete.id,
        liftType: next.liftType,
        attemptNumber: next.attemptNumber,
        weight: next.weight,
      });
      toast.success(`${athlete.name} called to platform`);
    } catch (error) {
      console.error('❌ Error calling athlete to platform:', error);
      toast.error('Failed to call athlete to platform');
    }
  };

  // Handle DQ toggle
  const handleDQToggle = async (athleteId, isDQ) => {
    try {
      console.log('🚫 Updating DQ status:', { athleteId, isDQ });
      
      // Optimistic update
      const updatedAthletes = athletes.map(a => 
        a.id === athleteId ? { ...a, is_dq: isDQ } : a
      );
      setAthletes(calculateRankings(updatedAthletes));
      
      // Save to backend
      const response = await api.put(`/athletes/${athleteId}`, { is_dq: isDQ });
      console.log('✅ DQ status updated:', response.data);
      
      // toast.success(isDQ ? 'Athlete disqualified' : 'DQ removed'); // Hidden to reduce notification noise
    } catch (error) {
      console.error('❌ Error updating DQ status:', error);
      console.error('Error details:', error.response?.data);
      toast.error(error.response?.data?.message || 'Failed to update DQ status');
      // DO NOT refresh - data is already optimistically updated, user should retry manually
    }
  };

  const handleAthleteMetaUpdate = async (athleteId, updates) => {
    // Optimistic local update
    setAthletes(prev => {
      const next = prev.map(a => a.id === athleteId ? { ...a, ...updates } : a);
      return next;
    });

    try {
      await api.put(`/athletes/${athleteId}`, updates);
      setLastSaved(new Date());
    } catch (error) {
      console.error('❌ Error updating athlete meta:', error);
      toast.error('Failed to update athlete');
      // Reload to avoid stale state
      fetchSessionData();
    }
  };

  // Effects
  useEffect(() => {
    if (sessionId) {
      fetchSessionData();
    }
  }, [sessionId]);

  // Auto-scale the table in fullscreen so it fits without scrolling
  useLayoutEffect(() => {
    if (!isFullscreen) {
      setTableScale(1);
      return undefined;
    }

    const measure = () => {
      const wrapper = tableWrapperRef.current;
      const table = tableRef.current;
      if (!wrapper || !table) return;

      const available = wrapper.clientHeight;
      const needed = table.scrollHeight;

      if (available > 0 && needed > 0) {
        const scale = Math.min(1, available / needed);
        setTableScale(scale);
      }
    };

    // Measure on next frame to ensure layout is ready
    const rafId = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', measure);
    };
  }, [isFullscreen, athletes]);

  const handleActivateDisplay = () => {
    try {
      if (socketService) {
        // Emit explicit switch event
        socketService.emit('display:switch', { sessionId: session.id });
        // toast.success('Display screen activated for this session'); // Hidden to reduce notification noise
      } else {
        toast.error('Socket service not available');
      }
    } catch (error) {
      console.error('Failed to activate display:', error);
      toast.error('Failed to activate display');
    }
  };

  const handleExport = async () => {
    try {
      const exportData = {
        session: {
          id: sessionId,
          name: session?.name,
          current_lift: session?.current_lift
        },
        athletes: athletes.map(a => ({
          name: a.name,
          team: getAthleteTeamCode(a),
          bodyweight: a.bodyweight,
          snatch: [1, 2, 3].map(num => {
            const attempt = a.attempts?.find(at => at.lift_type === 'snatch' && at.attempt_number === num);
            return {
              weight: attempt?.requested_weight || '-',
              result: attempt?.result || '-'
            };
          }),
          cleanJerk: [1, 2, 3].map(num => {
            const attempt = a.attempts?.find(at => at.lift_type === 'clean_and_jerk' && at.attempt_number === num);
            return {
              weight: attempt?.requested_weight || '-',
              result: attempt?.result || '-'
            };
          }),
          bestSnatch: a.bestSnatch || 0,
          bestCleanJerk: a.bestCleanJerk || 0,
          total: a.total || 0,
          rank: a.rank || '-',
          dq: a.is_dq
        })),
        timestamp: new Date().toISOString()
      };
      
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // toast.success('Session data exported successfully'); // Hidden to reduce notification noise
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export session data');
    }
  };

  const handleClearAttempts = async () => {
    if (!window.confirm('Are you sure you want to clear all attempts? This action cannot be undone.')) {
      return;
    }

    try {
      setSaving(true);
      
      // Clear attempts from backend
      await api.delete(`/sessions/${sessionId}/attempts/clear`);

      // Update local state - clear all attempts but keep athlete data
      const clearedAthletes = athletes.map(athlete => ({
        ...athlete,
        attempts: [],
        totals: { snatch: 0, clean_jerk: 0, total: 0 },
        bestSnatch: 0,
        bestCleanJerk: 0,
        total: 0,
        is_dq: false,
        rank: null
      }));

      setAthletes(clearedAthletes);
      setNextLifter(null);
      setPreviousLifter(null);
      setTimerRunning(false);
      setTimerKey(prev => prev + 1);
      
      // toast.success('All attempts cleared successfully'); // Hidden to reduce notification noise
    } catch (error) {
      console.error('Clear attempts error:', error);
      toast.error('Failed to clear attempts');
    } finally {
      setSaving(false);
    }
  };

  // Phase 2: Handle state changes from SessionCard and PhaseControlButtons
  const handleSessionStateChange = async (response) => {
    // Refresh session data after state change
    await fetchSessionData();
    // toast.success('Session state updated'); // Hidden to reduce notification noise
  };

  // Phase 2: Handle weigh-in modal close and refresh
  const handleWeighInComplete = async () => {
    setShowWeighInModal(false);
    await fetchSessionData();
    // toast.success('Weigh-in completed'); // Hidden to reduce notification noise
  };

  // Group athletes by weight class in ascending order
  const getAthletesGroupedByClass = () => {
    const grouped = {};
    athletes.filter(hasCompletedWeighIn).forEach(athlete => {
      const wc = athlete.weight_category;
      if (!grouped[wc]) {
        grouped[wc] = [];
      }
      grouped[wc].push(athlete);
    });
    
    // Sort weight classes numerically (ascending)
    const sortedClasses = Object.keys(grouped)
      .map(wc => ({ wc, num: parseInt(wc) }))
      .sort((a, b) => a.num - b.num)
      .map(item => item.wc);
    
    return { grouped, sortedClasses };
  };

  const sortAthletesForDisplay = (list) => {
    return list.slice().sort((a, b) => {
      const orderA = (a.start_number ?? a.lot_number ?? Number.MAX_SAFE_INTEGER);
      const orderB = (b.start_number ?? b.lot_number ?? Number.MAX_SAFE_INTEGER);
      if (orderA !== orderB) return orderA - orderB;
      return (a.name || '').localeCompare(b.name || '');
    });
  };

  // Broadcast-style dark header row for the readOnly scoreboard display,
  // vs. the Technical Panel's light editing-focused header.
  // Inline styles (not Tailwind classes) for the header colors specifically -
  // guarantees the background/text color actually renders regardless of any
  // CSS generation/specificity quirks, since inline style always wins.
  const theadRowClass = readOnly ? 'h-[52px]' : 'bg-gray-200 dark:bg-gray-800 h-[52px]';
  const theadRowStyle = readOnly ? { backgroundColor: '#1e1b4b' } : undefined;
  const thClass = readOnly
    ? 'p-3 text-center text-sm font-bold uppercase tracking-wide border'
    : 'p-3 text-center text-sm font-bold text-black dark:text-white border-2 border-gray-400 dark:border-gray-600';
  const thClassLeft = readOnly
    ? 'p-3 text-left text-sm font-bold uppercase tracking-wide border'
    : 'p-3 text-left text-sm font-bold text-black dark:text-white border-2 border-gray-400 dark:border-gray-600';
  const thSubClass = readOnly
    ? 'p-2 text-sm font-bold border'
    : 'p-2 text-sm font-bold text-black dark:text-white border-2 border-gray-400 dark:border-gray-600';
  const thStyle = readOnly ? { backgroundColor: '#1e1b4b', color: '#ffffff', borderColor: '#3730a3' } : undefined;
  const thSubStyle = readOnly ? { backgroundColor: '#312e81', color: '#ffffff', borderColor: '#3730a3' } : undefined;

  // Blank default screen — a plain white takeover with the logo centered,
  // for use between sessions when there's nothing live to show.
  if (readOnly && defaultScreenActive) {
    return (
      <div className="h-screen w-screen flex items-center justify-center overflow-hidden relative" style={{ backgroundColor: '#ffffff' }}>
        <img src="/lifting-social-logo.svg" alt="Lifting Social" className="w-48 h-48 sm:w-72 sm:h-72 object-contain" />

        <button
          onClick={onToggleFullscreen}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-black/5 hover:bg-black/10 text-slate-700 rounded-lg transition-colors text-sm font-medium opacity-0 hover:opacity-100 focus:opacity-100"
          title={browserFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {browserFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {browserFullscreen ? 'Exit' : 'Full Screen'}
        </button>
      </div>
    );
  }

  // While the interval timer is running, the Scoreboard screen is fully
  // replaced with a full-screen countdown instead of the attempt grid.
  if (readOnly && intervalTimer?.active && intervalTimeRemaining !== null) {
    const im = Math.floor(intervalTimeRemaining / 60);
    const is = intervalTimeRemaining % 60;
    const intervalUrgent = intervalTimeRemaining <= 10;
    return (
      <div
        className="h-screen w-screen flex flex-col items-center justify-center overflow-hidden relative"
        style={{ backgroundColor: '#000000' }}
      >
        <div className="absolute top-6 right-6 w-10 h-10 sm:w-12 sm:h-12 bg-white rounded-lg flex items-center justify-center p-1.5 shadow-lg">
          <img
            src="/lifting-social-logo.svg"
            alt="Lifting Social"
            className="w-full h-full object-contain"
          />
        </div>
        <div
          className="font-bold uppercase tracking-[0.3em]"
          style={{ color: 'rgba(255,255,255,0.6)', fontSize: '2.2vw', marginBottom: '2vh' }}
        >
          {intervalTimeRemaining === 0 ? "Time's Up" : 'Break Time'}
        </div>
        <div
          className={`font-black font-mono tabular-nums ${intervalUrgent && intervalTimeRemaining > 0 ? 'animate-pulse' : ''}`}
          style={{ color: intervalTimeRemaining === 0 || intervalUrgent ? '#dc2626' : '#ffffff', fontSize: '18vw', lineHeight: 1 }}
        >
          {String(im).padStart(2, '0')}:{String(is).padStart(2, '0')}
        </div>

        <button
          onClick={onToggleFullscreen}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors text-sm font-medium opacity-0 hover:opacity-100 focus:opacity-100"
          title={browserFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {browserFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {browserFullscreen ? 'Exit' : 'Full Screen'}
        </button>
      </div>
    );
  }

  return (
    <div className={`${isFullscreen ? 'h-screen w-screen overflow-hidden flex flex-col min-h-0' : 'min-h-screen'} ${readOnly && isFullscreen ? 'bg-slate-950' : 'bg-slate-100 dark:bg-zinc-900'} ${isFullscreen ? 'p-0' : 'p-2'}`}>
      {readOnly && (
        <style>{`
          /* Borderless broadcast-style grid: color and spacing separate cells
             instead of grid lines, matching the reference scoreboard design. */
          .scoreboard-display-table, .scoreboard-display-table th, .scoreboard-display-table td {
            border: none !important;
          }
          .scoreboard-display-table thead tr:first-child th {
            border-bottom: 2px solid #0a2730 !important;
          }
          .scoreboard-display-table thead tr:last-child th {
            border-bottom: 2px solid #0a2730 !important;
          }
          .scoreboard-display-table tbody tr {
            border-bottom: 1px solid #e2e8f0 !important;
          }
          .scoreboard-display-table td {
            padding-top: 0.5rem !important;
            padding-bottom: 0.5rem !important;
            height: 52px !important;
          }
        `}</style>
      )}
      {/* Header - Hidden in fullscreen */}
      {!isFullscreen && (
      <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg p-2 sm:p-3 md:p-4 mb-2 sm:mb-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4 w-full sm:w-auto">
            <button
              onClick={onBack}
              className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 md:px-4 py-1 sm:py-2 text-xs sm:text-sm bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 rounded-lg transition-colors whitespace-nowrap"
            >
              <ArrowLeft size={14} className="hidden sm:inline" />
              <ArrowLeft size={12} className="sm:hidden" />
              <span className="hidden xs:inline">Back</span>
            </button>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl md:text-2xl font-bold text-slate-800 dark:text-white truncate">
                {session?.name || 'Loading...'}
              </h1>
              <div className="text-xs sm:text-sm text-slate-600 dark:text-zinc-400 truncate">
                Technical Panel - Spreadsheet
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-end w-full sm:w-auto">
            {saving && (
              <span className="text-xs sm:text-sm text-blue-600 dark:text-blue-400 font-semibold hidden sm:inline">
                Saving...
              </span>
            )}
            {!saving && lastSaved && (
              <span className="hidden sm:inline-flex items-center gap-1 text-xs sm:text-sm text-green-600 dark:text-green-400 font-semibold">
                <Check size={12} className="sm:w-3.5 sm:h-3.5" />
                Saved
              </span>
            )}
            <button
              onClick={() => setRecommendationEnabled(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-full border transition-colors ${recommendationsOn
                ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700'
                : 'bg-slate-50 text-slate-900 border-slate-400 hover:bg-slate-100 dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-700'}`}
              title="Toggle next-lifter recommendation"
            >
              <span className="hidden sm:inline">Recommendation</span>
              <span className="sm:hidden">Reco</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${recommendationsOn ? 'bg-white/15 text-white border-white/30' : 'bg-white text-slate-800 border-slate-300 dark:bg-zinc-700 dark:text-zinc-100 dark:border-zinc-600'}`}>
                {recommendationsOn ? 'On' : 'Off'}
              </span>
            </button>
            <button
              onClick={onToggleFullscreen}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-3 lg:px-4 py-1 md:py-2 text-xs md:text-sm bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={12} className="md:w-4 md:h-4" /> : <Maximize2 size={12} className="md:w-4 md:h-4" />}
              <span className="hidden sm:inline text-xs md:text-sm">{isFullscreen ? 'Exit' : 'FS'}</span>
            </button>
            <button
              onClick={handleActivateDisplay}
              className="hidden md:flex items-center gap-1 md:gap-2 px-2 md:px-4 py-1 md:py-2 text-xs md:text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              title="Push this session to the main display screen"
            >
              <Monitor size={14} className="md:w-4 md:h-4" />
              <span className="hidden lg:inline">Display</span>
            </button>
            <button
              onClick={handleExport}
              className="hidden lg:flex items-center gap-1 md:gap-2 px-2 md:px-3 lg:px-4 py-1 md:py-2 text-xs md:text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
            >
              <Download size={12} className="lg:w-4 lg:h-4" />
              <span className="hidden xl:inline">Export</span>
            </button>
            <button
              onClick={handleClearAttempts}
              className="hidden xl:flex items-center gap-1 lg:gap-2 px-2 lg:px-3 xl:px-4 py-1 lg:py-2 text-xs lg:text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              title="Clear all attempts"
            >
              <Trash2 size={12} className="lg:w-4 lg:h-4" />
              <span className="hidden xl:inline">Clear</span>
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Fullscreen Header - Show only in fullscreen mode */}
      {isFullscreen && (
        <div
          className={
            readOnly
              ? 'shadow-lg py-3 px-4 sm:px-6 flex items-center justify-between gap-4 relative'
              : 'bg-white dark:bg-zinc-800 shadow-md p-2 sm:p-3 md:p-4 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-zinc-700 relative'
          }
          style={readOnly ? {
            background: 'linear-gradient(to bottom, #0c3b47, #082933)',
          } : undefined}
        >
          {readOnly && session?.competition?.logo_url ? (
            <div className="hidden md:flex items-center justify-center z-10 shrink-0 bg-white rounded-full shadow-md w-14 h-14 sm:w-16 sm:h-16 p-1.5">
              <img
                src={session.competition.logo_url}
                alt="Event Logo"
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : readOnly ? (
            <div className="hidden md:block w-14 sm:w-16 shrink-0" />
          ) : null}

          <div className={`flex flex-col gap-0.5 min-w-0 flex-1 z-10 ${readOnly ? 'items-center text-center' : ''}`}>
            {readOnly ? (
              <>
                <h2 className="text-xs sm:text-sm font-bold tracking-[0.15em] uppercase truncate" style={{ color: '#9fd8e3' }}>
                  {session?.competition?.name || 'Competition'}
                </h2>
                <h1 className="text-lg sm:text-xl lg:text-2xl font-black uppercase tracking-wide truncate" style={{ color: '#ffffff' }}>
                  Scoreboard - {session?.name || 'Session'}
                </h1>
              </>
            ) : (
              <>
                <h2 className="text-xs sm:text-sm text-slate-600 dark:text-zinc-400 truncate">
                  {session?.competition?.name || 'Competition'}
                </h2>
                <h1 className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-bold text-slate-900 dark:text-white truncate">
                  {session?.name || 'Session'}
                </h1>
              </>
            )}
          </div>

          <div className={
            readOnly
              ? 'hidden md:flex items-center justify-center z-10 shrink-0 bg-white rounded-full shadow-md w-16 h-16 sm:w-20 sm:h-20 p-2'
              : 'hidden md:flex items-center z-0 shrink-0 pointer-events-none'
          }>
            <img
              src="/lifting-social-logo.svg"
              alt="Lifting Social"
              className={readOnly ? 'max-w-full max-h-full object-contain' : 'h-14 sm:h-20'}
            />
          </div>

          {!readOnly && (callClockBadge || intervalTimerBadge || intervalTimerButton || defaultScreenButton) && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center gap-2">
              {callClockBadge}
              {intervalTimerBadge}
              {intervalTimerButton}
              {defaultScreenButton}
            </div>
          )}
          {!readOnly && (
            <button
              onClick={onToggleFullscreen}
              className="fixed bottom-3 sm:bottom-4 right-3 sm:right-4 z-50 flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg transition-colors text-xs sm:text-sm font-medium"
              title="Exit fullscreen"
            >
              <Minimize2 size={14} className="sm:w-4 sm:h-4" />
              <span className="hidden xs:inline">Exit</span>
            </button>
          )}
        </div>
      )}

      {/* Next Lifter Panel - Live Update with Timer - Optimized for fullscreen */}
      {recommendationsOn && nextLifter && (
        <div className={`bg-white dark:bg-zinc-800 rounded-lg shadow-sm border border-slate-200 dark:border-zinc-700 print:hidden ${isFullscreen ? 'mx-0 mt-2 mb-2 p-2 rounded-none' : 'mb-4'}`}>
          <div className="flex items-center justify-between p-2 relative">
            <div className="flex items-center gap-2.5 z-10">
              <span className="px-2.5 py-0.5 bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded-full text-xs font-medium">
               NEXT LIFTER
              </span>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-slate-800 dark:text-white">
                  {nextLifter.displayName}
                </span>
                <span className="text-slate-400 dark:text-zinc-500">•</span>
                <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs font-medium">
                  {nextLifter.liftType === 'snatch' ? 'Snatch' : 'Clean & Jerk'}
                </span>
                <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 rounded text-xs font-medium">
                  Attempt {nextLifter.attemptNumber}
                </span>
                <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded text-xs font-semibold">
                  {nextLifter.weight} kg
                </span>
              </div>
            </div>
            
            {/* Centered logo in normal panel - ONlY display if not in fullscreen mode to prevent duplicate logos */}
            {!isFullscreen && (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden md:block z-0 pointer-events-none">
                <img src="/lifting-social-logo.svg" alt="Lifting Social" className="h-14 sm:h-16" />
              </div>
            )}

            <div className="flex items-center gap-2.5 z-10 w-[200px] justify-end relative">
              <div className="h-5 w-px bg-slate-300 dark:bg-zinc-600 hidden sm:block"></div>
              {!isFullscreen && (
                <div className="flex items-center gap-3">
                  <div className="scale-90 origin-right">
                    <CompetitionTimer
                      key={timerKey}
                      duration={timerDuration}
                      isRunning={timerRunning}
                      onStart={() => setTimerRunning(true)}
                      onPause={() => setTimerRunning(false)}
                      onReset={() => {
                        setTimerRunning(false);
                        setTimerKey(prev => prev + 1);
                      }}
                      compact={true}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Spreadsheet Sheet - Optimized for fullscreen */}
      <div className={`${readOnly && isFullscreen ? 'bg-slate-950' : 'bg-white dark:bg-zinc-900'} ${isFullscreen ? 'rounded-none shadow-none p-1 sm:p-2 flex-1 overflow-hidden flex flex-col min-h-0 relative' : 'rounded-lg shadow-lg p-2 sm:p-3'}`}>
        {!isFullscreen && (
        <div className="flex items-center justify-between mb-2 sm:mb-3">
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-800 dark:text-white truncate">
              Competition Sheet
            </h2>
            {availableWeightClasses.length > 1 && (
              <p className="text-xs sm:text-sm text-slate-600 dark:text-zinc-400 mt-0.5 sm:mt-1 truncate">
                Weight Classes: {availableWeightClasses.map(wc => `${wc}kg`).join(' / ')}
              </p>
            )}
          </div>
        </div>
        )}

        {/* Fullscreen Toggle Button - Bottom Right (only in fullscreen) */}
        {isFullscreen && (
          readOnly ? (
            <button
              onClick={onToggleFullscreen}
              className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors text-sm font-medium opacity-0 hover:opacity-100 focus:opacity-100"
              title={browserFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {browserFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              {browserFullscreen ? 'Exit' : 'Full Screen'}
            </button>
          ) : (
            <button
              onClick={onToggleFullscreen}
              className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg transition-colors text-sm font-medium"
              title="Exit fullscreen"
            >
              <Minimize2 size={16} />
              Exit
            </button>
          )
        )}

        {/* Loading/Error States */}
        {loading && (
          <div className="text-center py-8">
            <div className="text-lg">Loading session data...</div>
          </div>
        )}

        {error && (
          <div className="text-center py-8 text-red-600 dark:text-red-400">
            <div className="text-lg font-semibold">Error Loading Session</div>
            <div className="text-sm mt-2">{error}</div>
          </div>
        )}

        {/* Spreadsheet Table */}
        {!loading && !error && (
          <>
          <div
            ref={tableWrapperRef}
            className={`${isFullscreen ? 'flex-1 min-h-0 overflow-hidden' : 'overflow-x-auto'}`}
          >
            <table
              ref={tableRef}
              className={`w-full border-collapse bg-white dark:bg-zinc-900 table-fixed border-2 border-gray-400 dark:border-gray-600 ${readOnly ? 'scoreboard-display-table' : ''}`}
              style={isFullscreen ? {
                transform: `scale(${tableScale})`,
                transformOrigin: 'top left',
                width: tableScale < 1 ? `${100 / tableScale}%` : '100%'
              } : undefined}
            >
              {readOnly ? (
                <colgroup>
                  <col style={{ width: '32%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '5%' }} />
                </colgroup>
              ) : (
                <colgroup>
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '160px' }} />
                  <col style={{ width: '100px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '60px' }} />
                </colgroup>
              )}
              <thead>
                {readOnly ? (
                  getAthletesGroupedByClass().sortedClasses.length <= 1 && (
                    <tr className={theadRowClass} style={theadRowStyle}>
                      <th className={thClassLeft} style={thStyle}></th>
                      <th className={thClass} style={thStyle}>1</th>
                      <th className={thClass} style={thStyle}>2</th>
                      <th className={thClass} style={thStyle}>3</th>
                      <th className={thClass} style={thStyle}>Best</th>
                      <th className={thClass} style={thStyle}>1</th>
                      <th className={thClass} style={thStyle}>2</th>
                      <th className={thClass} style={thStyle}>3</th>
                      <th className={thClass} style={thStyle}>Best</th>
                      <th className={thClass} style={thStyle}>TOTAL</th>
                      <th className={thClass} style={thStyle}>RANK</th>
                    </tr>
                  )
                ) : (
                  <>
                    <tr className={theadRowClass} style={theadRowStyle}>
                      <th rowSpan="2" className={thClass} style={thStyle}>Lot #</th>
                      <th rowSpan="2" className={thClass} style={thStyle}>Order</th>
                      <th rowSpan="2" className={thClassLeft} style={thStyle}>Name</th>
                      <th rowSpan="2" className={thClass} style={thStyle}>Team</th>
                      <th colSpan="4" className={thClass} style={thStyle}>
                        SNATCH
                      </th>
                      <th colSpan="4" className={thClass} style={thStyle}>
                        CLEAN & JERK
                      </th>
                      <th rowSpan="2" className={thClass} style={thStyle}>
                        TOTAL
                      </th>
                      <th rowSpan="2" className={thClass} style={thStyle}>
                        RANK
                      </th>
                      <th rowSpan="2" className={thClass} style={thStyle}>
                        DQ
                      </th>
                    </tr>
                    <tr className="bg-gray-200 dark:bg-gray-800 h-[40px]">
                      <th className={thSubClass} style={thSubStyle}>1</th>
                      <th className={thSubClass} style={thSubStyle}>2</th>
                      <th className={thSubClass} style={thSubStyle}>3</th>
                      <th className={thSubClass} style={thSubStyle}>Best</th>
                      <th className={thSubClass} style={thSubStyle}>1</th>
                      <th className={thSubClass} style={thSubStyle}>2</th>
                      <th className={thSubClass} style={thSubStyle}>3</th>
                      <th className={thSubClass} style={thSubStyle}>Best</th>
                    </tr>
                  </>
                )}
              </thead>
              <tbody>
                {(() => {
                  const { grouped, sortedClasses } = getAthletesGroupedByClass();
                  let globalIndex = 0;
                  
                  return sortedClasses.map(weightClass => (
                    <React.Fragment key={weightClass}>
                      {/* Weight Class Section Header - Only show for multiple classes */}
                      {sortedClasses.length > 1 && (
                        readOnly ? (
                          <tr className={theadRowClass} style={theadRowStyle}>
                            <th className="px-3 text-left text-sm font-black uppercase tracking-wide" style={thStyle}>
                              {weightClass}kg Weight Class
                            </th>
                            <th className={thClass} style={thStyle}>1</th>
                            <th className={thClass} style={thStyle}>2</th>
                            <th className={thClass} style={thStyle}>3</th>
                            <th className={thClass} style={thStyle}>Best</th>
                            <th className={thClass} style={thStyle}>1</th>
                            <th className={thClass} style={thStyle}>2</th>
                            <th className={thClass} style={thStyle}>3</th>
                            <th className={thClass} style={thStyle}>Best</th>
                            <th className={thClass} style={thStyle}>TOTAL</th>
                            <th className={thClass} style={thStyle}>RANK</th>
                          </tr>
                        ) : (
                          <tr className="h-11 bg-black bg-opacity-10 dark:bg-black dark:bg-opacity-20 border-2 border-gray-400 dark:border-gray-600">
                            <td colSpan="15" className="p-3 text-sm font-bold text-black dark:text-white border-2 border-gray-400 dark:border-gray-600">
                              {weightClass}kg Weight Class
                            </td>
                          </tr>
                        )
                      )}
                      
                      {/* Athletes in this weight class */}
                      {sortAthletesForDisplay(grouped[weightClass]).map((athlete, classIndex) => {
                        globalIndex++;
                        const isEvenRow = classIndex % 2 === 0;
                        return (
                          <tr 
                            key={athlete.id} 
                            className={`${isFullscreen ? 'h-auto' : 'h-[52px]'} bg-white dark:bg-zinc-900 hover:bg-gray-50 dark:hover:bg-zinc-800 border-b border-gray-300 dark:border-gray-700 overflow-hidden`}>
                            {readOnly ? (
                              <td className="p-0 relative">
                                <div className="h-full flex items-center justify-between gap-2 bg-slate-50 dark:bg-zinc-800 rounded-md px-3" style={{ margin: '4px' }}>
                                  <span className="truncate font-semibold text-black dark:text-white">
                                    <span className="text-slate-400 dark:text-zinc-500 font-normal mr-2">{athlete.lot_number ?? '-'}</span>
                                    {athlete.name}
                                  </span>
                                  <span className="shrink-0 text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase">
                                    ({getAthleteTeamCode(athlete)})
                                  </span>
                                </div>
                              </td>
                            ) : (
                              <>
                                <td className="p-1 text-sm text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600">
                                  <input
                                    type="number"
                                    className="w-full h-8 text-center bg-white dark:bg-zinc-800 border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    value={athlete.lot_number ?? ''}
                                    min="1"
                                    onChange={(e) => {
                                      const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
                                      handleAthleteMetaUpdate(athlete.id, { lot_number: val });
                                    }}
                                  />
                                </td>
                                <td className="p-1 text-sm text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600">
                                  <input
                                    type="number"
                                    className="w-full h-8 text-center bg-white dark:bg-zinc-800 border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    value={athlete.start_number ?? ''}
                                    min="1"
                                    onChange={(e) => {
                                      const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
                                      handleAthleteMetaUpdate(athlete.id, { start_number: val });
                                    }}
                                  />
                                </td>
                                <td className="p-2 text-sm font-semibold text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600 relative group">
                                  <span className="truncate block">{athlete.name}</span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCallToPlatform(athlete);
                                    }}
                                    className="hidden group-hover:flex absolute inset-y-0 right-1 my-auto h-6 items-center px-2 bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold uppercase tracking-wide rounded shadow-md transition-colors"
                                    title="Call this athlete to the platform"
                                  >
                                    Call
                                  </button>
                                </td>
                                <td className="p-2 text-sm text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600">
                                  {getAthleteTeamCode(athlete)}
                                </td>
                              </>
                            )}

                            {/* Snatch Attempts */}
                            {[1, 2, 3].map(attemptNum => (
                              <td key={`snatch-${attemptNum}`} className="border-2 border-r border-gray-400 dark:border-gray-600 p-0 relative h-[52px]">
                                <div className="w-full h-full relative flex items-center justify-center overflow-hidden">
                                  <AttemptCell
                                    athlete={athlete}
                                    attemptType="snatch"
                                    attemptNumber={attemptNum}
                                    onUpdate={handleAttemptUpdate}
                                    previousAttempts={athlete.attempts || []}
                                    forceEditMode={forceEditMode}
                                    isDQ={athlete.is_dq}
                                    nextLifter={recommendationsOn ? nextLifter : null}
                                    readOnly={readOnly}
                                  />
                                </div>
                              </td>
                            ))}

                            {/* Best Snatch */}
                            <td className="p-2 text-base font-bold text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800">
                              {athlete.bestSnatch > 0 ? athlete.bestSnatch : '-'}
                            </td>

                            {/* Clean & Jerk Attempts */}
                            {[1, 2, 3].map(attemptNum => (
                              <td key={`clean_and_jerk-${attemptNum}`} className="border-2 border-r border-gray-400 dark:border-gray-600 p-0 relative h-[52px]">
                                <div className="w-full h-full relative flex items-center justify-center overflow-hidden">
                                  <AttemptCell
                                    athlete={athlete}
                                    attemptType="clean_and_jerk"
                                    attemptNumber={attemptNum}
                                    onUpdate={handleAttemptUpdate}
                                    previousAttempts={athlete.attempts || []}
                                    forceEditMode={forceEditMode}
                                    isDQ={athlete.is_dq}
                                    nextLifter={recommendationsOn ? nextLifter : null}
                                    readOnly={readOnly}
                                  />
                                </div>
                              </td>
                            ))}

                            {/* Best C&J */}
                            <td className={`border-2 border-r border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 p-0 relative ${isFullscreen ? '' : 'h-[52px]'} `}>
                              <div className="w-full h-full relative flex items-center justify-center overflow-hidden">
                                <span className="text-base font-bold text-black dark:text-white">
                                  {athlete.bestCleanJerk > 0 ? athlete.bestCleanJerk : '-'}
                                </span>
                              </div>
                            </td>

                            {/* Total */}
                            <td className="p-2 text-base font-bold text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800">
                              {athlete.total > 0 ? athlete.total : '-'}
                            </td>

                            {/* Rank */}
                            <td className="p-2 text-base font-bold text-center text-black dark:text-white border-2 border-r border-gray-400 dark:border-gray-600">
                              {athlete.rank ? (
                                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full text-xs bg-gray-200 dark:bg-gray-700 text-black dark:text-white font-bold">
                                  {athlete.rank}
                                </span>
                              ) : '-'}
                            </td>

                            {/* DQ - Technical Panel only */}
                            {!readOnly && (
                              <td className={`border-2 border-gray-400 dark:border-gray-600 p-0 relative ${isFullscreen ? '' : 'h-[52px]'} `}>
                                <div className="w-full h-full relative flex items-center justify-center overflow-hidden">
                                  <input
                                    type="checkbox"
                                    checked={athlete.is_dq || false}
                                    onChange={(e) => {
                                      handleDQToggle(athlete.id, e.target.checked);
                                    }}
                                    className="w-5 h-5 cursor-pointer accent-gray-400"
                                  />
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ));
                })()}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
