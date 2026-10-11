import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import api from '../../services/api';
import { supabase } from '../../services/supabaseClient';

const LIFT_LABEL = {
  snatch: 'Snatch',
  clean_and_jerk: 'Clean & Jerk',
};

const POLL_INTERVAL_MS = 3000;
const DEFAULT_ATTEMPT_SECONDS = 60;

export default function IntroView() {
  const { sessionId } = useParams();
  const [call, setCall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
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
    if (!sessionId) return;
    try {
      const res = await api.get(`/sessions/${sessionId}`);
      const session = res.data.data;
      await applySession(session);
    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, applySession]);

  // Initial load + safety-net poll
  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSession]);

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

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, applySession]);

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
      style={{ background: 'radial-gradient(circle at 50% 30%, #0c3b47 0%, #061a1f 65%)' }}
    >
      {/* Weight class eyebrow */}
      <div className="flex items-center gap-6 shrink-0">
        <span className="h-px" style={{ width: '6vw', backgroundColor: 'rgba(45,212,191,0.5)' }} />
        <span
          className="font-bold uppercase tracking-[0.3em]"
          style={{ color: '#ffffff', fontSize: '2vw' }}
        >
          {call.weight_category}KG Class
        </span>
        <span className="h-px" style={{ width: '6vw', backgroundColor: 'rgba(45,212,191,0.5)' }} />
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
            style={{ backgroundColor: timeRemaining === 0 || clockUrgent ? '#dc2626' : '#0f766e', padding: '3vh 2vw' }}
          >
            <div
              className="uppercase tracking-widest"
              style={{ color: 'rgba(255,255,255,0.7)', fontSize: '1.1vw', marginBottom: '1vh' }}
            >
              Clock
            </div>
            <div className="font-black font-mono tabular-nums" style={{ color: '#ffffff', fontSize: '7vw' }}>
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
