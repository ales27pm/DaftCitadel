#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** Owns iOS audio-device I/O while the C++ AudioEngineBridge remains device-agnostic. */
@interface DaftAudioDeviceDriver : NSObject

- (BOOL)startWithSampleRate:(double)sampleRate
            framesPerBuffer:(NSUInteger)framesPerBuffer
                      error:(NSError* _Nullable* _Nullable)error;
- (BOOL)isRunning;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
