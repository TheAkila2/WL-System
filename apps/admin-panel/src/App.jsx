import { createBrowserRouter, RouterProvider, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import MobileBlocker from './components/MobileBlocker';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import Competitions from './pages/Competitions';
import Athletes from './pages/Athletes';
import Sessions from './pages/Sessions';
import TechnicalPanel from './pages/TechnicalPanel';
import VenueScreen from './pages/VenueScreen';
import IntroView from './pages/venue-display/IntroView';
import ScoreboardView from './pages/venue-display/ScoreboardView';
import ResultsView from './pages/venue-display/ResultsView';
import Teams from './pages/Teams';
import WeighIn from './pages/WeighIn';
import UserManagement from './pages/UserManagement';
import SystemSettings from './pages/SystemSettings';
import Registrations from './pages/Registrations';
import Layout from './components/Layout';

function LegacyVenueDisplayRedirect() {
  const { view } = useParams();
  const target = ['intro', 'scoreboard', 'results'].includes(view) ? view : 'scoreboard';
  return <Navigate to={`/venue-display/${target}`} replace />;
}

const router = createBrowserRouter(
  [
    {
      path: '/login',
      element: <LoginPage />,
    },
    {
      path: '/venue-display',
      element: <Navigate to="scoreboard" replace />,
    },
    {
      path: '/venue-display/intro',
      element: (
        <ProtectedRoute roles={['admin', 'technical']}>
          <IntroView />
        </ProtectedRoute>
      ),
    },
    {
      path: '/venue-display/scoreboard',
      element: (
        <ProtectedRoute roles={['admin', 'technical']}>
          <ScoreboardView />
        </ProtectedRoute>
      ),
    },
    {
      path: '/venue-display/results',
      element: (
        <ProtectedRoute roles={['admin', 'technical']}>
          <ResultsView />
        </ProtectedRoute>
      ),
    },
    {
      // Legacy URLs that still carry a sessionId — the active session is now
      // resolved server-side, so just drop the stale param and redirect.
      path: '/venue-display/:sessionId/:view',
      element: <LegacyVenueDisplayRedirect />,
    },
    {
      path: '/',
      element: (
        <ProtectedRoute roles={['admin', 'technical']}>
          <Layout />
        </ProtectedRoute>
      ),
      children: [
        {
          index: true,
          element: <Dashboard />,
        },
        {
          path: 'competitions',
          element: <Competitions />,
        },
        {
          path: 'athletes',
          element: <Athletes />,
        },
        {
          path: 'teams',
          element: <Teams />,
        },
        {
          path: 'weigh-in',
          element: <WeighIn />,
        },
        {
          path: 'registrations',
          element: <Registrations />,
        },
        {
          path: 'sessions',
          element: <Sessions />,
        },
        {
          path: 'technical',
          element: <TechnicalPanel />,
        },
        {
          path: 'venue-screen',
          element: <VenueScreen />,
        },
        {
          path: 'users',
          element: <UserManagement />,
        },
        {
          path: 'settings',
          element: <SystemSettings />,
        },
      ],
    },
  ],
  {
    future: {
      v7_startTransition: true,
      v7_relativeSplatPath: true,
    },
  }
);

function App() {
  return (
    <AuthProvider>
      <MobileBlocker>
        <RouterProvider router={router} />
        <Toaster 
          position="bottom-right" 
          toastOptions={{
            style: {
              fontSize: '14px',
              padding: '12px 16px',
            },
            success: {
              duration: 2500,
            },
            error: {
              duration: 3500,
            },
          }}
        />
      </MobileBlocker>
    </AuthProvider>
  );
}

export default App;
