import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('iOS audio bridge registration', () => {
  it('uses React Native legacy-module interop for exported bridge methods', () => {
    const header = readRepositoryFile('native/audio/ios/AudioEngineModule.h');
    const implementation = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
    const podfileProperties = JSON.parse(
      readRepositoryFile('ios/Podfile.properties.json'),
    ) as { newArchEnabled?: string };

    expect(podfileProperties.newArchEnabled).toBe('true');
    expect(header).toContain('@interface AudioEngineModule : NSObject <RCTBridgeModule>');
    expect(header).not.toMatch(/#import\s+<ReactCommon\/RCTTurboModule\.h>/);
    expect(header).not.toMatch(
      /@interface\s+AudioEngineModule[^{\n]*<[^>]*RCTTurboModule/,
    );
    expect(implementation).toContain('RCT_EXPORT_MODULE();');
    expect(implementation).not.toContain('getTurboModule:');
    expect(implementation).not.toContain('ObjCTurboModule');
  });
});
