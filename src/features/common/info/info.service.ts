import { Injectable } from '@nestjs/common';
import { default as packageJson } from '../../../../package.json';

@Injectable()
export class InfoService {
  getVersion(): { version: string } {
    return { version: packageJson.version };
  }
}
