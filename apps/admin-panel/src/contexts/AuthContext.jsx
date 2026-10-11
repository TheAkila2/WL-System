import { createContext, useContext, useState, useEffect } from 'react';
import authService from '../services/auth';
import toast from 'react-hot-toast';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const checkAuth = async () => {
      try {
        if (authService.isAuthenticated()) {
          const currentUser = authService.getCurrentUser();
          setUser(currentUser);

          // Verify token is still valid
          try {
            await authService.getMe();
          } catch (error) {
            // Token invalid, clear auth
            authService.logout();
            setUser(null);
            if (import.meta.env.DEV) await autoLoginDev();
          }
        } else if (import.meta.env.DEV) {
          // Local dev only: skip the login screen entirely by signing in
          // automatically with the seeded test admin account. Production
          // builds (import.meta.env.DEV === false) never take this path.
          await autoLoginDev();
        }
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setLoading(false);
      }
    };

    const autoLoginDev = async () => {
      try {
        const response = await authService.login('admin@test.com', 'password123');
        setUser(response.data.user);
      } catch (error) {
        console.error('Dev auto-login failed:', error);
      }
    };

    checkAuth();
  }, []);

  const login = async (email, password) => {
    try {
      const response = await authService.login(email, password);
      setUser(response.data.user);
      toast.success(`Welcome back, ${response.data.user.name}!`);
      return response;
    } catch (error) {
      const message = error.response?.data?.message || 'Login failed';
      toast.error(message);
      throw error;
    }
  };

  const logout = () => {
    authService.logout();
    setUser(null);
    toast.success('Logged out successfully');
  };

  const value = {
    user,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
    hasRole: (...roles) => user && roles.includes(user.role),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
