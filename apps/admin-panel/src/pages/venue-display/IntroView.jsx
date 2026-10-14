import { useEffect, useState, useCallback, useRef } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import api from '../../services/api';
import { supabase } from '../../services/supabaseClient';
import useActiveSession from '../../hooks/useActiveSession';

const LIFT_LABEL = {
  snatch: 'Snatch',
  clean_and_jerk: 'Clean & Jerk',
};

const POLL_INTERVAL_MS = 3000;
const DEFAULT_ATTEMPT_SECONDS = 60;

export default function IntroView() {
  const { sessionId, loading: activeSessionLoading } = useActiveSession();
  const [call, setCall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [intervalTimer, setIntervalTimer] = useState(null); // { active, startedAt, durationSeconds, target }
  const [intervalTimeRemaining, setIntervalTimeRemaining] = useState(null);
  const [defaultScreenActive, setDefaultScreenActive] = useState(false);
  const [defaultScreenTarget, setDefaultScreenTarget] = useState('both');
  const [defaultScreenVariant, setDefaultScreenVariant] = useState('logo');
  const [athleteIntroActive, setAthleteIntroActive] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [competitionImageUrl, setCompetitionImageUrl] = useState(null);
  const lastCallAtRef = useRef(null);

  useEffect(() => {
    const handleChange = () => setBrowserFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  };

  const applySession = useCallback(async (session) => {
    setIntervalTimer({
      active: !!session?.interval_timer_active,
      startedAt: session?.interval_timer_started_at,
      durationSeconds: session?.interval_timer_duration_seconds || 600,
      target: session?.interval_timer_target || 'both',
    });
    setDefaultScreenActive(!!session?.default_screen_active);
    setDefaultScreenTarget(session?.default_screen_target || 'both');
    setDefaultScreenVariant(session?.default_screen_variant || 'logo');
    setAthleteIntroActive(!!session?.athlete_intro_active);
    setSessionName(session?.name || '');
    setCompetitionImageUrl(session?.competition?.image_url || null);

    if (!session?.current_call_athlete_id) {
      lastCallAtRef.current = null;
      setCall(null);
      return;
    }
    // Avoid redundant refetches if the call hasn't actually changed.
    if (lastCallAtRef.current === session.current_call_at) return;
    lastCallAtRef.current = session.current_call_at;

    try {
      const athleteRes = await api.get(`/athletes/${session.current_call_athlete_id}`);
      const athlete = athleteRes.data.data;
      setCall({
        session_id: session.id,
        session_name: session.name,
        athlete_id: athlete.id,
        athlete_name: athlete.name,
        team_name: athlete.team?.name || null,
        weight_category: athlete.weight_category,
        best_snatch: athlete.best_snatch,
        best_clean_and_jerk: athlete.best_clean_and_jerk,
        total: athlete.total,
        lift_type: session.current_call_lift_type,
        attempt_number: session.current_call_attempt_number,
        weight: session.current_call_weight,
        duration_seconds: session.current_call_duration_seconds,
        called_at: session.current_call_at,
      });
    } catch (err) {
      console.error('Failed to load called athlete:', err);
    }
  }, []);

  const fetchSession = useCallback(async () => {
    if (!sessionId) {
      lastCallAtRef.current = null;
      setCall(null);
      setLoading(activeSessionLoading);
      return;
    }
    try {
      const res = await api.get(`/sessions/${sessionId}`);
      const session = res.data.data;
      await applySession(session);
    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, activeSessionLoading, applySession]);

  // Reset immediately when the active session itself changes (not just its
  // call state), so a stale athlete from the previous session never lingers.
  useEffect(() => {
    lastCallAtRef.current = null;
    setCall(null);
  }, [sessionId]);

  // Initial load + safety-net poll
  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSession]);

  // Keep the called athlete's best-lift stats live even after the call —
  // applySession only re-fetches athlete details when current_call_at
  // changes, so without this a later correction to their totals (e.g. the
  // operator fixing an attempt after calling them) would never show up here.
  useEffect(() => {
    if (!call?.athlete_id) return;
    const channel = supabase
      .channel(`venue-intro-athlete-${call.athlete_id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'athletes', filter: `id=eq.${call.athlete_id}` },
        (payload) => {
          setCall((prev) =>
            prev && prev.athlete_id === payload.new.id
              ? {
                  ...prev,
                  best_snatch: payload.new.best_snatch,
                  best_clean_and_jerk: payload.new.best_clean_and_jerk,
                  total: payload.new.total,
                }
              : prev
          );
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [call?.athlete_id]);

  // Instant push via Supabase Realtime
  useEffect(() => {
    if (!sessionId) return;
    const channel = supabase
      .channel(`venue-intro-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => applySession(payload.new)
      )
      .subscribe();

    // Lets the Technical Panel's manual Refresh button force this screen to
    // re-fetch instantly too, without reloading the page (which would drop
    // it out of browser fullscreen). Shared channel name with SessionSheet.
    const refreshChannel = supabase
      .channel(`venue-refresh-${sessionId}`)
      .on('broadcast', { event: 'force-refresh' }, () => fetchSession())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(refreshChannel);
    };
  }, [sessionId, applySession, fetchSession]);

  // Clock countdown — derived purely from the call timestamp so it stays in
  // sync even if this tab reconnects or the realtime push is delayed.
  useEffect(() => {
    if (!call?.called_at) {
      setTimeRemaining(null);
      return;
    }
    const duration = call.duration_seconds || DEFAULT_ATTEMPT_SECONDS;
    const calledAtMs = new Date(call.called_at).getTime();

    const tick = () => {
      const elapsed = (Date.now() - calledAtMs) / 1000;
      setTimeRemaining(Math.max(0, Math.ceil(duration - elapsed)));
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [call?.called_at, call?.duration_seconds]);

  // Break timer countdown — same mechanism as the call clock above.
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

  const fullscreenButton = (
    <button
      onClick={handleToggleFullscreen}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors text-sm font-medium opacity-0 hover:opacity-100 focus:opacity-100"
      title={browserFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      {browserFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      {browserFullscreen ? 'Exit' : 'Full Screen'}
    </button>
  );

  if (loading) {
    return <FullScreenMessage>Loading…{fullscreenButton}</FullScreenMessage>;
  }

  if (defaultScreenActive && defaultScreenTarget !== 'scoreboard') {
    const showImage = defaultScreenVariant === 'image' && competitionImageUrl;
    return (
      <div
        className="h-screen w-screen flex items-center justify-center overflow-hidden relative"
        style={
          showImage
            ? { backgroundImage: `url(${competitionImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { backgroundColor: '#ffffff' }
        }
      >
        {showImage ? (
          <div className="absolute top-6 right-6 z-10 bg-white rounded-xl shadow-xl p-2.5">
            <img src="/lifting-social-logo.svg" alt="Lifting Social" className="w-12 h-12 sm:w-16 sm:h-16 object-contain" />
          </div>
        ) : (
          <img src="/lifting-social-logo.svg" alt="Lifting Social" className="w-24 h-24 sm:w-36 sm:h-36 object-contain" />
        )}
        <button
          onClick={handleToggleFullscreen}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-black/5 hover:bg-black/10 text-slate-700 rounded-lg transition-colors text-sm font-medium opacity-0 hover:opacity-100 focus:opacity-100"
          title={browserFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {browserFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {browserFullscreen ? 'Exit' : 'Full Screen'}
        </button>
      </div>
    );
  }

  if (athleteIntroActive) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center overflow-hidden relative" style={{ backgroundColor: '#000000' }}>
        <div className="font-black uppercase tracking-wide text-center" style={{ color: '#ffffff', fontSize: '5vw' }}>
          Athlete Introduction
        </div>
        <div className="font-semibold uppercase tracking-widest text-center" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '2vw', marginTop: '1.5vh' }}>
          {sessionName}
        </div>
        {fullscreenButton}
      </div>
    );
  }

  if (intervalTimer?.active && intervalTimer?.target !== 'scoreboard' && intervalTimeRemaining !== null) {
    const im = Math.floor(intervalTimeRemaining / 60);
    const is = intervalTimeRemaining % 60;
    const intervalUrgent = intervalTimeRemaining <= 10;
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center overflow-hidden relative" style={{ backgroundColor: '#000000' }}>
        <div className="absolute top-6 right-6 w-10 h-10 sm:w-12 sm:h-12 bg-white rounded-lg flex items-center justify-center p-1.5 shadow-lg">
          <img src="/lifting-social-logo.svg" alt="Lifting Social" className="w-full h-full object-contain" />
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
        {fullscreenButton}
      </div>
    );
  }

  if (!call) {
    return <FullScreenMessage>Waiting for next athlete…{fullscreenButton}</FullScreenMessage>;
  }

  const minutes = timeRemaining !== null ? Math.floor(timeRemaining / 60) : 0;
  const seconds = timeRemaining !== null ? timeRemaining % 60 : 0;
  const clockText = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const clockUrgent = timeRemaining !== null && timeRemaining <= 10;
  const hasPriorResult = call.best_snatch > 0 || call.best_clean_and_jerk > 0;

  return (
    <div
      className="h-screen w-screen flex flex-col items-center overflow-hidden px-[4vw] py-[4vh]"
      style={{ backgroundColor: '#000000' }}
    >
      {/* Weight class eyebrow */}
      <div className="flex items-center gap-6 shrink-0">
        <span className="h-px" style={{ width: '6vw', backgroundColor: 'rgba(255,255,255,0.4)' }} />
        <span
          className="font-bold uppercase tracking-[0.3em]"
          style={{ color: '#ffffff', fontSize: '2vw' }}
        >
          {call.weight_category}KG Class
        </span>
        <span className="h-px" style={{ width: '6vw', backgroundColor: 'rgba(255,255,255,0.4)' }} />
      </div>

      {/* Athlete identity */}
      <div className="flex-1 flex flex-col items-center justify-center text-center w-full min-h-0">
        {call.team_name && (
          <div
            className="font-semibold tracking-wide uppercase"
            style={{ color: 'rgba(255,255,255,0.6)', fontSize: '2.2vw', marginBottom: '1.5vh' }}
          >
            {call.team_name}
          </div>
        )}
        <h1
          className="leading-none font-extrabold tracking-tight w-full"
          style={{ color: '#ffffff', fontSize: '12vw' }}
        >
          {call.athlete_name}
        </h1>
      </div>

      {/* Attempt / Clock bar — broadcast lower-third style */}
      <div
        className="w-full rounded-2xl overflow-hidden flex shadow-2xl shrink-0"
        style={{ border: '1px solid rgba(255,255,255,0.1)' }}
      >
        <div className="flex-1 text-center" style={{ backgroundColor: 'rgba(255,255,255,0.06)', padding: '3vh 2vw' }}>
          <div
            className="uppercase tracking-widest"
            style={{ color: 'rgba(255,255,255,0.45)', fontSize: '1.1vw', marginBottom: '1vh' }}
          >
            Attempt {call.attempt_number} · {LIFT_LABEL[call.lift_type] || call.lift_type}
          </div>
          <div className="font-black tabular-nums" style={{ color: '#ffffff', fontSize: '7vw' }}>
            {call.weight}
            <span className="font-bold" style={{ color: 'rgba(255,255,255,0.45)', fontSize: '2.5vw', marginLeft: '0.5vw' }}>kg</span>
          </div>
        </div>

        {timeRemaining !== null && (
          <div
            className={`flex-1 text-center transition-colors ${clockUrgent && timeRemaining > 0 ? 'animate-pulse' : ''}`}
            style={{
              backgroundColor: timeRemaining === 0 || clockUrgent ? '#dc2626' : '#ffffff',
              padding: '3vh 2vw',
            }}
          >
            <div
              className="uppercase tracking-widest"
              style={{
                color: timeRemaining === 0 || clockUrgent ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.5)',
                fontSize: '1.1vw',
                marginBottom: '1vh',
              }}
            >
              Clock
            </div>
            <div
              className="font-black font-mono tabular-nums"
              style={{ color: timeRemaining === 0 || clockUrgent ? '#ffffff' : '#000000', fontSize: '7vw' }}
            >
              {timeRemaining === 0 ? 'TIME' : clockText}
            </div>
          </div>
        )}
      </div>

      {/* Season-to-date bests */}
      {hasPriorResult && (
        <div className="flex gap-16 shrink-0" style={{ marginTop: '2.5vh' }}>
          <StatBlock label="Best Snatch" value={call.best_snatch ? `${call.best_snatch} kg` : '—'} />
          <StatBlock label="Best Clean & Jerk" value={call.best_clean_and_jerk ? `${call.best_clean_and_jerk} kg` : '—'} />
          <StatBlock label="Total" value={call.total ? `${call.total} kg` : '—'} />
        </div>
      )}

      {fullscreenButton}
    </div>
  );
}

function StatBlock({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</div>
      <div className="text-3xl font-bold" style={{ color: '#ffffff' }}>{value}</div>
    </div>
  );
}

function FullScreenMessage({ children }) {
  return (
    <div className="min-h-screen w-screen bg-black text-white flex items-center justify-center">
      <div className="text-4xl font-bold text-white/30">{children}</div>
    </div>
  );
}
