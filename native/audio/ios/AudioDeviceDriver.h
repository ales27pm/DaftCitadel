#import <Foundation/Foundation.h>

#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

/** Owns iOS audio-device I/O while the C++ AudioEngineBridge remains device-agnostic. */
@interface DaftAudioDeviceDriver : NSObject

- (BOOL)startWithSampleRate:(double)sampleRate
            framesPerBuffer:(NSUInteger)framesPerBuffer
           engineGeneration:(uint64_t)engineGeneration
                      error:(NSError* _Nullable* _Nullable)error;
- (BOOL)isRunning;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
