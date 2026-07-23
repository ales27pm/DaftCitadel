#import "AudioDeviceDriver.h"

#import <AVFoundation/AVFoundation.h>
#import <os/log.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

#import "audio-engine/platform/ios/AudioEngineBridge.hpp"
#import "audio_engine/SceneGraph.h"

using daft::audio::SceneGraph;
using daft::audio::bridge::AudioEngineBridge;

namespace {
NSString* const DaftAudioDeviceErrorDomain = @"dev.daftcitadel.audio-device";

os_log_t DeviceLogger() {
  static os_log_t logger = os_log_create("dev.daftcitadel.app", "audio-device");
  return logger;
}

void AssignError(NSError** destination, NSInteger code, NSString* description,
                 NSDictionary<NSString*, id>* details = nil) {
  if (destination == nullptr) {
    return;
  }
  NSMutableDictionary<NSString*, id>* userInfo = [NSMutableDictionary dictionaryWithDictionary:details ?: @{}];
  userInfo[NSLocalizedDescriptionKey] = description;
  *destination = [NSError errorWithDomain:DaftAudioDeviceErrorDomain code:code userInfo:userInfo];
}

void LogException(NSString* phase, NSException* exception) {
  os_log_error(DeviceLogger(),
               "AVAudioEngine exception during %{public}@: %{public}@ - %{public}@",
               phase, exception.name, exception.reason ?: @"No exception reason supplied");
}

void CleanupEngine(AVAudioEngine* engine, AVAudioSourceNode* sourceNode, BOOL sourceAttached,
                   AVAudioSession* session) {
  if (engine != nil) {
    @try {
      [engine stop];
    } @catch (NSException* exception) {
      LogException(@"engine-stop", exception);
    }

    if (sourceNode != nil && sourceAttached) {
      @try {
        [engine disconnectNodeOutput:sourceNode];
      } @catch (NSException* exception) {
        LogException(@"source-disconnect", exception);
      }
      @try {
        [engine detachNode:sourceNode];
      } @catch (NSException* exception) {
        LogException(@"source-detach", exception);
      }
    }
  }

  if (session != nil) {
    @try {
      NSError* deactivationError = nil;
      if (![session setActive:NO
                   withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                         error:&deactivationError] &&
          deactivationError != nil) {
        os_log_error(DeviceLogger(), "Audio-session deactivation failed: %{public}@",
                     deactivationError.localizedDescription);
      }
    } @catch (NSException* exception) {
      LogException(@"audio-session-deactivation", exception);
    }
  }
}
}  // namespace

@interface DaftAudioDeviceDriver ()
@property(nonatomic, strong, nullable) AVAudioEngine* engine;
@property(nonatomic, strong, nullable) AVAudioSourceNode* sourceNode;
@end

@implementation DaftAudioDeviceDriver

