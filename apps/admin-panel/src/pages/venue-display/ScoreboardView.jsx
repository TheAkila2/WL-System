import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';
import SessionSheet from '../../components/technical/SessionSheet';

export default function ScoreboardView() {
  const { sessionId } = useParams();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    api
      .get(`/sessions/${sessionId}`)
      .then((res) => setSession(res.data.data))
      .catch((err) => console.error('Failed to load session:', err))
      .finally(() => setLoading(false));
  }, [sessionId]);

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

  if (loading) {
    return (
      <div className="min-h-screen w-screen bg-black text-white flex items-center justify-center">
        <div className="text-4xl font-bold text-white/30">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen w-screen bg-black text-white flex items-center justify-center">
        <div className="text-4xl font-bold text-white/30">Session not found</div>
      </div>
    );
  }

  return (
    <SessionSheet
      session={session}
      isFullscreen={true}
      onToggleFullscreen={handleToggleFullscreen}
      browserFullscreen={browserFullscreen}
      onBack={() => {}}
      readOnly={true}
    />
  );
}
