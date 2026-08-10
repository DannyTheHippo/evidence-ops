/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mocks are intentionally untyped in test helpers */

interface MockQueryChain {
  populate?: jest.Mock;
  select?: jest.Mock;
  lean?: jest.Mock;
  exec?: jest.Mock;
  sort?: jest.Mock;
  skip?: jest.Mock;
  limit?: jest.Mock;
  toObject?: jest.Mock;
}

export interface MockModel<T = unknown> {
  find: jest.Mock<MockQueryChain | Promise<T[]> | Promise<Partial<T>[]> | Promise<unknown[]>>;
  findOne: jest.Mock<
    MockQueryChain | Promise<T | null> | Promise<Partial<T> | null> | Promise<unknown>
  >;
  findById: jest.Mock<
    MockQueryChain | Promise<T | null> | Promise<Partial<T> | null> | Promise<unknown>
  >;
  findByIdAndUpdate: jest.Mock<Promise<T | null> | Promise<unknown>>;
  findByIdAndDelete: jest.Mock<Promise<T | null>>;
  findOneAndUpdate: jest.Mock<Promise<T | null>>;
  findOneAndDelete: jest.Mock<Promise<T | null>>;
  create: jest.Mock<Promise<T | T[]>>;
  updateOne: jest.Mock<Promise<unknown>>;
  updateMany: jest.Mock<Promise<unknown>>;
  deleteOne: jest.Mock<Promise<unknown>>;
  deleteMany: jest.Mock<Promise<unknown>>;
  insertMany: jest.Mock<Promise<T[]>>;
  countDocuments: jest.Mock<MockQueryChain | Promise<number>>;
  aggregate: jest.Mock<Promise<unknown[]>>;
  distinct: jest.Mock<Promise<unknown[]>>;
  exists: jest.Mock<Promise<unknown>>;
  populate: jest.Mock<MockQueryChain>;
  startSession: jest.Mock<Promise<unknown>>;
}

export const getMockModel = <T = unknown>(): MockModel<T> => {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    insertMany: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    distinct: jest.fn(),
    exists: jest.fn(),
    populate: jest.fn(),
    startSession: jest.fn(),
  };
};
