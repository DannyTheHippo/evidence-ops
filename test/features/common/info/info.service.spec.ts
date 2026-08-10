import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import packageJson from '../../../../package.json';
import { InfoService } from '../../../../src/features/common/info/info.service';

describe('InfoService', () => {
  let service: InfoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InfoService],
    }).compile();

    service = module.get<InfoService>(InfoService);
  });

  describe('getVersion', () => {
    it('should return the version from package.json', () => {
      expect(service.getVersion()).toEqual({ version: packageJson.version });
    });
  });
});
