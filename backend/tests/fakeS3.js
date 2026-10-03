const http = require('http');

// A small S3-compatible server for tests: path-style PUT / GET / HEAD / DELETE
// of objects, held in memory. It records what the portal sent so a test can
// assert on it (encryption header, key shape), and it applies the
// `response-content-*` overrides a presigned URL carries, as S3 does.
//
// It checks that a request is *signed* (an Authorization header, or the
// X-Amz-Signature query of a presigned URL, and that a presigned URL has not
// expired) but does not verify the signature itself: that is the SDK's job and
// is exercised against a real MinIO in the PR, not re-implemented here.

const start = async ({ bucket = 'test-bucket' } = {}) => {
  const objects = new Map(); // key -> { body, headers }
  const requests = [];
  let failNextPut = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    const [, requestedBucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const presigned = url.searchParams.has('X-Amz-Signature');

    requests.push({ method: req.method, key, headers: req.headers, query: Object.fromEntries(url.searchParams), presigned });

    const refuse = (status, code) => {
      res.writeHead(status, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    };

    if (requestedBucket !== bucket) return refuse(404, 'NoSuchBucket');
    if (!presigned && !req.headers.authorization) return refuse(403, 'AccessDenied');

    if (presigned) {
      const issued = Date.parse(url.searchParams.get('X-Amz-Date').replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const lifetime = Number(url.searchParams.get('X-Amz-Expires')) * 1000;
      if (Date.now() > issued + lifetime) return refuse(403, 'AccessDenied');
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (failNextPut) {
          failNextPut = false;
          return refuse(500, 'InternalError');
        }
        objects.set(key, { body: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(200, { ETag: '"fake"' });
        res.end();
      });
      return undefined;
    }

    const object = objects.get(key);
    if (!object) return refuse(404, 'NoSuchKey');

    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }

    const headers = {
      'Content-Length': object.body.length,
      'Content-Type': url.searchParams.get('response-content-type') || object.headers['content-type'] || 'application/octet-stream',
      ETag: '"fake"',
    };
    const disposition = url.searchParams.get('response-content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;

    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : object.body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    bucket,
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    failNextPut: () => { failNextPut = true; },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { start };