- (BOOL)startWithSampleRate:(double)sampleRate
            framesPerBuffer:(NSUInteger)framesPerBuffer
           engineGeneration:(uint64_t)engineGeneration
                      error:(NSError**)error {
  NSString* phase = @"previous-route-stop";
  AVAudioSession* session = nil;
  AVAudioEngine* engine = nil;
  AVAudioSourceNode* sourceNode = nil;
  BOOL sourceAttached = NO;

  @try {
    [self stop];
    phase = @"audio-session-category";
    session = [AVAudioSession sharedInstance];
    NSError* configurationError = nil;
    if (![session setCategory:AVAudioSessionCategoryPlayback
                         mode:AVAudioSessionModeDefault
                      options:AVAudioSessionCategoryOptionMixWithOthers
                        error:&configurationError]) {
      if (error != nullptr) {
        *error = configurationError;
      }
      return NO;
    }

    phase = @"preferred-sample-rate";
    if (![session setPreferredSampleRate:sampleRate error:&configurationError]) {
      if (error != nullptr) {
        *error = configurationError;
      }
      return NO;
    }

    phase = @"preferred-buffer-duration";
    if (![session setPreferredIOBufferDuration:(double)framesPerBuffer / sampleRate
                                         error:&configurationError]) {
      if (error != nullptr) {
        *error = configurationError;
      }
      return NO;
    }

    phase = @"audio-session-activation";
    if (![session setActive:YES error:&configurationError]) {
      if (error != nullptr) {
        *error = configurationError;
      }
      return NO;
    }

    phase = @"route-format";
    engine = [[AVAudioEngine alloc] init];
    AVAudioFormat* routeFormat = [engine.outputNode outputFormatForBus:0];
    if (routeFormat == nil || !std::isfinite(routeFormat.sampleRate) || routeFormat.sampleRate <= 0.0 ||
        routeFormat.channelCount == 0) {
      AssignError(error, 1, @"The active audio route does not expose a valid output format", @{
        @"phase" : phase,
      });
      CleanupEngine(engine, nil, NO, session);
      return NO;
    }

    const AVAudioChannelCount sourceChannels =
        std::min<AVAudioChannelCount>(2, routeFormat.channelCount);
    AVAudioFormat* format =
        [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate channels:sourceChannels];
    if (format == nil) {
      AssignError(error, 2, @"Unable to create a linear PCM source format", @{
        @"phase" : phase,
      });
      CleanupEngine(engine, nil, NO, session);
      return NO;
    }

    os_log_info(DeviceLogger(),
                "Starting route requestedRate=%{public}.0f actualRate=%{public}.0f channels=%{public}u frames=%{public}lu",
                sampleRate, routeFormat.sampleRate, sourceChannels,
                static_cast<unsigned long>(framesPerBuffer));

    AVAudioSourceNodeRenderBlock renderBlock =
        ^OSStatus(BOOL* isSilence, const AudioTimeStamp*, AVAudioFrameCount frameCount,
                  AudioBufferList* outputData) {
          const auto channels =
              std::min<std::size_t>(sourceChannels, SceneGraph::maxSupportedChannels());
          if (outputData == nullptr || channels == 0) {
            if (isSilence != nullptr) {
              *isSilence = YES;
            }
            return noErr;
          }

          const auto frames = static_cast<std::size_t>(frameCount);
          const auto zeroOutput = [outputData]() {
            for (UInt32 index = 0; index < outputData->mNumberBuffers; ++index) {
              AudioBuffer& buffer = outputData->mBuffers[index];
              if (buffer.mData != nullptr && buffer.mDataByteSize > 0) {
                std::memset(buffer.mData, 0, buffer.mDataByteSize);
              }
            }
          };
          if (frames > SceneGraph::maxSupportedFramesPerBuffer()) {
            zeroOutput();
            if (isSilence != nullptr) {
              *isSilence = YES;
            }
            return noErr;
          }

          if (outputData->mNumberBuffers >= channels) {
            std::array<float*, SceneGraph::maxSupportedChannels()> channelPointers{};
            for (std::size_t channel = 0; channel < channels; ++channel) {
              channelPointers[channel] =
                  static_cast<float*>(outputData->mBuffers[channel].mData);
              if (channelPointers[channel] == nullptr) {
                zeroOutput();
                if (isSilence != nullptr) {
                  *isSilence = YES;
                }
                return noErr;
              }
            }
            AudioEngineBridge::render(engineGeneration, channelPointers.data(), channels, frames);
          } else if (outputData->mNumberBuffers == 1 &&
                     outputData->mBuffers[0].mData != nullptr) {
            auto* interleaved = static_cast<float*>(outputData->mBuffers[0].mData);
            using PlanarBuffer = std::array<
                std::array<float, SceneGraph::maxSupportedFramesPerBuffer()>,
                SceneGraph::maxSupportedChannels()>;
            thread_local PlanarBuffer planar{};
            std::array<float*, SceneGraph::maxSupportedChannels()> channelPointers{};
            for (std::size_t channel = 0; channel < channels; ++channel) {
              channelPointers[channel] = planar[channel].data();
            }
            AudioEngineBridge::render(engineGeneration, channelPointers.data(), channels, frames);
            for (std::size_t frame = 0; frame < frames; ++frame) {
              for (std::size_t channel = 0; channel < channels; ++channel) {
                interleaved[frame * channels + channel] = planar[channel][frame];
              }
            }
          } else {
            zeroOutput();
            if (isSilence != nullptr) {
              *isSilence = YES;
            }
            return noErr;
          }
          if (isSilence != nullptr) {
            *isSilence = NO;
          }
          return noErr;
        };

    phase = @"source-node-creation";
    sourceNode = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:renderBlock];
    phase = @"source-node-attachment";
    [engine attachNode:sourceNode];
    sourceAttached = YES;
    phase = @"source-node-connection";
    [engine connect:sourceNode to:engine.mainMixerNode format:format];
    phase = @"engine-prepare";
    [engine prepare];
    phase = @"engine-start";
    NSError* startError = nil;
    if (![engine startAndReturnError:&startError]) {
      if (error != nullptr) {
        *error = startError;
      }
      CleanupEngine(engine, sourceNode, sourceAttached, session);
      return NO;
    }

    self.engine = engine;
    self.sourceNode = sourceNode;
    os_log_info(DeviceLogger(), "AVAudioEngine device route started");
    return YES;
  } @catch (NSException* exception) {
    LogException(phase, exception);
    AssignError(error, 3,
                [NSString stringWithFormat:@"Audio device setup failed during %@: %@",
                                           phase, exception.reason ?: exception.name],
                @{
                  @"phase" : phase,
                  @"exceptionName" : exception.name,
                  @"exceptionReason" : exception.reason ?: @"",
                });
    CleanupEngine(engine, sourceNode, sourceAttached, session);
    return NO;
  }
}

- (BOOL)isRunning {
  AVAudioEngine* engine = self.engine;
  if (engine == nil) {
    return NO;
  }
  @try {
    return engine.isRunning;
  } @catch (NSException* exception) {
    LogException(@"engine-state", exception);
    return NO;
  }
}

- (void)stop {
  AVAudioEngine* engine = self.engine;
  AVAudioSourceNode* sourceNode = self.sourceNode;
  self.engine = nil;
  self.sourceNode = nil;
  if (engine == nil && sourceNode == nil) {
    return;
  }
  AVAudioSession* session = nil;
  @try {
    session = [AVAudioSession sharedInstance];
  } @catch (NSException* exception) {
    LogException(@"audio-session-access", exception);
  }
  CleanupEngine(engine, sourceNode, sourceNode != nil, session);
}

- (void)dealloc {
  [self stop];
}

@end
