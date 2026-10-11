import { Edit2, Save, Trash2, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';
import ImageUpload from '../components/ImageUpload';

export default function Competitions() {
  const [competition, setCompetition] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    date: '',
    location: '',
    organizer: '',
    description: '',
    status: 'active',
    registration_open: false,
    preliminary_entry_open: false,
    final_entry_open: false,
    image_url: '',
    logo_url: '',
  });

  useEffect(() => {
    fetchCompetition();
  }, []);

  const fetchCompetition = async () => {
    try {
      setLoading(true);
      const response = await api.get('/competitions/current');
      const data = response.data?.data;
      
      if (data) {
        setCompetition(data);
        // Format date for the date input (YYYY-MM-DD)
        const formattedDate = data.date ? new Date(data.date).toISOString().split('T')[0] : '';
        setFormData({
          name: data.name || '',
          date: formattedDate,
          location: data.location || '',
          organizer: data.organizer || '',
          description: data.description || '',
          status: data.status || 'active',
          registration_open: data.registration_open || false,
          preliminary_entry_open: data.preliminary_entry_open || false,
          final_entry_open: data.final_entry_open || false,
          image_url: data.image_url || '',
          logo_url: data.logo_url || '',
        });
      } else {
        // No competition exists, enable editing mode to create one
        setEditing(true);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      console.error('Failed to fetch competition:', errorMsg);
      toast.error(`Failed to load competition: ${errorMsg}`);
      setEditing(true); // Allow creation if fetch fails
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // Validate required fields
      if (!formData.name || !formData.date || !formData.location) {
        toast.error('Please fill in all required fields');
        return;
      }

      const submitData = {
        name: formData.name,
        date: formData.date,
        location: formData.location,
        registration_open: formData.registration_open,
        preliminary_entry_open: formData.preliminary_entry_open,
        final_entry_open: formData.final_entry_open,
        organizer: formData.organizer,
        description: formData.description,
        status: formData.status,
        image_url: formData.image_url,
        logo_url: formData.logo_url,
      };

      console.log('📝 Form data:', JSON.parse(JSON.stringify(formData)));
      console.log('📤 Submitting competition data:', JSON.parse(JSON.stringify(submitData)));
      console.log('🔍 Date value:', formData.date, 'Type:', typeof formData.date, 'Length:', formData.date?.length);
      console.log('Has existing competition:', !!competition);

      if (competition) {
        // Update existing competition
        console.log('Sending PUT request to /competitions/current');
        try {
          const response = await api.put('/competitions/current', submitData);
          console.log('Update response:', response.data);
          toast.success('Competition updated successfully!');
        } catch (error) {
          console.log('❌ PUT ERROR RESPONSE:');
          console.log('Status:', error.response?.status);
          console.log('Error message (data.message):', error.response?.data?.message);
          console.log('Error message (data.error.message):', error.response?.data?.error?.message);
          console.log('Validation Errors:', error.response?.data?.errors);
          console.log('Full Response Data:');
          console.log(error.response?.data);
          console.log('Data sent:');
          console.log(submitData);
          throw error;
        }
      } else {
        // Initialize new competition
        try {
          await api.post('/competitions/initialize', submitData);
          toast.success('Competition created successfully!');
        } catch (error) {
          const errorMsg = error.response?.data?.message || error.message;
          
          // If competition already exists, fetch it and inform user
          if (error.response?.status === 409 || errorMsg.includes('already exists')) {
            toast.error('A competition already exists. Loading it now...');
            setTimeout(() => fetchCompetition(), 1500);
            return;
          }
          throw error;
        }
      }
      
      setEditing(false);
      await fetchCompetition();
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.response?.data?.message || error.message;
      const allErrors = error.response?.data?.errors;
      
      console.error('❌ FINAL ERROR:');
      console.error('Status:', error.response?.status);
      console.error('Message:', errorMsg);
      console.error('All Validation Errors:', allErrors);
      console.error('Full Error Object:', error.response?.data);
      
      // Check for database column error
      if (errorMsg?.includes('Could not find') && errorMsg?.includes('image_url')) {
        toast.error('Database setup required: image_url column is missing. Please contact administrator.');
      } else {
        toast.error(competition ? `Failed to update: ${errorMsg}` : `Failed to create: ${errorMsg}`);
      }
    }
  };

  const handleCancel = () => {
    if (competition) {
      // Reset to original data
      const formattedDate = competition.date ? new Date(competition.date).toISOString().split('T')[0] : '';
      setFormData({
        name: competition.name || '',
        date: formattedDate,
        location: competition.location || '',
        organizer: competition.organizer || '',
        description: competition.description || '',
        status: competition.status || 'active',
        registration_open: competition.registration_open || false,
        preliminary_entry_open: competition.preliminary_entry_open || false,
        final_entry_open: competition.final_entry_open || false,
        image_url: competition.image_url || '',
        logo_url: competition.logo_url || '',
      });
      setEditing(false);
    }
  };

  const handleDelete = async () => {
    if (!competition) return;
    
    const confirmDelete = window.confirm(
      'Are you sure you want to delete this competition? This will also delete all associated sessions, athletes, and attempts. This action cannot be undone.'
    );
    
    if (!confirmDelete) return;

    try {
      await api.delete(`/competitions/${competition.id}`);
      toast.success('Competition deleted successfully');
      setCompetition(null);
      setEditing(true);
      setFormData({
        name: '',
        date: '',
        location: '',
        organizer: '',
        description: '',
        status: 'active',
      });
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message;
      toast.error(`Failed to delete competition: ${errorMsg}`);
      console.error('Delete error:', error);
    }
  };

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-bold text-slate-900 dark:text-white mb-2">Competition Settings</h1>
          <p className="text-slate-600 dark:text-zinc-400 font-ui">Manage your competition information</p>
        </div>
        {!editing && competition && (
          <div className="flex gap-3">
            <button
              onClick={() => setEditing(true)}
              className="btn btn-primary"
            >
              Edit Competition
            </button>
            <button
              onClick={handleDelete}
              className="btn bg-red-600 hover:bg-red-700 text-white"
            >
              Delete Competition
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="card text-center py-12">
          <p className="text-slate-600 dark:text-zinc-400">Loading competition...</p>
        </div>
      ) : editing ? (
        /* Edit Form */
        <>
          {!competition && (
            <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                <span className="font-semibold">Note:</span> You can only have one active competition at a time. 
                {/* If a competition exists, you can edit it below or delete it to create a new one. */}
              </p>
            </div>
          )}
          <div className="card card-lg">
          <h2 className="text-2xl font-heading font-bold text-slate-900 dark:text-white mb-6">
            {competition ? 'Edit Competition' : 'Create Competition'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                  Competition Name *
                </label>
                <input
                  type="text"
                  placeholder="Competition Name"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                  Date *
                </label>
                <input
                  type="date"
                  required
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                  Location *
                </label>
                <input
                  type="text"
                  placeholder="Location"
                  required
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                  Organizer
                </label>
                <input
                  type="text"
                  placeholder="Organizer"
                  value={formData.organizer}
                  onChange={(e) => setFormData({ ...formData, organizer: e.target.value })}
                  className="input"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                Competition Details (Website Description)
              </label>
              <textarea
                placeholder="Description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input"
                rows={3}
              />
            </div>

            {/* Competition Image Upload */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                Competition Image
              </label>
              <div className="space-y-2">
                {formData.image_url && (
                  <div className="relative inline-block">
                    <img 
                      src={formData.image_url} 
                      alt="Competition" 
                      className="h-32 w-auto rounded-lg border border-slate-200 dark:border-zinc-700 object-cover"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        // Delete image from server if it has a Supabase URL
                        if (formData.image_url && formData.image_url.includes('supabase')) {
                          // Extract path from Supabase URL
                          // URL format: https://...supabase.co/storage/v1/object/public/competitions/images/...
                          // We need: images/filename
                          const urlParts = formData.image_url.split('/');
                          const pathIndex = urlParts.findIndex(part => part === 'competitions');
                          if (pathIndex !== -1) {
                            const path = urlParts.slice(pathIndex + 1).join('/');
                            api.delete('/uploads/competitions/delete-image', {
                              data: { path }
                            }).catch(err => console.warn('Could not delete from server:', err));
                          }
                        }
                        setFormData({ ...formData, image_url: '' });
                      }}
                      className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                      title="Remove image"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <ImageUpload
                  currentImageUrl={formData.image_url}
                  uploadEndpoint="/uploads/competitions/upload-image"
                  onUploadSuccess={(data) => {
                    setFormData({ ...formData, image_url: data.url });
                    toast.success('Image uploaded successfully');
                  }}
                  label="Upload Competition Image"
                  maxSizeMB={5}
                />
              </div>
            </div>

            {/* Event Logo Upload - shown alongside the platform logo on venue display screens */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                Event Logo
              </label>
              <p className="text-xs text-slate-500 dark:text-zinc-500 mb-2">
                Shown in the corner of the live scoreboard screen, alongside the platform logo.
              </p>
              <div className="space-y-2">
                {formData.logo_url && (
                  <div className="relative inline-block">
                    <img
                      src={formData.logo_url}
                      alt="Event Logo"
                      className="h-32 w-auto rounded-lg border border-slate-200 dark:border-zinc-700 object-contain bg-white p-2"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        if (formData.logo_url && formData.logo_url.includes('supabase')) {
                          const urlParts = formData.logo_url.split('/');
                          const pathIndex = urlParts.findIndex(part => part === 'competitions');
                          if (pathIndex !== -1) {
                            const path = urlParts.slice(pathIndex + 1).join('/');
                            api.delete('/uploads/competitions/delete-image', {
                              data: { path }
                            }).catch(err => console.warn('Could not delete from server:', err));
                          }
                        }
                        setFormData({ ...formData, logo_url: '' });
                      }}
                      className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                      title="Remove logo"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <ImageUpload
                  currentImageUrl={formData.logo_url}
                  uploadEndpoint="/uploads/competitions/upload-image"
                  onUploadSuccess={(data) => {
                    setFormData({ ...formData, logo_url: data.url });
                    toast.success('Logo uploaded successfully');
                  }}
                  label="Upload Event Logo"
                  maxSizeMB={5}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-2">
                Status
              </label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="input"
              >
                <option value="upcoming">Upcoming</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
              </select>
            </div>

            {/* Website Integration Settings */}
            <div className="pt-6 border-t border-slate-200 dark:border-zinc-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
                Website Integration (Lifting Social)
              </h3>
              
              {/* Registration Period */}
              <div className="space-y-4 mb-6">
                <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-zinc-800/50 rounded-lg">
                  <div>
                    <label className="text-sm font-medium text-slate-900 dark:text-white">
                      Enable Website Registration
                    </label>
                    <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
                      Allow users to register for this competition on the website
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.registration_open || false}
                      onChange={(e) => setFormData({ ...formData, registration_open: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-300 dark:bg-zinc-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
              </div>

              {/* Preliminary Entry Period */}
              <div className="space-y-4 mb-6">
                <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-zinc-800/50 rounded-lg">
                  <div>
                    <label className="text-sm font-medium text-slate-900 dark:text-white">
                      Preliminary Entry Period Open
                    </label>
                    <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
                      Allow registered users to submit preliminary entries (entry totals)
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.preliminary_entry_open || false}
                      onChange={(e) => setFormData({ ...formData, preliminary_entry_open: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-300 dark:bg-zinc-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-yellow-300 dark:peer-focus:ring-yellow-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-600"></div>
                  </label>
                </div>
              </div>

              {/* Final Entry Period */}
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-zinc-800/50 rounded-lg">
                  <div>
                    <label className="text-sm font-medium text-slate-900 dark:text-white">
                      Final Entry Period Open
                    </label>
                    <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
                      Allow users to submit final entries (openers, confirmed weight category)
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.final_entry_open || false}
                      onChange={(e) => setFormData({ ...formData, final_entry_open: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-300 dark:bg-zinc-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-green-300 dark:peer-focus:ring-green-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex gap-4 pt-6">
              <button type="submit" className="btn btn-primary flex-1">
                {competition ? 'Save Changes' : 'Create Competition'}
              </button>
              {competition && (
                <button 
                  type="button" 
                  onClick={handleCancel}
                  className="btn btn-secondary flex-1"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
          </div>
        </>
      ) : (
        /* Display View */
        <div className="card card-lg">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-3xl font-heading font-bold text-slate-900 dark:text-white">
                {competition.name}
              </h2>
              <span
                className={`badge text-xs mt-2 ${
                  competition.status === 'active'
                    ? 'badge-success'
                    : competition.status === 'upcoming'
                    ? 'badge-info'
                    : 'bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-300'
                }`}
              >
                {competition.status.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-slate-600 dark:text-zinc-400">
              <p className="text-sm font-medium text-slate-500 dark:text-zinc-500">Date</p>
              <p className="font-medium text-slate-900 dark:text-white">
                {new Date(competition.date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>

            <div className="text-slate-600 dark:text-zinc-400">
              <p className="text-sm font-medium text-slate-500 dark:text-zinc-500">Location</p>
              <p className="font-medium text-slate-900 dark:text-white">{competition.location}</p>
            </div>

            {competition.organizer && (
              <div className="pt-4 border-t border-slate-200 dark:border-zinc-700">
                <p className="text-sm font-medium text-slate-500 dark:text-zinc-500 mb-1">Organizer</p>
                <p className="font-medium text-slate-900 dark:text-white">{competition.organizer}</p>
              </div>
            )}

            {competition.description && (
              <div className="pt-4 border-t border-slate-200 dark:border-zinc-700">
                <p className="text-sm font-medium text-slate-500 dark:text-zinc-500 mb-1">Description</p>
                <p className="text-slate-600 dark:text-zinc-400">{competition.description}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
