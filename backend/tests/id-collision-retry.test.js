// backend/utils/createWithUniqueId.js retries a create when the id it
// generated collides with an existing row — see its header for why the
// business-reference ids it wraps (INV-, ASN-, PMT-…) need this.
const { createWithUniqueId } = require('../utils/createWithUniqueId');

const { Prisma } = require('@prisma/client');

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });

describe('createWithUniqueId', () => {
  it('returns the first attempt when there is no collision', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'ok' });
    const result = await createWithUniqueId({ genId: () => 'id-1', create });
    expect(result).toEqual({ id: 'ok' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('regenerates and retries on a unique-constraint violation', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ id: 'third-try' });
    const genId = jest.fn().mockReturnValueOnce('a').mockReturnValueOnce('b').mockReturnValueOnce('c');

    const result = await createWithUniqueId({ genId, create });

    expect(result).toEqual({ id: 'third-try' });
    expect(create).toHaveBeenNthCalledWith(1, 'a');
    expect(create).toHaveBeenNthCalledWith(2, 'b');
    expect(create).toHaveBeenNthCalledWith(3, 'c');
  });

  it('gives up and rethrows after exhausting its attempts', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolation());
    await expect(createWithUniqueId({ genId: () => 'x', create, attempts: 3 }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not retry a different kind of error', async () => {
    const boom = new Error('not a collision');
    const create = jest.fn().mockRejectedValue(boom);
    await expect(createWithUniqueId({ genId: () => 'x', create }))
      .rejects.toBe(boom);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
