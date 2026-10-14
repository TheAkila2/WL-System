import { useEffect, useState, useCallback, useMemo } from 'react';
import api from '../../services/api';
import { supabase } from '../../services/supabaseClient';
import useActiveSession from '../../hooks/useActiveSession';

const MEDAL_STYLE = {
  gold: 'bg-yellow-500 text-black',
  silver: 'bg-slate-300 text-black',
  bronze: 'bg-amber-700 text-white',
};

const POLL_INTERVAL_MS = 3000;

export default function ResultsView() {
  const { sessionId, loading: activeSessionLoading } = useActiveSession();
  const [rows, setRows] = useState([]);
  const [sessionMeta, setSessionMeta] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadResults = useCallback(async () => {
    if (!sessionId) {
      setRows([]);
      setSessionMeta(null);
      setLoading(activeSessionLoading);
      return;
    }
    try {
      const [sessionRes, leaderboardRes] = await Promise.all([
        api.get(`/sessions/${sessionId}`),
        api.get(`/technical/sessions/${sessionId}/leaderboard`),
      ]);
      setSessionMeta(sessionRes.data.data);
      setRows((leaderboardRes.data.data || []).filter((r) => !r.is_dq));
    } catch (err) {
      console.error('Failed to load results:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, activeSessionLoading]);

  // Initial load + safety-net poll
  useEffect(() => {
    loadResults();
    const interval = setInterval(loadResults, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadResults]);

  // Instant push via Supabase Realtime
  useEffect(() => {
    if (!sessionId) return;
    const channel = supabase
      .channel(`venue-results-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        () => loadResults()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'athletes', filter: `session_id=eq.${sessionId}` },
        () => loadResults()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, loadResults]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.rank == null && b.rank == null) return 0;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });
  }, [rows]);

  if (loading) {
    return <FullScreenMessage>Loading results…</FullScreenMessage>;
  }

  return (
    <div className="min-h-screen w-screen bg-black text-white p-12 flex flex-col gap-8">
      <div>
        <div className="text-sm uppercase tracking-widest text-white/40">Final Results</div>
        <h1 className="text-5xl font-extrabold">
          {sessionMeta?.name}{sessionMeta?.session_number ? ` · Group ${sessionMeta.session_number}` : ''}
        </h1>
      </div>

      <div className="flex-1 overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white/5 text-xs uppercase tracking-widest text-white/50">
              <th className="px-4 py-3 w-16">Rank</th>
              <th className="px-4 py-3">Athlete</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3 text-center">Snatch</th>
              <th className="px-4 py-3 text-center">Clean & Jerk</th>
              <th className="px-4 py-3 text-center">Total</th>
              <th className="px-4 py-3 text-center">Medal</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.athlete_id} className="border-t border-white/5">
                <td className="px-4 py-3 text-2xl font-black text-white/70">{row.rank || '-'}</td>
                <td className="px-4 py-3 text-xl font-semibold">{row.athlete_name}</td>
                <td className="px-4 py-3 text-white/50">{row.team_name || '-'}</td>
                <td className="px-4 py-3 text-center font-bold">{row.best_snatch || '-'}</td>
                <td className="px-4 py-3 text-center font-bold">{row.best_clean_and_jerk || '-'}</td>
                <td className="px-4 py-3 text-center text-xl font-black">{row.total || '-'}</td>
                <td className="px-4 py-3 text-center">
                  {row.medal ? (
                    <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${MEDAL_STYLE[row.medal]}`}>
                      {row.medal}
                    </span>
                  ) : (
                    <span className="text-white/20">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
