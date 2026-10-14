import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Monitor, Settings, ExternalLink } from 'lucide-react';
import api from '../services/api';
import toast from 'react-hot-toast';

export default function VenueScreen() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      const response = await api.get('/sessions');
      const data = response.data.data || [];
      setSessions(data);
      if (data.length > 0) {
        setSelectedSessionId(data[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      toast.error('Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  const handleLaunch = async (view) => {
    if (!selectedSessionId) {
      toast.error('Please select a session first');
      return;
    }
    try {
      // Mark this session as the one the display screens should follow —
      // screens resolve this dynamically, so they stay in sync even if the
      // Technical Panel switches sessions later.
      await api.post('/competitions/current/active-session', { sessionId: selectedSessionId });
    } catch (error) {
      console.error('Failed to activate session for display:', error);
      toast.error('Failed to activate session for display');
      return;
    }
    window.open(`/venue-display/${view}`, '_blank');
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-4xl font-heading font-bold text-slate-900 dark:text-white mb-2">
          Venue Screen
        </h1>
        <p className="text-slate-600 dark:text-zinc-400 font-ui">
          Launch the live display screens for projectors or LED screens.
        </p>
      </div>

      <div className="max-w-xl">
        <div className="card card-lg">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-600">
              <Monitor size={24} />
            </div>
            <h2 className="text-2xl font-heading font-bold text-slate-900 dark:text-white">
              Launch a Screen
            </h2>
          </div>

          <div className="mb-6">
            <label className="block text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 font-heading">
              Session
            </label>
            <select
              className="w-full form-input bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-700"
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              disabled={loading || sessions.length === 0}
            >
              <option value="">Select a session</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name} {s.status === 'in-progress' ? '(Live)' : ''}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-2 mb-6">
            <button
              type="button"
              onClick={() => handleLaunch('intro')}
              className="w-full btn btn-primary flex justify-center items-center gap-2 py-2.5"
              disabled={!selectedSessionId}
            >
              <ExternalLink size={18} />
              <span>Open Intro Screen</span>
            </button>
            <button
              type="button"
              onClick={() => handleLaunch('scoreboard')}
              className="w-full btn btn-primary flex justify-center items-center gap-2 py-2.5"
              disabled={!selectedSessionId}
            >
              <ExternalLink size={18} />
              <span>Open Scoreboard Screen</span>
            </button>
            <button
              type="button"
              onClick={() => handleLaunch('results')}
              className="w-full btn btn-primary flex justify-center items-center gap-2 py-2.5"
              disabled={!selectedSessionId}
            >
              <ExternalLink size={18} />
              <span>Open Results Screen</span>
            </button>
          </div>

          <Link
            to="/technical"
            className="w-full btn btn-secondary flex justify-center items-center gap-2 py-3 mb-4"
          >
            <Settings size={20} />
            <span>Open Technical Panel</span>
          </Link>

          <p className="text-xs text-center text-slate-500 dark:text-zinc-500 font-ui">
            Each screen opens on its own URL - open each on a different physical display.
            To call an athlete to the platform, hover over their name in the Technical Panel sheet.
          </p>
        </div>
      </div>
    </div>
  );
}
