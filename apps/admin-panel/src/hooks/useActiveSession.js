import { useEffect, useState, useCallback, useRef } from 'react';
import api from '../services/api';
import { supabase } from '../services/supabaseClient';

const POLL_INTERVAL_MS = 3000;

// Venue display screens (Scoreboard/Intro/Results) follow whichever session
// is marked "active" on the current competition, instead of a sessionId
// fixed in the URL at the time the screen was opened. This means switching
// sessions in the Technical Panel updates every already-open display screen
// automatically, without needing to re-open them with a new URL.
export default function useActiveSession() {
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const competitionIdRef = useRef(null);

  const fetchCompetition = useCallback(async () => {
    try {
      const res = await api.get('/competitions/current');
      const competition = res.data.data;
      competitionIdRef.current = competition?.id || null;
      setSessionId(competition?.active_session_id || null);
    } catch (err) {
      console.error('Failed to load current competition:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompetition();
    const interval = setInterval(fetchCompetition, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchCompetition]);

  useEffect(() => {
    const channel = supabase
      .channel('venue-active-session')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'competitions' },
        (payload) => {
          if (!competitionIdRef.current || payload.new?.id === competitionIdRef.current) {
            setSessionId(payload.new?.active_session_id || null);
          }
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  return { sessionId, loading };
}
