import { apiClient } from '../../../lib/api-client';
import { pickProfileFields } from '../profileFields';

export const profileService = {
  async getProfile() {
    return apiClient.get('/vendors/profile');
  },

  async updateProfile(data) {
    return apiClient.put('/vendors/profile', pickProfileFields(data));
  },

  // Submitting is a state change, not a write of fields — the endpoint reads no
  // body, and the profile was saved by updateProfile just before.
  async submitRegistration() {
    return apiClient.post('/vendors/profile/submit', {});
  },

  async getSapReferenceData() {
    return apiClient.get('/vendors/sap-reference-data');
  }
};
