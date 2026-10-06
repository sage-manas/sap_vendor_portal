const request = require('supertest');
const express = require('express');

const mockReport = jest.fn();
jest.mock('../observability/sentry', () => ({ report: (...a) => mockReport(...a) }));

const { errorHandler } = require('../middleware/errorHandler');
const ApiError = require('../utils/ApiError');

const app = express();
app.use((req, _res, next) => { req.requestId = 'req-42'; req.clientId = 'CLT-7'; next(); });
app.get('/boom', () => { throw new Error('unexpected'); });
app.get('/forbidden', () => { throw new ApiError(403, 'no'); });
app.get('/missing', () => { throw new ApiError(404, 'gone'); });
app.get('/bad-gateway', () => { throw new ApiError(502, 'sap down'); });
app.use(errorHandler);

describe('error handler reports to the error tracker', () => {
  beforeEach(() => mockReport.mockClear());

  it('reports an unexpected 500 with the request correlation ids', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(mockReport).toHaveBeenCalledTimes(1);
    const [error, context] = mockReport.mock.calls[0];
    expect(error.message).toBe('unexpected');
    expect(context).toMatchObject({ requestId: 'req-42', clientId: 'CLT-7', statusCode: 500 });
  });

  it('reports a deliberate 5xx ApiError too', async () => {
    await request(app).get('/bad-gateway');
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it.each(['/forbidden', '/missing'])('does not report a 4xx refusal (%s)', async (path) => {
    await request(app).get(path);
    expect(mockReport).not.toHaveBeenCalled();
  });

});
