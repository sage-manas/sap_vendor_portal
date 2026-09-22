import { apiClient } from '../../../lib/api-client';

export const dashboardService = {
  async getPerformance() {
    return apiClient.get('/vendors/performance').catch(() => null);
  },

  async getDashboardSummary() {
    return apiClient.get('/dashboard/summary').catch(() => null);
  }
};
