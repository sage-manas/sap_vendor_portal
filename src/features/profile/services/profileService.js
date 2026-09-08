import { apiClient } from '../../../lib/api-client';

export const profileService = {
  async getProfile() {
    return apiClient.get('/vendors/profile');
  },

  async createProfile(data) {
    return apiClient.post('/vendors/profile', data);
  },

  async updateProfile(data) {
    return apiClient.put('/vendors/profile', data);
  },

  async submitRegistration(data) {
    return apiClient.post('/vendors/profile/submit', data);
  },

  async getSapReferenceData() {
    return apiClient.get('/vendors/sap-reference-data');
  }
};
